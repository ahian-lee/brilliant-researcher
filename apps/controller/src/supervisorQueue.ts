import type { DatabaseSync } from 'node:sqlite';
import {
  activeDispatch,
  allActiveDispatches,
  budgetBlockReason,
  cancelDispatch,
  completeWorkflow,
  countActiveDispatches,
  countInFlightDispatches,
  createDispatch,
  dispatchCount,
  dispatchableWorkflows,
  finishDispatch,
  findWorkflow,
  getDispatch,
  getWorkflow,
  escalatePersistentUnreachable,
  markDispatchFailed,
  markDispatchNeedsReconcile,
  markDispatchRunning,
  markDispatchSendStarted,
  pauseWorkflow,
  pendingEvents,
  readyReason,
  reconcileUnreviewedTerminals,
  requeueDispatch,
  setWaitingReason,
  trailingNoActionStreak,
} from '../../../packages/core/src/workflows.ts';
import type { QueueSettings } from '../../../packages/core/src/workflows.ts';
import type { SupervisorDispatch, WorkflowRun } from '../../../packages/core/src/types.ts';
import { projectPendingWakeChanges } from '../../../packages/core/src/projectViews.ts';
import type { DispatchPayload, DispatchReceipt, SupervisorHost } from '../../../packages/adapters/src/supervisorHost.ts';

/**
 * 事件队列与可靠派发。
 *
 * 队列的真相在 SQLite（change_log.wake + workflow_run.processed_seq），SSE 只刷页面。
 * 这里的计时器只做「有没有新情况值得处理」的判断和状态搬运；没有待处理变化时，
 * 一次宿主调用都不会发生，更不会有定时轮询调用模型。
 */

export interface QueueConfig extends QueueSettings {
  /** 队列检查器轮转间隔；它只搬运状态，本身不调用模型。 */
  pumpMs: number;
  maxConcurrentDispatches: number;
  leaseMs: number;
  /** 断线持续多久才升级给主管；核对期间由程序自己反复探测。 */
  escalateAfterMs: number;
  /** 连续几轮「回合结束却没留下决策或汇报」就明确受阻，不靠刷轮次永远循环。 */
  maxNoActionStreak: number;
}

export interface QueueAction {
  workflowId: string;
  dispatchId?: string;
  action: 'dispatched' | 'queued' | 'reconciled' | 'failed' | 'canceled' | 'waiting';
  reason: string;
}

export interface QueueReport {
  actions: QueueAction[];
  hostAvailable: boolean;
  hostDetail: string;
}

export interface QueueDeps {
  db: DatabaseSync;
  host: SupervisorHost;
  config: QueueConfig;
  /** 计时与合并窗口用可注入时钟，便于测试；生产用 Date.now。 */
  nowMs: () => number;
  announce: (kind: string, refId: string) => void;
}

export class SupervisorQueue {
  db: DatabaseSync;
  host: SupervisorHost;
  config: QueueConfig;
  nowMs: () => number;
  announce: (kind: string, refId: string) => void;
  private busy = false;

  constructor(deps: QueueDeps) {
    this.db = deps.db;
    this.host = deps.host;
    this.config = deps.config;
    this.nowMs = deps.nowMs;
    this.announce = deps.announce;
  }

  /** 进程重启后的核对：未评审终态、活动派发状态，随后照常推进队列。 */
  async recover(): Promise<QueueReport> {
    const unreviewed = reconcileUnreviewedTerminals(this.db);
    const pumped = await this.pump();
    if (unreviewed === 0) return pumped;
    return {
      actions: [{ workflowId: '', action: 'waiting', reason: `reconciled_${unreviewed}_unreviewed_terminal_runs` }, ...pumped.actions],
      hostAvailable: pumped.hostAvailable,
      hostDetail: pumped.hostDetail,
    };
  }

  /**
   * 一次队列推进。immediateWorkflowId 让「已授权工作流启动」的初始规划不等合并窗口。
   */
  async pump(options?: { immediateWorkflowId?: string }): Promise<QueueReport> {
    if (this.busy) return { actions: [], hostAvailable: true, hostDetail: 'pump_already_running' };
    this.busy = true;
    try {
      // 先核对在途回合，再决定要不要开新工作。
      escalatePersistentUnreachable(this.db, this.nowMs(), this.config.escalateAfterMs);
      const actions = await this.reconcileActive();
      // A completed turn with no explicit business ACK must not immediately
      // trigger another turn in the same pump.  Leave its wake at the cursor
      // and let the next scheduled/event-driven pump apply the no-action
      // streak policy; otherwise one completion notification can spin a loop.
      const noActionThisPump = new Set(
        actions
          .filter((action) => action.reason === 'no_action_recorded' || action.reason === 'supervisor_left_no_action')
          .map((action) => action.workflowId),
      );
      const availability = this.host.status();
      if (!availability.available) {
        for (const workflow of dispatchableWorkflows(this.db)) {
          const pending = pendingEvents(this.db, workflow);
          if (pending.length > 0 && !activeDispatch(this.db, workflow.id)) {
            setWaitingReason(this.db, workflow.id, `host_unavailable: ${availability.detail}`);
          }
        }
        return { actions, hostAvailable: false, hostDetail: availability.detail };
      }

      const now = this.nowMs();
      for (const workflow of dispatchableWorkflows(this.db)) {
        if (noActionThisPump.has(workflow.id)) continue;
        const pending = pendingEvents(this.db, workflow);
        // Initial planning is a durable workflow wake event, just like later results.
        if (pending.length === 0) {
          setWaitingReason(this.db, workflow.id, 'no_pending_change');
          continue;
        }
        const active = activeDispatch(this.db, workflow.id);
        if (active && active.status === 'queued') {
          // queued 只表示本地已登记，尚未占用宿主槽位。预算和并发检查
          // 仍然适用于重启恢复，避免多个 queued 在同一轮一起跨出边界。
          const queuedBlocked = budgetBlockReason(this.db, workflow, now, active.id);
          if (queuedBlocked) {
            setWaitingReason(this.db, workflow.id, queuedBlocked);
            actions.push({ workflowId: workflow.id, dispatchId: active.id, action: 'waiting', reason: queuedBlocked });
            continue;
          }
          if (countInFlightDispatches(this.db) >= this.config.maxConcurrentDispatches) {
            setWaitingReason(this.db, workflow.id, 'supervisor_concurrency_limit');
            actions.push({ workflowId: workflow.id, dispatchId: active.id, action: 'waiting', reason: 'supervisor_concurrency_limit' });
            continue;
          }
          // 上次落库后没来得及调用宿主（或宿主当时不可用）：接着发这一条，不新建范围。
          actions.push(await this.sendToHost(active));
          continue;
        }
        if (active) {
          setWaitingReason(this.db, workflow.id, `dispatch_${active.status}`);
          continue;
        }
        const blocked = budgetBlockReason(this.db, workflow, now);
        if (blocked) {
          setWaitingReason(this.db, workflow.id, blocked);
          actions.push({ workflowId: workflow.id, action: 'waiting', reason: blocked });
          continue;
        }
        // A report is not permission to discard other pending results. Human takeover uses pause.
        const toSeq = pending[pending.length - 1].seq;
        const settings: QueueSettings = {
          mergeMs: this.config.mergeMs,
          maxWaitMs: this.config.maxWaitMs,
          eagerOnAcceptableResult: this.config.eagerOnAcceptableResult,
          immediate: options?.immediateWorkflowId === workflow.id,
        };
        const ready = readyReason(this.db, workflow, pending, now, settings);
        if (!ready) {
          setWaitingReason(this.db, workflow.id, 'waiting_in_merge_window');
          actions.push({ workflowId: workflow.id, action: 'waiting', reason: 'merge_window' });
          continue;
        }
        if (countInFlightDispatches(this.db) >= this.config.maxConcurrentDispatches) {
          setWaitingReason(this.db, workflow.id, 'supervisor_concurrency_limit');
          actions.push({ workflowId: workflow.id, action: 'waiting', reason: 'supervisor_concurrency_limit' });
          continue;
        }
        let dispatch: SupervisorDispatch;
        try {
          dispatch = createDispatch(this.db, { workflowId: workflow.id, triggerReason: ready, toSeq });
        } catch (error) {
          // A second Controller can pass the read-side active check while the
          // first one commits the unique active-dispatch row.  Treat that
          // race as already queued; never attempt a second host call.
          if (activeDispatch(this.db, workflow.id)) {
            setWaitingReason(this.db, workflow.id, 'dispatch_claim_taken');
            actions.push({ workflowId: workflow.id, action: 'waiting', reason: 'dispatch_claim_taken' });
            continue;
          }
          throw error;
        }
        this.announce('dispatch', dispatch.id);
        actions.push(await this.sendToHost(dispatch));
      }
      return { actions, hostAvailable: true, hostDetail: this.host.id };
    } finally {
      this.busy = false;
    }
  }

  /** 派发记录已在库里，这里才调用宿主；宿主返回后写回 thread/turn/用量。 */
  private async sendToHost(dispatch: SupervisorDispatch): Promise<QueueAction> {
    const workflow = getWorkflow(this.db, dispatch.workflow_id);
    // The transition is durable before the network call.  If the process dies
    // after the host accepted the turn but before its receipt reaches us, a
    // restart sees needs_reconcile and reconciles the existing turn instead of
    // sending a duplicate.
    if (dispatch.status === 'queued') {
      try {
        dispatch = markDispatchSendStarted(this.db, dispatch.id, this.config.maxConcurrentDispatches);
      } catch (error) {
        // Another Controller may have claimed the queued row between the
        // snapshot and this send.  The CAS above is the only send ownership;
        // losing it must not call the host or turn into a duplicate request.
        const current = getWorkflow(this.db, dispatch.workflow_id);
        const currentDispatch = getDispatch(this.db, dispatch.id);
        if (currentDispatch.status === 'queued') {
          setWaitingReason(this.db, current.id, 'supervisor_concurrency_limit');
          return {
            workflowId: current.id,
            dispatchId: dispatch.id,
            action: 'waiting',
            reason: 'supervisor_concurrency_limit',
          };
        }
        return {
          workflowId: current.id,
          dispatchId: dispatch.id,
          action: 'waiting',
          reason: 'dispatch_claim_taken',
        };
      }
    }
    let receipt: DispatchReceipt;
    try {
      receipt = await this.host.startTurn(this.payloadFor(dispatch, workflow));
    } catch (error) {
      // 抛异常时无法证明回合是否起来：按需核对处理，不盲发第二轮。
      const message = error instanceof Error ? error.message : String(error);
      markDispatchNeedsReconcile(this.db, dispatch.id, `dispatch_error: ${message.slice(0, 200)}`);
      setWaitingReason(this.db, workflow.id, 'dispatch_needs_reconcile');
      return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'reconciled', reason: 'dispatch_error' };
    }

    if (receipt.kind === 'accepted') {
      markDispatchRunning(this.db, dispatch.id, {
        threadId: receipt.threadId,
        turnId: receipt.turnId,
        usage: receipt.usage,
        leaseMs: this.config.leaseMs,
        nowMs: this.nowMs(),
      });
      setWaitingReason(this.db, workflow.id, 'dispatch_running');
      this.announce('dispatch', dispatch.id);
      return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'dispatched', reason: dispatch.trigger_reason };
    }
    if (receipt.kind === 'lost_receipt') {
      markDispatchNeedsReconcile(this.db, dispatch.id, receipt.detail);
      setWaitingReason(this.db, workflow.id, 'dispatch_needs_reconcile');
      return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'reconciled', reason: receipt.detail };
    }
    requeueDispatch(this.db, dispatch.id, receipt.detail);
    setWaitingReason(this.db, workflow.id, `host_unavailable: ${receipt.detail}`);
    return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'queued', reason: receipt.detail };
  }

  /**
   * 对活动派发向宿主核对。租约过期只代表需要核对，不能证明原模型已停；
   * 核对不了就停在「需核对」，不发第二轮。
   */
  private async reconcileActive(): Promise<QueueAction[]> {
    const now = this.nowMs();
    const actions: QueueAction[] = [];
    for (const dispatch of allActiveDispatches(this.db)) {
      if (dispatch.status === 'queued') continue;
      const workflow = findWorkflow(this.db, dispatch.workflow_id);
      if (!workflow) continue;

      if (dispatch.status === 'running') {
        const leaseAt = dispatch.lease_expires_at ? Date.parse(dispatch.lease_expires_at) : Number.POSITIVE_INFINITY;
        // A lease is a safety net, not the completion signal.  Probe an
        // available host on every queue pass so a normal short turn can close
        // promptly; expiry only changes the durable state to needs_reconcile.
        if (leaseAt <= now) {
          markDispatchNeedsReconcile(this.db, dispatch.id, 'lease_expired_needs_reconcile');
          actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, action: 'reconciled', reason: 'lease_expired' });
        }
      }

      if (!this.host.status().available) {
        setWaitingReason(
          this.db,
          workflow.id,
          dispatch.status === 'running' && dispatch.lease_expires_at && Date.parse(dispatch.lease_expires_at) > now
            ? 'dispatch_running'
            : 'dispatch_needs_reconcile',
        );
        continue;
      }
      const outcome = await this.host.reconcile({
        dispatchId: dispatch.id,
        threadId: dispatch.thread_id,
        turnId: dispatch.turn_id,
      });
      if (outcome === 'running') {
        markDispatchRunning(this.db, dispatch.id, { leaseMs: this.config.leaseMs, nowMs: this.nowMs() });
        actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, action: 'reconciled', reason: 'host_reports_running' });
        continue;
      }
      if (outcome === 'not_started') {
        markDispatchFailed(this.db, dispatch.id, 'host_confirmed_not_started');
        actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, action: 'failed', reason: 'host_confirmed_not_started' });
        continue;
      }
      if (outcome === 'failed') {
        markDispatchFailed(this.db, dispatch.id, 'host_confirmed_failed');
        actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, action: 'failed', reason: 'host_confirmed_failed' });
        continue;
      }
      if (outcome === 'canceled') {
        cancelDispatch(this.db, dispatch.id, 'host_confirmed_canceled');
        actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, action: 'canceled', reason: 'host_confirmed_canceled' });
        continue;
      }
      if (outcome === 'completed') {
        actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, ...this.closeDispatch(dispatch) });
        continue;
      }
      setWaitingReason(this.db, workflow.id, 'dispatch_needs_reconcile');
      actions.push({ workflowId: workflow.id, dispatchId: dispatch.id, action: 'waiting', reason: 'host_cannot_confirm' });
    }
    return actions;
  }

  /**
   * 回合结束不等于研究完成：检查本轮是否真的留下决策或汇报，再决定能否推进游标。
   * 连续空转就把工作流置为受阻，而不是永远刷轮次。
   */
  private closeDispatch(dispatch: SupervisorDispatch): QueueAction {
    const workflow = getWorkflow(this.db, dispatch.workflow_id);
    const done = finishDispatch(this.db, dispatch.id);
    this.announce('dispatch', dispatch.id);
    if (!done.actionRecorded) {
      const streak = trailingNoActionStreak(this.db, workflow.id);
      if (streak >= this.config.maxNoActionStreak) {
        pauseWorkflow(this.db, workflow.id, 'supervisor_left_no_action');
        return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'waiting', reason: 'supervisor_left_no_action' };
      }
      setWaitingReason(this.db, workflow.id, 'supervisor_left_no_action');
      return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'waiting', reason: 'no_action_recorded' };
    }
    return { workflowId: workflow.id, dispatchId: dispatch.id, action: 'reconciled', reason: `cursor_${done.processedSeq}` };
  }

  /** 完成工作流：终态与它引发的待处理变化在同一事务里写入（core 负责）。 */
  complete(workflowId: string, reason: string, options?: { dispatchId?: string }): WorkflowRun {
    return completeWorkflow(this.db, workflowId, reason, options);
  }

  /**
   * 人工接管优先：取消范围只包含本工作流派发出去的那个回合，
   * 不触碰同主机其他项目，也不动 Pi 运行。
   */
  async cancelActiveDispatch(workflowId: string, reason: string): Promise<{ canceled: string[]; detail: string }> {
    const dispatch = activeDispatch(this.db, workflowId);
    if (!dispatch) return { canceled: [], detail: '该工作流没有活动派发' };
    // A queued row has never crossed the host boundary and can be canceled
    // locally.  Once a send may have started, only a confirmed host response
    // releases the active slot; an unavailable/unconfirmed response leaves
    // the row active for reconciliation.
    if (dispatch.status === 'queued') {
      cancelDispatch(this.db, dispatch.id, reason);
      this.announce('dispatch', dispatch.id);
      return { canceled: [dispatch.id], detail: 'queued_dispatch_canceled_before_send' };
    }
    let detail = '未连接宿主，取消尚未确认';
    if (dispatch.turn_id || dispatch.thread_id) {
      const res = await this.host.cancelTurn({
        dispatchId: dispatch.id,
        threadId: dispatch.thread_id,
        turnId: dispatch.turn_id,
      });
      detail = res.detail;
      if (!res.ok) return { canceled: [], detail };
    } else {
      return { canceled: [], detail };
    }
    cancelDispatch(this.db, dispatch.id, reason);
    this.announce('dispatch', dispatch.id);
    return { canceled: [dispatch.id], detail };
  }

  private payloadFor(dispatch: SupervisorDispatch, workflow: WorkflowRun): DispatchPayload {
    const events = projectPendingWakeChanges(this.db, workflow.project_id, dispatch.from_seq - 1, 200).filter(
      (change) => change.seq <= dispatch.to_seq,
    );
    return {
      dispatchId: dispatch.id,
      projectId: workflow.project_id,
      workflowId: workflow.id,
      goal: workflow.goal,
      completionCondition: workflow.completion_condition,
      stageRange: { from: workflow.start_stage, to: workflow.end_stage },
      workdir: workflow.workdir,
      authorizedResources: workflow.authorized_resources,
      triggerReason: dispatch.trigger_reason,
      cursor: { fromSeq: dispatch.from_seq, toSeq: dispatch.to_seq },
      events: events.map((e) => ({ seq: e.seq, kind: e.kind, ref_id: e.ref_id, summary: e.summary })),
      threadId: workflow.supervisor_thread_id,
      turnId: dispatch.turn_id,
    };
  }
}
