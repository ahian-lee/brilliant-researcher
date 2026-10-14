import { createWaitingHost, type SupervisorHost } from '../../../packages/adapters/src/supervisorHost.ts';
import { createCodexSupervisorHost, StdioCodexRpc } from '../../../packages/adapters/src/codexSupervisorHost.ts';

/** Only an explicit shared-host proxy opt-in may start a bridge process. */
export async function connectSupervisorHost(hostId: string): Promise<{ host: SupervisorHost; close: () => void }> {
  if (hostId === 'waiting-for-connection') return { host: createWaitingHost(), close() {} };
  if (hostId !== 'codex-shared-host') throw new Error(`Unsupported BRI_SUPERVISOR_HOST: ${hostId}`);
  const command = process.env.BRI_CODEX_PROXY_COMMAND;
  if (!command) throw new Error('BRI_CODEX_PROXY_COMMAND must name the verified Codex binary for the shared Desktop host');
  const rpc = new StdioCodexRpc({ command, args: ['app-server', 'proxy'] });
  try {
    await rpc.connect();
    return { host: createCodexSupervisorHost(rpc), close: () => rpc.close() };
  } catch {
    rpc.close();
    return { host: createWaitingHost('shared_host_proxy_unreachable: verify the shared Desktop host, then restart Controller; no fallback supervisor was created'), close() {} };
  }
}
