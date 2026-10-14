/**
 * 可插拔主管宿主。默认不启动模型，也不创建隐藏主管。
 * 当前 0.158 独立 stdio 的只读协议可用，但 Desktop 共享 proxy 未连接。
 * 最新实测见 docs/stage3a-probe-followup.md。
 */

export interface DispatchEvent {
  seq: number;
  kind: string;
  ref_id: string;
  summary: string;
}

/** 每轮只给项目/工作流 ID、阶段目标、变化游标、结果与错误索引，产物按需再读。 */
export interface DispatchPayload {
  dispatchId: string;
  projectId: string;
  workflowId: string;
  goal: string;
  completionCondition: string;
  stageRange: { from: string; to: string };
  workdir: string;
  authorizedResources: string;
  triggerReason: string;
  cursor: { fromSeq: number; toSeq: number };
  events: DispatchEvent[];
  threadId: string;
  turnId: string;
}

export type DispatchReceipt =
  | { kind: 'accepted'; threadId: string; turnId: string; usage?: string }
  /** 宿主可能已经受理，但回执没拿回来：只能标「需核对」，不能当失败重发。 */
  | { kind: 'lost_receipt'; detail: string }
  | { kind: 'unavailable'; detail: string };

export type ReconcileOutcome = 'running' | 'completed' | 'failed' | 'canceled' | 'not_started' | 'unknown';

export interface HostTurnRef {
  dispatchId: string;
  threadId: string;
  turnId: string;
}

export interface SupervisorHost {
  readonly id: string;
  /** 本地、无模型开销的可用性判定；不可用时上层根本不开派发。 */
  status(): { available: boolean; detail: string };
  startTurn(payload: DispatchPayload): Promise<DispatchReceipt>;
  /** 只核对已知线程/回合，不启动新回合。 */
  reconcile(ref: HostTurnRef): Promise<ReconcileOutcome>;
  /** 取消范围由调用方限定到本工作流派发出去的那个回合。 */
  cancelTurn(ref: HostTurnRef): Promise<{ ok: boolean; detail: string }>;
}

export const WAITING_FOR_CONNECTION_DETAIL =
  'host_unavailable: 3A 未确认到可连接的 Codex Desktop app-server 控制 socket，保持等待连接（不启动 Codex、不新建主管会话、不用轮询冒充事件驱动）';

/** 默认宿主：一切写操作都不落地，只把状态如实报回去。 */
export function createWaitingHost(detail = WAITING_FOR_CONNECTION_DETAIL): SupervisorHost {
  return {
    id: 'waiting-for-connection',
    status: () => ({ available: false, detail }),
    startTurn: async () => ({ kind: 'unavailable', detail }),
    reconcile: async () => 'unknown',
    cancelTurn: async () => ({ ok: false, detail: `未连接宿主，无法取消回合：${detail}` }),
  };
}
