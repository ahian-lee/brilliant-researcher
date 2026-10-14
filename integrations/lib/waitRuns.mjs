import { setTimeout as delay } from 'node:timers/promises';

const active = new Set(['queued', 'starting', 'running']);
const attention = new Set(['succeeded', 'failed', 'canceled', 'waiting_input', 'unknown']);

/** Read-only waiting; timeouts never change a run or imply failure. */
export async function waitRuns(args, read, signal, pollMs = 2000) {
  const deadline = Date.now() + (args.timeout_ms ?? 45000);
  let runs = [];
  while (true) {
    if (signal?.aborted) return { isError: false, payload: { reason: 'interrupted', runs } };
    if (runs.length && Date.now() >= deadline) return { isError: false, payload: { reason: 'timeout', project_id: args.project_id, runs } };
    const remaining = Math.max(1, deadline - Date.now());
    const responses = await Promise.all(args.run_ids.map(id => read(id, Math.min(remaining, 5000), signal)));
    if (signal?.aborted) return { isError: false, payload: { reason: 'interrupted', runs } };
    const error = responses.find(r => r.isError);
    if (error) return error;
    runs = responses.map((r, i) => ({ run_id: args.run_ids[i], status: r.payload.run?.status }));
    if (runs.some(r => !active.has(r.status) && !attention.has(r.status))) {
      return { isError: true, payload: { error: 'invalid_run_status', runs } };
    }
    if (runs.some(r => attention.has(r.status))) {
      return { isError: false, payload: { reason: 'attention', project_id: args.project_id, runs } };
    }
    if (Date.now() >= deadline) return { isError: false, payload: { reason: 'timeout', project_id: args.project_id, runs } };
    try { await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal }); }
    catch { return { isError: false, payload: { reason: 'interrupted', runs } }; }
  }
}
