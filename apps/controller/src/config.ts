import type { HostConfig, SampleTarget } from '../../../packages/adapters/src/piRunner.ts';
import type { QueueConfig } from './supervisorQueue.ts';

export interface Config {
  projectId: string;
  /** Optional JSON file that explicitly registers ARIS project roots. */
  arisProjectsFile: string;
  disableRemote: boolean;
  port: number;
  pollMs: number;
  sampleMs: number;
  dbPath: string;
  host: HostConfig & SampleTarget;
  defaultTools: string;
  defaultTimeoutMs: number;
  workflow: QueueConfig;
  /** 默认等待；显式配置后才连接已验证的共享宿主 proxy。 */
  supervisorHostId: string;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function flag(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v !== '0' && v !== 'false';
}

function numericEnv(key: string, fallback: number, min = 0): number {
  const value = Number(env(key, String(fallback)));
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${key} must be an integer >= ${min}`);
  return value;
}

export function loadConfig(root: string): Config {
  return {
    projectId: env('BRI_PROJECT', 'bri-main'),
    arisProjectsFile: env('BRI_ARIS_PROJECTS', ''),
    disableRemote: flag('BRI_DISABLE_REMOTE', true),
    port: Number(env('BRI_PORT', '8791')),
    pollMs: Number(env('BRI_POLL_MS', '15000')),
    sampleMs: Number(env('BRI_SAMPLE_MS', '30000')),
    dbPath: env('BRI_DB', `${root}/var/state.db`),
    host: {
      alias: env('BRI_SSH_ALIAS', 'configure-ssh-alias'),
      baseDir: env('BRI_REMOTE_BASE', '/home/user/bri-runs'),
      wrapper: env('BRI_PI_WRAPPER', '/path/to/pi-agent-rpc.mjs'),
      nodeBin: env('BRI_PI_NODE', '/path/to/node'),
    },
    // 只读任务默认工具集。注意 bash 本身可写，真正只读需限制 shell 写入能力。
    defaultTools: env('BRI_PI_TOOLS', 'read,grep,find,ls'),
    defaultTimeoutMs: Number(env('BRI_PI_TIMEOUT_MS', '1800000')),
    supervisorHostId: env('BRI_SUPERVISOR_HOST', 'waiting-for-connection'),
    workflow: {
      // 队列检查器只是搬运状态；这些计时器绝不调用模型。
      pumpMs: numericEnv('BRI_WF_PUMP_MS', 15000, 1),
      mergeMs: numericEnv('BRI_WF_MERGE_MS', 30000, 0),
      maxWaitMs: numericEnv('BRI_WF_MAX_WAIT_MS', 120000, 0),
      eagerOnAcceptableResult: flag('BRI_WF_EAGER_ON_RESULT', true),
      maxConcurrentDispatches: numericEnv('BRI_WF_MAX_CONCURRENT', 1, 1),
      leaseMs: numericEnv('BRI_WF_LEASE_MS', 900000, 1),
      escalateAfterMs: numericEnv('BRI_WF_ESCALATE_AFTER_MS', 300000, 1),
      maxNoActionStreak: numericEnv('BRI_WF_MAX_NO_ACTION_STREAK', 2, 1),
    },
  };
}
