import assert from 'node:assert/strict';
import { waitRuns } from '../integrations/lib/waitRuns.mjs';
const args = { project_id: 'p', run_ids: ['a'], timeout_ms: 1000 };
const state = status => ({ isError: false, payload: { run: { status } } });
let reads = 0;
const completed = await waitRuns(args, async () => state(++reads < 3 ? 'running' : 'succeeded'), undefined, 1);
assert.equal(completed.payload.reason, 'attention');
assert.equal(reads, 3);
for (const status of ['failed', 'canceled', 'waiting_input', 'unknown']) {
  const result = await waitRuns(args, async () => state(status));
  assert.equal(result.payload.reason, 'attention');
  assert.equal(result.payload.runs[0].status, status);
}
const timeout = await waitRuns({ ...args, timeout_ms: 10 }, async () => state('running'), undefined, 2);
assert.equal(timeout.payload.reason, 'timeout');
assert.equal(timeout.payload.runs[0].status, 'running');
const unavailable = await waitRuns(args, async () => ({ isError: true, payload: { error: 'offline' } }));
assert.equal(unavailable.isError, true);
const invalid = await waitRuns(args, async () => ({ isError: false, payload: {} }));
assert.equal(invalid.isError, true);
const abort = new AbortController();
const pending = waitRuns(args, async () => state('running'), abort.signal);
setTimeout(() => abort.abort(), 10);
assert.equal((await pending).payload.reason, 'interrupted');
const mixed = await waitRuns({ ...args, run_ids: ['a', 'b'] }, async id => state(id === 'a' ? 'running' : 'succeeded'));
assert.equal(mixed.payload.reason, 'attention');
assert.equal(mixed.payload.runs.length, 2);
console.log('waitRuns: transition, attention statuses, timeout, offline, invalid data, cancellation and concurrent runs passed');
