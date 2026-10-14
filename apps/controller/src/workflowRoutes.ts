import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ackDispatch,
  activeDispatch,
  acceptStep,
  createWorkflow,
  createStep,
  findWorkflow,
  getStep,
  markStepDelivered,
  pauseWorkflow,
  resumeWorkflow,
  setStepStatus,
  skipStep,
  startRevisionRound,
  stopWorkflow,
} from '../../../packages/core/src/workflows.ts';
import type { WorkflowRun } from '../../../packages/core/src/types.ts';
import type { QueueAction, QueueReport, SupervisorQueue } from './supervisorQueue.ts';
import {
  listProjectWorkflows,
  ProjectNotFoundError,
  requireProject,
  workflowDetailView,
} from '../../../packages/core/src/projectViews.ts';

/**
 * 工作流业务入口（3B）。这些 HTTP 路由是唯一暴露给主管的动作面，
 * 全部按项目作用域：未知项目 404，未知工作流 404，冲突 409，参数不对 400，
 * 绝不静默回退成「另一个项目也能做」。
 */

export interface WorkflowRouteDeps {
  db: DatabaseSync;
  queue: SupervisorQueue;
  defaultProjectId: string;
  hostAlias: string;
  /** Pi 侧取消由 Controller 注入：只有用户显式点名的本Project run 才会走到这里。 */
  cancelRun: (runId: string) => Promise<{ ok: boolean; detail: string }>;
  announce: (kind: string, refId: string) => void;
}

interface StartBody {
  projectId?: string;
  goal?: string;
  completionCondition?: string;
  startStage?: string;
  endStage?: string;
  supervisorThreadId?: string;
  workdir?: string;
  authorizedResources?: string;
  maxRevisions?: number;
  maxDispatches?: number;
  budgetMs?: number;
}

interface ControlBody {
  projectId?: string;
  reason?: string;
  runIds?: string[];
  dispatchId?: string;
}

interface AckBody {
  projectId?: string;
  outcome?: 'accepted' | 'revise' | 'continued' | 'blocked' | 'completed';
  summary?: string;
  evidenceRef?: string;
}

interface StepBody {
  projectId?: string;
  action?: 'create' | 'executing' | 'delivered' | 'revise' | 'accept' | 'skip';
  stepId?: string;
  stage?: string;
  title?: string;
  taskId?: string;
  deliverableRef?: string;
  decisionId?: string;
  reason?: string;
}

function wakeSummary(workflowId: string, report: QueueReport): Record<string, unknown> {
  const action: QueueAction | undefined = report.actions.find((a) => a.workflowId === workflowId);
  return {
    wokeSupervisor: action?.action === 'dispatched',
    dispatchId: action?.dispatchId ?? null,
    hostAvailable: report.hostAvailable,
    /** 没有唤醒时这里必须说清原因，而不是只返回一个 false。 */
    reason: action?.reason ?? (report.hostAvailable ? 'no_action_for_workflow' : report.hostDetail),
  };
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const { db, queue } = deps;

  /** 缺省用默认项目（与其余路由一致）；显式传入却不存在时报 404，不静默回退。 */
  function guardProject(raw: string | undefined, reply: FastifyReply): string | null {
    const projectId = raw && raw.length > 0 ? raw : deps.defaultProjectId;
    try {
      requireProject(db, projectId);
      return projectId;
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        reply.code(404).send({ error: error.code, projectId });
        return null;
      }
      throw error;
    }
  }

  /** 工作流必须存在且属于本项目，否则 404（不区分「不存在」与「在别人项目里」）。 */
  function guardWorkflow(rawProjectId: string | undefined, workflowId: string, reply: FastifyReply): string | null {
    const projectId = guardProject(rawProjectId, reply);
    if (!projectId) return null;
    const workflow = findWorkflow(db, workflowId);
    if (!workflow || workflow.project_id !== projectId) {
      reply.code(404).send({ error: 'workflow_not_found', workflowId, projectId });
      return null;
    }
    return projectId;
  }

  app.post<{ Body: StartBody }>('/api/workflows', async (req, reply) => {
    const body = req.body ?? {};
    const projectId = guardProject(body.projectId, reply);
    if (!projectId) return undefined;
    const goal = (body.goal ?? '').trim();
    if (!goal) return reply.code(400).send({ error: 'goal_required' });

    let workflow: WorkflowRun;
    try {
      workflow = createWorkflow(db, {
        projectId,
        goal,
        completionCondition: body.completionCondition,
        startStage: body.startStage,
        endStage: body.endStage,
        supervisorThreadId: body.supervisorThreadId,
        workdir: body.workdir ?? '',
        authorizedResources: body.authorizedResources ?? `host=${deps.hostAlias}`,
        maxRevisions: body.maxRevisions,
        maxDispatches: body.maxDispatches,
        budgetMs: body.budgetMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already has active workflow/.test(message)) {
        return reply.code(409).send({ error: 'active_workflow_exists', message });
      }
      return reply.code(400).send({ error: 'invalid_workflow', message });
    }
    deps.announce('workflow', workflow.id);
    // 已授权工作流启动 → 初始规划不等合并窗口，但仍然只在有变化时才调用宿主。
    const report = await queue.pump({ immediateWorkflowId: workflow.id });
    return reply.code(201).send({ workflow, wake: wakeSummary(workflow.id, report) });
  });

  app.get<{ Querystring: { projectId?: string } }>('/api/workflows', (req, reply) => {
    const projectId = guardProject(req.query.projectId, reply);
    if (!projectId) return undefined;
    return { projectId, workflows: listProjectWorkflows(db, projectId) };
  });

  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/workflows/:id', (req, reply) => {
    const projectId = guardWorkflow(req.query.projectId, req.params.id, reply);
    if (!projectId) return undefined;
    return { projectId, ...workflowDetailView(db, projectId, req.params.id) };
  });

  /**
   * 阶段步骤动作统一入口，和 bri_workflow_step 保持一一对应。步骤 ID
   * 也必须落在 URL 所指的工作流中，避免拿同项目另一条工作流的步骤串用。
   */
  app.post<{ Params: { id: string }; Body: StepBody }>('/api/workflows/:id/steps', (req, reply) => {
    const projectId = guardWorkflow(req.body?.projectId, req.params.id, reply);
    if (!projectId) return undefined;
    const body = req.body ?? {};
    const action = body.action;
    if (!action) return reply.code(400).send({ error: 'action_required' });
    if (!['create', 'executing', 'delivered', 'revise', 'accept', 'skip'].includes(action)) {
      return reply.code(400).send({ error: 'invalid_step_action', action });
    }
    if (action === 'create' && (!body.stage || !body.stage.trim())) {
      return reply.code(400).send({ error: 'stage_required' });
    }
    if (action !== 'create' && (!body.stepId || !body.stepId.trim())) {
      return reply.code(400).send({ error: 'step_id_required' });
    }
    if (action === 'delivered' && (!body.deliverableRef || !body.deliverableRef.trim())) {
      return reply.code(400).send({ error: 'deliverable_ref_required' });
    }
    if (action === 'accept' && (!body.decisionId || !body.decisionId.trim())) {
      return reply.code(400).send({ error: 'decision_id_required' });
    }
    if (action === 'skip' && (!body.reason || !body.reason.trim())) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    try {
      let step;
      if (action === 'create') {
        step = createStep(db, {
          workflowId: req.params.id,
          stage: body.stage!.trim(),
          title: body.title,
          taskId: body.taskId,
          deliverableRef: body.deliverableRef,
        });
      } else {
        const current = getStep(db, body.stepId!);
        if (current.workflow_id !== req.params.id) {
          return reply.code(404).send({ error: 'step_not_found', stepId: body.stepId });
        }
        if (action === 'executing') step = setStepStatus(db, body.stepId!, 'executing');
        else if (action === 'delivered') step = markStepDelivered(db, body.stepId!, body.deliverableRef!.trim());
        else if (action === 'revise') step = startRevisionRound(db, body.stepId!, body.taskId);
        else if (action === 'accept') step = acceptStep(db, body.stepId!, body.decisionId!);
        else step = skipStep(db, body.stepId!, body.reason!.trim());
      }
      deps.announce('workflow', req.params.id);
      return { ok: true, projectId, workflowId: req.params.id, action, step };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/step not found|task not found|decision not found/.test(message)) {
        return reply.code(404).send({ error: 'step_dependency_not_found', message });
      }
      return reply.code(409).send({ error: 'step_action_rejected', message });
    }
  });

  /**
   * A completion acknowledgement is explicitly bound to the dispatch in the
   * URL.  It is the durable proof used by finishDispatch; a generic report
   * from a different turn cannot advance this dispatch's cursor.
   */
  app.post<{ Params: { id: string; dispatchId: string }; Body: AckBody }>(
    '/api/workflows/:id/dispatches/:dispatchId/ack',
    (req, reply) => {
      const projectId = guardWorkflow(req.body?.projectId, req.params.id, reply);
      if (!projectId) return undefined;
      const summary = (req.body?.summary ?? '').trim();
      const outcome = req.body?.outcome;
      if (!summary || !outcome) return reply.code(400).send({ error: 'outcome_and_summary_required' });
      try {
        const dispatch = ackDispatch(db, {
          dispatchId: req.params.dispatchId,
          workflowId: req.params.id,
          projectId,
          outcome,
          summary,
          evidenceRef: req.body?.evidenceRef,
        });
        deps.announce('dispatch', dispatch.id);
        return { ok: true, projectId, workflowId: req.params.id, dispatchId: dispatch.id, outcome, summary, evidenceRef: req.body?.evidenceRef ?? '' };
      } catch (error) {
        return reply.code(409).send({ error: 'dispatch_not_current', message: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: ControlBody }>('/api/workflows/:id/finish', (req, reply) => {
    const projectId = guardWorkflow(req.body?.projectId, req.params.id, reply);
    if (!projectId) return undefined;
    const reason = (req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'reason_required' });
    const active = activeDispatch(db, req.params.id);
    if (active && req.body?.dispatchId !== active.id) {
      return reply.code(409).send({ error: 'dispatch_active', dispatchId: active.id, message: '需提供当前已回执的 dispatch_id 才能结束工作流' });
    }
    try {
      const workflow = queue.complete(req.params.id, reason, { dispatchId: req.body?.dispatchId });
      deps.announce('workflow', workflow.id);
      return { workflow, projectId };
    } catch (error) {
      return reply.code(409).send({ error: 'cannot_finish', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: ControlBody }>('/api/workflows/:id/pause', (req, reply) => {
    const projectId = guardWorkflow(req.query.projectId ?? req.body?.projectId, req.params.id, reply);
    if (!projectId) return undefined;
    try {
      const workflow = pauseWorkflow(db, req.params.id, req.body?.reason ?? 'paused_by_user');
      deps.announce('workflow', workflow.id);
      return { workflow, effect: '阻止新的自动派发；在途回合与 Pi 运行未被取消' };
    } catch (error) {
      return reply.code(409).send({ error: 'cannot_pause', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: ControlBody }>('/api/workflows/:id/resume', async (req, reply) => {
    const projectId = guardWorkflow(req.query.projectId ?? req.body?.projectId, req.params.id, reply);
    if (!projectId) return undefined;
    let workflow: WorkflowRun;
    try {
      workflow = resumeWorkflow(db, req.params.id);
    } catch (error) {
      return reply.code(409).send({ error: 'cannot_resume', message: error instanceof Error ? error.message : String(error) });
    }
    deps.announce('workflow', workflow.id);
    const report = await queue.pump({ immediateWorkflowId: workflow.id });
    return { workflow, wake: wakeSummary(workflow.id, report) };
  });

  /**
   * stop 的取消范围写死在这里：只取消本工作流派发的一个主管回合；
   * Pi 运行除非用户在本请求里逐条点名且确属本项目，否则一律不动。
   */
  app.post<{ Params: { id: string }; Body: ControlBody }>('/api/workflows/:id/stop', async (req, reply) => {
    const projectId = guardWorkflow(req.query.projectId ?? req.body?.projectId, req.params.id, reply);
    if (!projectId) return undefined;
    const reason = (req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'reason_required' });

    // 先校验取消清单，避免校验失败时留下已经取消一半的状态。
    const runIds = req.body?.runIds ?? [];
    for (const runId of runIds) {
      const scoped = db
        .prepare('SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=? AND t.project_id=?')
        .get(runId, projectId) as { id: string } | undefined;
      if (!scoped) {
        return reply.code(403).send({
          error: 'run_out_of_scope',
          runId,
          message: `run ${runId} 不属于项目 ${projectId}，拒绝跨项目取消`,
        });
      }
    }

    const dispatchCancel = await queue.cancelActiveDispatch(req.params.id, `stopped: ${reason}`);
    const runResults: Array<{ runId: string; ok: boolean; detail: string }> = [];
    for (const runId of runIds) {
      runResults.push({ runId, ...(await deps.cancelRun(runId)) });
    }
    let workflow: WorkflowRun;
    try {
      workflow = stopWorkflow(db, req.params.id, reason);
    } catch (error) {
      return reply.code(409).send({ error: 'cannot_stop', message: error instanceof Error ? error.message : String(error) });
    }
    deps.announce('workflow', workflow.id);
    return {
      workflow,
      cancel_scope: {
        supervisor_dispatches: dispatchCancel.canceled,
        supervisor_dispatch_detail: dispatchCancel.detail,
        pi_runs: runResults,
        untouched: `仅本项目 ${projectId}；同主机其他项目与未点名的 Pi 运行未受影响`,
      },
    };
  });
}

export { ProjectNotFoundError };
