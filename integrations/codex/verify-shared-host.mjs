// Read-only scheme A probe. Never starts an app-server, thread, or model turn.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const command = process.argv[2];
if (!command) {
  console.error('Usage: node verify-shared-host.mjs <codex executable> [existing thread ID]');
  process.exit(2);
}
const target = process.argv[3] || process.env.CODEX_THREAD_ID;
const child = spawn(command, ['app-server', 'proxy'], {
  stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
});
const pending = new Map();
let nextId = 0;
let stopped = false;
function fail() {
  stopped = true;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('shared_proxy_unreachable'));
  }
  pending.clear();
}
child.on('error', fail);
child.on('exit', fail);
child.stdin.on('error', fail);
child.stderr.on('data', () => {}); // Do not expose arbitrary diagnostics or credentials.
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method) return; // No model actions or approval handling in this probe.
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error('read_only_rpc_failed'));
  else waiter.resolve(message.result);
});
function request(method, params) {
  if (stopped) return Promise.reject(new Error('shared_proxy_unreachable'));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('shared_proxy_timeout'));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const result = { connected: false, targetProvided: Boolean(target), targetLoaded: false,
  targetReadable: false, modelTurnsStarted: 0 };
try {
  await request('initialize', { clientInfo: { name: 'bri-shared-host-probe', version: '1' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  result.connected = true;
  const loaded = await request('thread/loaded/list', {});
  result.loadedCount = loaded.data?.length ?? 0;
  result.targetLoaded = Boolean(target && loaded.data?.includes(target));
  if (target) {
    const read = await request('thread/read', { threadId: target, includeTurns: false });
    result.targetReadable = read.thread?.id === target;
  }
  result.reason = result.targetLoaded && result.targetReadable
    ? 'bound_thread_loaded_and_readable_verify_desktop_ownership_before_enabling'
    : 'connection_alone_does_not_verify_desktop_thread_binding';
} catch (error) {
  result.reason = error.message;
  process.exitCode = 1;
} finally {
  fail();
  child.kill();
  console.log(JSON.stringify(result, null, 2));
}
