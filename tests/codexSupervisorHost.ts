import assert from 'node:assert/strict';
import { connectSupervisorHost } from '../apps/controller/src/supervisorHostFactory.ts';
import { createCodexSupervisorHost, supervisorPrompt, StdioCodexRpc } from '../packages/adapters/src/codexSupervisorHost.ts';
import type { CodexRpc } from '../packages/adapters/src/codexSupervisorHost.ts';
import type { DispatchPayload } from '../packages/adapters/src/supervisorHost.ts';
let checks = 0;
function check(v: unknown, message: string) { assert.ok(v, message); checks++; }
const payload: DispatchPayload = { dispatchId: 'dispatch-test', projectId: 'project-test', workflowId: 'wf-test',
  goal: 'test', completionCondition: 'accepted', stageRange: { from: 'experiment', to: 'review' },
  workdir: '/tmp', authorizedResources: 'fake only', triggerReason: 'result', cursor: { fromSeq: 1, toSeq: 2 }, events: [], threadId: 'thread-test', turnId: '' };
let turns: any[] = [], calls: string[] = [], failStart = false, interruptConfirmed = false, interruptStatus = 'interrupted';
const rpc: CodexRpc = {
  status: () => ({ available: true, detail: 'fake' }), close() {},
  async request(method, params: any) {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: payload.threadId, cwd: '/tmp', turns } };
    if (method === 'turn/start') {
      turns = [{ id: 'turn-test', status: 'inProgress', items: [{ type: 'userMessage', content: params.input }] }];
      if (failStart) throw new Error('receipt lost');
      return { turn: turns[0] };
    }
    if (method === 'turn/interrupt') { if (interruptConfirmed) turns[0].status = interruptStatus; return {}; }
    throw new Error('unexpected method');
  },
};
const host = createCodexSupervisorHost(rpc);
check(host.status().available && calls.length === 0, 'idle status makes no calls');
check((await host.startTurn({ ...payload, threadId: '' })).kind === 'unavailable', 'binding required');
turns = [{ id: 'human-turn', status: 'inProgress' }];
check((await host.startTurn(payload)).kind === 'unavailable' && !calls.includes('turn/start'), 'busy thread never steered');
turns = []; calls = [];
check((await host.startTurn(payload)).kind === 'accepted', 'start existing thread');
check(!calls.includes('thread/start') && !calls.includes('thread/resume'), 'no hidden thread or detached resume');
const ref = { dispatchId: payload.dispatchId, threadId: payload.threadId, turnId: 'turn-test' };
check(await host.reconcile(ref) === 'running', 'running reconciliation');
check(!(await host.cancelTurn(ref)).ok, 'interrupt receipt is not cancellation confirmation');
interruptConfirmed = true;
check((await host.cancelTurn(ref)).ok, 'terminal state confirms interrupt');
turns = []; failStart = true; calls = [];
const lostHost = createCodexSupervisorHost(rpc);
check((await lostHost.startTurn(payload)).kind === 'lost_receipt', 'lost start receipt stays uncertain');
check(await host.reconcile({ ...ref, turnId: '' }) === 'running', 'recover by dispatch marker');
check((await lostHost.startTurn(payload)).kind === 'lost_receipt' && calls.filter(x => x === 'turn/start').length === 1, 'same dispatch never sent twice if present');
turns[0].status = 'completed';
check(await host.reconcile({ ...ref, turnId: '' }) === 'completed', 'completed recovered');
turns = [];
check(await host.reconcile(ref) === 'unknown', 'missing history is not not-started proof');
check(!(await host.cancelTurn(ref)).ok, 'never interrupt unlocated turn');
check(supervisorPrompt(payload).includes(payload.dispatchId), 'prompt carries ordinary dispatch ID');
// Missing history cannot undo the local receipt or create another start.
check((await lostHost.startTurn(payload)).kind === 'lost_receipt' && calls.filter(x => x === 'turn/start').length === 1, 'missing history never retries an uncertain local send');
const fresh = createCodexSupervisorHost(rpc);
check((await fresh.startTurn({ ...payload, workdir: '/other-project' })).kind === 'unavailable', 'wrong workspace binding rejected');
turns = []; failStart = false; calls = [];
const concurrent = createCodexSupervisorHost(rpc);
const same = await Promise.all([concurrent.startTurn(payload), concurrent.startTurn(payload)]);
check(same.every(r => r.kind === 'accepted') && calls.filter(x => x === 'turn/start').length === 1, 'concurrent same-dispatch starts share one request');
turns[0].status = 'failed';
check(await concurrent.reconcile(ref) === 'failed', 'failed turn is not completed');
check(!(await concurrent.cancelTurn(ref)).ok, 'already failed turn is not canceled');
turns[0].status = 'interrupted';
check(await concurrent.reconcile(ref) === 'canceled', 'interrupted turn is distinct');
turns[0].status = 'completed';
check(!(await concurrent.cancelTurn(ref)).ok, 'natural completion is not reported as canceled');
turns[0].status = 'inProgress'; interruptStatus = 'completed';
check(!(await concurrent.cancelTurn(ref)).ok, 'completion racing with interrupt is not canceled');


// Real subprocess protocol test: coalesced notifications and replies must all be consumed.
const childCode = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined){if(m.method==='hang')return;process.stdout.write(JSON.stringify({method:'notice',params:{}})+'\\n'+JSON.stringify({id:m.id,result:{ok:true}})+'\\n');}});`;
const transport = new StdioCodexRpc({ command: process.execPath, args: ['-e', childCode], requestTimeoutMs: 1000 });
await transport.connect();
check(transport.status().available, 'stdio handshake');
const results = await Promise.all([transport.request('a', {}), transport.request('b', {})]);
check(results.every(r => r.ok), 'multiple buffered responses');
await assert.rejects(transport.request('hang', {}), /timeout/); checks++;
transport.close();
check(!transport.status().available, 'closed unavailable');
const waiting = await connectSupervisorHost('waiting-for-connection');
check(!waiting.host.status().available, 'default factory never opens a model host');
waiting.close();
await assert.rejects(connectSupervisorHost('invalid'), /Unsupported/); checks++;
console.log(`Codex host adapter: ${checks} checks passed (fake host only, no model calls).`);
