import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CollaborationLoop, parseCollaborationReply,
  type CollaborationActionKind, type CollaborationInspection, type CollaborationPort,
  type CollaborationRun, type IterationPlanReply,
} from '../packages/core/src/collaborationLoop.ts';

// Keep all stores inside the checkout, including when this file runs with Windows Node.
const scratch = join(process.cwd(), 'var');
mkdirSync(scratch, { recursive: true });
const temp = mkdtempSync(join(scratch, 'iteration-planning-test-'));
let fixtures = 0, messages = 0;
interface Sent { sessionId: string; prompt: string; actionId: string; revision: number; kind: CollaborationActionKind }
const proposal = {
  summary: '先检查计数器的范围，再修改步长',
  audit: ['已读取 counter.ts，现有步长固定为 1'],
  recommendations: ['将步长参数接入现有按钮处理函数'],
  steps: ['修改 counter.ts 的增量计算', '运行 counter.test.ts 验证步长 2'],
  acceptanceCriteria: ['点击一次从 0 变为 2', '原有重置操作仍回到 0'],
  decision: 'proceed' as const,
};
class FakePort implements CollaborationPort {
  rows = new Map<string, CollaborationInspection>([
    ['executor', { provider: 'dsh-pi', status: 'idle', messages: [] }],
    ['reviewer', { provider: 'codex', status: 'idle', messages: [] }],
  ]);
  sent: Sent[] = [];
  interrupts: string[] = [];
  loseNextSend = false;
  async inspect(sessionId: string) { return structuredClone(this.rows.get(sessionId)!); }
  async send(sessionId: string, prompt: string) {
    const match = [...prompt.matchAll(/\{"actionId":"([^"]+)","revision":(\d+),"kind":"(plan|execute|review|sync)"/g)].at(-1);
    assert.ok(match, 'the prompt identifies the action and revision');
    const sent: Sent = { sessionId, prompt, actionId: match[1], revision: Number(match[2]), kind: match[3] as CollaborationActionKind };
    this.sent.push(sent);
    this.rows.get(sessionId)!.status = 'running';
    if (this.loseNextSend) { this.loseNextSend = false; throw new Error('remote accepted plan, response lost'); }
    return { accepted: true };
  }
  async interrupt(sessionId: string) { this.interrupts.push(sessionId); return { ok: true }; }
  last(sessionId: string) {
    const sent = this.sent.filter(item => item.sessionId === sessionId).at(-1);
    assert.ok(sent, `a request was dispatched to ${sessionId}`);
    return sent;
  }
  reply(sessionId: string, fields: Record<string, unknown> = {}, options: { idle?: boolean; final?: boolean; sent?: Sent } = {}) {
    const sent = options.sent ?? this.last(sessionId);
    const data = sent.kind === 'plan' ? proposal
      : sent.kind === 'execute' ? { summary: '已接入步长参数', artifacts: ['counter.ts'], tests: ['node counter.test.ts: PASS'] }
        : sent.kind === 'review' ? { verdict: 'accept', feedback: '源码和独立测试确认满足验收条件', checks: ['读取 counter.ts', 'node counter.test.ts: PASS'] }
          : { summary: '已理解新的步长要求' };
    const raw = JSON.stringify({ actionId: sent.actionId, revision: sent.revision, kind: sent.kind, ...data, ...fields });
    this.rows.get(sessionId)!.messages.push({ id: `planning-message-${++messages}`, role: 'assistant', text: raw, final: options.final ?? true });
    if (options.idle !== false) this.idle(sessionId);
    return raw;
  }
  idle(sessionId: string) { this.rows.get(sessionId)!.status = 'idle'; }
}
function fixture(auditFirst = true) {
  const root = join(temp, String(++fixtures));
  mkdirSync(root);
  const port = new FakePort();
  const config = { projectRoot: root, port, now: () => 1000, operationTimeoutMs: 20, actionTimeoutMs: 10_000 };
  const loop = new CollaborationLoop(config);
  const input = { task: '审核计数器并将步长改为 2', executorSessionId: 'executor', reviewerSessionId: 'reviewer', auditFirst };
  return { port, loop, config, state: () => loop.status()!, start: () => loop.start(input) };
}
function assertPlanOnly(port: FakePort) {
  assert.equal(port.sent.length, 1, 'planning sends exactly one request');
  assert.equal(port.sent[0].kind, 'plan');
  assert.equal(port.sent[0].sessionId, 'reviewer', 'only the bound independent reviewer receives the plan request');
}
function persisted(loop: CollaborationLoop) { return JSON.parse(readFileSync(loop.file, 'utf8')); }
async function synchronize(f: ReturnType<typeof fixture>) {
  await f.loop.tick();
  const syncs = f.port.sent.filter(item => item.kind === 'sync' && item.revision === f.state().revision);
  assert.equal(syncs.length, 2, 'both existing sessions receive the new direction');
  assert.deepEqual(syncs.map(item => item.sessionId).sort(), ['executor', 'reviewer']);
  f.port.reply('executor'); await f.loop.tick();
  assert.equal(f.port.sent.filter(item => item.kind === 'plan' && item.revision === f.state().revision).length, 0, 'one sync receipt cannot start planning');
  f.port.reply('reviewer'); await f.loop.tick();
  assert.equal(f.state().state, 'planning');
  assert.equal(f.port.last('reviewer').kind, 'plan');
  assert.equal(f.port.last('reviewer').revision, f.state().revision);
}
const cases: Array<[string, () => Promise<void> | void]> = [
  ['strict plan receipts', () => {
    const good: IterationPlanReply = { actionId: 'plan-a', revision: 1, kind: 'plan', ...proposal };
    assert.deepEqual(parseCollaborationReply(JSON.stringify(good)), good);
    assert.equal(parseCollaborationReply('ACK'), null);
    assert.equal(parseCollaborationReply(`Example: ${JSON.stringify(good)}`), null);
    for (const key of ['audit', 'recommendations', 'steps', 'acceptanceCriteria']) {
      const missing: Record<string, unknown> = { ...good }; delete missing[key];
      assert.equal(parseCollaborationReply(JSON.stringify(missing)), null, `${key} is required`);
      assert.equal(parseCollaborationReply(JSON.stringify({ ...good, [key]: [42] })), null, `${key} must contain strings`);
    }
    assert.equal(parseCollaborationReply(JSON.stringify({ ...good, decision: 'accept' })), null);
    for (const decision of ['no_change', 'needs_input']) {
      assert.ok(parseCollaborationReply(JSON.stringify({ ...good, decision, steps: [], acceptanceCriteria: [] })), `${decision} can describe an audit without implementation steps`);
    }
  }],
  ['audit first dispatch is durable and reviewer only', async () => {
    const f = fixture(); await f.start(); assertPlanOnly(f.port);
    assert.equal(f.state().state, 'planning');
    assert.equal(f.state().auditFirst, true);
    assert.equal(f.state().lastPlanId, f.port.last('reviewer').actionId);
    assert.equal(f.state().lastExecutionId, undefined);
    assert.equal(persisted(f.loop).runs[0].state, 'planning');
    await f.loop.tick(); assertPlanOnly(f.port);
  }],
  ['only current final plan and real reviewer idle permit execution', async () => {
    const f = fixture(); await f.start();
    f.port.reply('reviewer', { actionId: 'unrelated-plan' }); await f.loop.tick(); assertPlanOnly(f.port);
    f.port.reply('reviewer', { revision: 999 }); await f.loop.tick(); assertPlanOnly(f.port);
    f.port.reply('reviewer', {}, { final: false }); await f.loop.tick(); assertPlanOnly(f.port);
    f.port.reply('reviewer', {}, { idle: false }); f.port.rows.get('reviewer')!.status = 'running';
    await f.loop.tick(); assertPlanOnly(f.port);
    const reviewer = f.port.rows.get('reviewer')!;
    reviewer.status = 'idle'; reviewer.activeTurn = { id: 'still-active' };
    await f.loop.tick(); assertPlanOnly(f.port);
    delete reviewer.activeTurn;
    reviewer.approvals = [{ id: 'pending-input', kind: 'question', question: '步长是否允许负数？' }];
    await f.loop.tick(); assertPlanOnly(f.port);
    assert.equal(f.port.interrupts.length, 0, 'pending native input is preserved while planning waits');
    delete reviewer.approvals;
    await f.loop.tick();
    assert.equal(f.state().state, 'executing'); assert.equal(f.port.last('executor').kind, 'execute');
  }],
  ['persisted planned and sent plan restore without duplicate dispatch', async () => {
    const f = fixture(); await f.start();
    f.port.sent.length = 0; f.port.idle('reviewer');
    const saved = persisted(f.loop); saved.runs[0].actions[0].status = 'planned';
    writeFileSync(f.loop.file, JSON.stringify(saved));
    const restored = new CollaborationLoop(f.config);
    await restored.tick(); await restored.tick(); assertPlanOnly(f.port);
    const restoredAgain = new CollaborationLoop(f.config);
    await restoredAgain.tick(); assertPlanOnly(f.port);
    f.port.reply('reviewer'); await restoredAgain.tick();
    assert.equal(f.port.sent.filter(item => item.kind === 'execute').length, 1);
    const afterExecutionSend = new CollaborationLoop(f.config); await afterExecutionSend.tick();
    assert.equal(f.port.sent.filter(item => item.kind === 'execute').length, 1);
  }],
  ['proceed forwards the actual plan then independently reviews and repairs', async () => {
    const f = fixture(); await f.start(); f.port.reply('reviewer'); await f.loop.tick();
    const execution = f.port.last('executor');
    for (const text of [proposal.summary, ...proposal.audit, ...proposal.recommendations, ...proposal.steps, ...proposal.acceptanceCriteria]) {
      assert.ok(execution.prompt.includes(text), `executor receives actual plan content: ${text}`);
    }
    f.port.reply('executor'); await f.loop.tick();
    assert.equal(f.state().state, 'reviewing'); assert.equal(f.port.last('reviewer').kind, 'review');
    f.port.reply('reviewer', { verdict: 'revise', feedback: 'counter.ts:12 重置后仍为 2，必须改为 0' }); await f.loop.tick();
    assert.equal(f.state().state, 'executing'); assert.equal(f.state().revisionsUsed, 1);
    assert.match(f.port.last('executor').prompt, /重置后仍为 2/);
    f.port.reply('executor'); await f.loop.tick(); f.port.reply('reviewer'); await f.loop.tick();
    assert.equal(f.state().state, 'accepted');
    assert.equal(f.port.sent.filter(item => item.kind === 'plan').length, 1, 'ordinary review fixes reuse the accepted direction plan');
    assert.ok(f.port.sent.filter(item => item.kind === 'review').every(item => item.sessionId === 'reviewer'));
    assert.equal(f.state().events.filter(event => event.type === 'accepted').length, 1);
  }],
  ['no change becomes audited and never manufactures acceptance', async () => {
    const f = fixture(); await f.start();
    const raw = f.port.reply('reviewer', { decision: 'no_change', summary: '现有实现已经满足要求', recommendations: [], steps: [], acceptanceCriteria: [] });
    await f.loop.tick(); assert.equal(f.state().state, 'audited'); assertPlanOnly(f.port);
    assert.equal(f.state().lastExecutionId, undefined); assert.equal(f.state().lastReviewId, undefined);
    assert.ok(!f.state().events.some(event => event.type === 'accepted'));
    assert.ok(f.state().actions[0].replies.some(reply => reply.text === raw && reply.disposition === 'completed'));
    const restored = new CollaborationLoop(f.config); await restored.tick(); await restored.tick();
    assert.equal(restored.status()!.state, 'audited'); assertPlanOnly(f.port);
    await restored.start({ task: '新的独立审核', executorSessionId: 'executor', reviewerSessionId: 'reviewer', auditFirst: true });
    assert.equal(f.port.sent.length, 2, 'audited is terminal and permits a new task');
  }],
  ['needs input does not execute or interrupt pending native questions', async () => {
    const f = fixture(); await f.start();
    const reviewer = f.port.rows.get('reviewer')!;
    reviewer.approvals = [{ id: 'native-question', kind: 'question', question: '是否允许负步长？' }];
    f.port.reply('reviewer', { decision: 'needs_input', summary: '需要确认负步长是否在范围内', recommendations: ['请确认负步长范围'], steps: [], acceptanceCriteria: [] });
    await f.loop.tick(); assertPlanOnly(f.port);
    assert.equal(f.port.interrupts.length, 0); assert.equal(reviewer.approvals[0].id, 'native-question');
    // The final receipt becomes actionable only after the native question is answered.
    delete reviewer.approvals; await f.loop.tick();
    assert.equal(f.state().state, 'needs_attention'); assertPlanOnly(f.port);
    const restored = new CollaborationLoop(f.config); await restored.tick(); assertPlanOnly(f.port);
    assert.ok(!restored.status()!.events.some(event => event.type === 'accepted'));
  }],
  ['steering during planning discards the old revision and replans after both syncs', async () => {
    const f = fixture(); await f.start(); const old = f.port.last('reviewer');
    await f.loop.steer('将步长改成 3，先重新审核', { auditFirst: true });
    assert.equal(f.state().state, 'stopping'); assert.deepEqual(f.port.interrupts, ['reviewer']); assertPlanOnly(f.port);
    const oldRaw = f.port.reply('reviewer', { summary: '旧计划应当被丢弃' }, { sent: old });
    await f.loop.tick(); assert.equal(f.state().state, 'synchronizing');
    await synchronize(f);
    assert.equal(f.state().revision, 2); assert.notEqual(f.state().lastPlanId, old.actionId);
    assert.ok(f.state().actions.find(action => action.id === old.actionId)!.replies.some(reply => reply.text === oldRaw && reply.disposition === 'discarded'));
    assert.equal(f.port.sent.filter(item => item.kind === 'execute').length, 0);
    f.port.reply('reviewer', { summary: '新计划按步长 3 修改', steps: ['将增量改成 3'], acceptanceCriteria: ['一次点击从 0 变为 3'] });
    await f.loop.tick(); const execution = f.port.last('executor');
    assert.equal(execution.revision, 2); assert.ok(execution.prompt.includes('新计划按步长 3 修改'));
    assert.ok(!execution.prompt.includes('旧计划应当被丢弃'), 'obsolete plan content never becomes implementation input');
  }],
  ['steering during execution can enable audit first for the new direction', async () => {
    const f = fixture(false); await f.start(); assert.equal(f.port.last('executor').kind, 'execute');
    await f.loop.steer('改成步长 4，先审计现有实现', { auditFirst: true });
    assert.equal(f.state().state, 'stopping'); assert.deepEqual(f.port.interrupts, ['executor']);
    assert.equal(f.port.sent.length, 1);
    f.port.idle('executor'); await f.loop.tick(); assert.equal(f.state().state, 'synchronizing');
    await synchronize(f);
    assert.equal(f.state().auditFirst, true);
    assert.equal(f.port.sent.filter(item => item.kind === 'execute').length, 1, 'old execution stops before a new plan');
    f.port.reply('reviewer'); await f.loop.tick();
    assert.equal(f.port.sent.filter(item => item.kind === 'execute').length, 2);
    assert.equal(f.port.last('executor').revision, 2);
  }],
  ['unknown plan delivery is never replayed and a matched receipt can advance it', async () => {
    const f = fixture(); f.port.loseNextSend = true; await f.start(); assertPlanOnly(f.port);
    assert.equal(f.state().actions[0].status, 'unknown');
    for (let tick = 0; tick < 3; tick++) await f.loop.tick(); assertPlanOnly(f.port);
    const restored = new CollaborationLoop(f.config); await restored.tick(); assertPlanOnly(f.port);
    f.port.reply('reviewer'); await restored.tick();
    assert.equal(restored.status()!.state, 'executing');
    assert.equal(f.port.sent.filter(item => item.kind === 'plan').length, 1);
  }],
  ['crash at plan sending boundary restores unknown without replay', async () => {
    const f = fixture(); await f.start();
    const saved = persisted(f.loop); saved.runs[0].actions[0].status = 'sending'; saved.runs[0].actions[0].transportPending = true;
    writeFileSync(f.loop.file, JSON.stringify(saved));
    const restored = new CollaborationLoop(f.config);
    assert.equal(restored.status()!.actions[0].status, 'unknown');
    await restored.tick(); await restored.tick(); assertPlanOnly(f.port);
  }],
];

const failures: string[] = [];
try {
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS iteration planning: ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL iteration planning: ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
  }
  assert.deepEqual(failures, [], `unsatisfied planning branches: ${failures.join('; ')}`);
  console.log(`PASS iteration planning: ${cases.length} isolated scenarios with persisted stores and fake sessions`);
} finally { rmSync(temp, { recursive: true, force: true }); }
