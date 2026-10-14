import assert from 'node:assert/strict';
import { collaborationReaderReport } from '../packages/core/src/readerBriefing.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationLoop, parseCollaborationReply, type CollaborationActionKind, type CollaborationInspection, type CollaborationPort, type CollaborationRun } from '../packages/core/src/collaborationLoop.ts';

const temp = mkdtempSync(join(tmpdir(), 'bri-collaboration-loop-'));
let fixtures = 0, messages = 0;
interface Sent { sessionId: string; prompt: string; actionId: string; revision: number; kind: CollaborationActionKind }
class FakePort implements CollaborationPort {
  rows = new Map<string, CollaborationInspection>([
    ['executor', { provider: 'dsh-pi', status: 'idle', messages: [] }],
    ['reviewer', { provider: 'codex', status: 'idle', messages: [] }],
  ]);
  sent: Sent[] = [];
  interrupts: string[] = [];
  loseNextSend = false;
  rejectNextSend = false;
  hangNextSend = false;
  beforeSend?: (sent: Sent) => void;
  async inspect(sessionId: string) { return structuredClone(this.rows.get(sessionId)!); }
  async send(sessionId: string, prompt: string) {
    const match = [...prompt.matchAll(/\{"actionId":"([^"]+)","revision":(\d+),"kind":"(execute|review|sync)"/g)].at(-1)!;
    assert.ok(match, 'each prompt specifies its action and ordinary revision');
    const sent: Sent = { sessionId, prompt, actionId: match[1], revision: Number(match[2]), kind: match[3] as CollaborationActionKind };
    this.sent.push(sent);
    this.beforeSend?.(sent);
    if (this.rejectNextSend) { this.rejectNextSend = false; return { accepted: false }; }
    this.rows.get(sessionId)!.status = 'running';
    if (this.loseNextSend) { this.loseNextSend = false; throw new Error('remote accepted, response lost'); }
    if (this.hangNextSend) { this.hangNextSend = false; return new Promise<{ accepted: boolean }>(() => {}); }
    return { accepted: true };
  }
  async interrupt(sessionId: string) { this.interrupts.push(sessionId); return { ok: true }; }
  last(sessionId: string) { return this.sent.filter(sent => sent.sessionId === sessionId).at(-1)!; }
  reply(sessionId: string, fields: Record<string, unknown> = {}, options: { idle?: boolean; final?: boolean; sent?: Sent } = {}) {
    const sent = options.sent ?? this.last(sessionId);
    const row = this.rows.get(sessionId)!;
    const data = sent.kind === 'execute' ? { summary: '实现了真实组件', artifacts: ['component.ts'], tests: ['node component.test.ts: PASS'] }
      : sent.kind === 'review' ? { verdict: 'accept', feedback: '已检查真实源码并独立运行测试', checks: ['读取 component.ts', 'node component.test.ts: PASS'] }
        : { summary: '已理解新方向及其影响' };
    const raw = JSON.stringify({ actionId: sent.actionId, revision: sent.revision, kind: sent.kind, ...data, ...fields });
    row.messages.push({ id: `message-${++messages}`, role: 'assistant', text: raw, ...(options.final !== undefined ? { final: options.final } : {}) });
    if (options.idle !== false) row.status = 'idle';
    return raw;
  }
  idle(sessionId: string) { this.rows.get(sessionId)!.status = 'idle'; }
}
function fixture(options: { maxRevisions?: number; maxDurationMs?: number; actionTimeoutMs?: number; onEvent?: (event: unknown, run: CollaborationRun) => Promise<void> } = {}) {
  const root = join(temp, String(++fixtures));
  mkdirSync(root);
  let now = 1000;
  const port = new FakePort();
  const config = { projectRoot: root, port, now: () => now, operationTimeoutMs: 20, actionTimeoutMs: options.actionTimeoutMs ?? 10_000, onEvent: options.onEvent };
  const loop = new CollaborationLoop(config);
  const input = { task: '实现计数器，步长为 1', executorSessionId: 'executor', reviewerSessionId: 'reviewer', maxRevisions: options.maxRevisions, maxDurationMs: options.maxDurationMs };
  return { port, loop, config, root, input, time(value: number) { now = value; }, state() { return loop.status()!; }, start() { return loop.start(input); } };
}

try {
  {
    const f=fixture();await f.start();
    const brief={question:'减少输入错误',approach:'检查必填字段',finding:'本地测试通过',meaning:'只完成表单检查',limitation:'尚未验证真实用户体验',next_step:'安排小范围试用'};
    f.port.reply('executor',{briefing:brief});await f.loop.tick();
    assert.equal(collaborationReaderReport(f.state()).briefing_status,'draft');
    assert.match(f.port.last('reviewer').prompt,/核对执行者 briefing/);
    f.port.reply('reviewer',{briefing:{...brief,finding:'独立检查确认必填项检查有效',limitation:'真实用户体验尚未验证，不代表减少了线上错误'}});await f.loop.tick();
    const report=collaborationReaderReport(f.state());
    assert.equal(report.briefing_status,'reviewed');
    assert.equal(report.briefing?.finding,'独立检查确认必填项检查有效');
    assert.equal(report.summary,report.briefing?.finding,'project result leads the page, not the reviewer work log');
    assert.match(report.briefing!.limitation,/不代表减少了线上错误/);
    const incomplete=structuredClone(f.state());
    (incomplete.actions.find(a=>a.id===incomplete.lastReviewId)!.reply as any).briefing={finding:'只返回一个更正'};
    const partial=collaborationReaderReport(incomplete);
    assert.equal(partial.briefing_status,'draft','incomplete reviewer output never becomes a reviewed report');
    assert.equal(partial.briefing?.limitation,brief.limitation,'partial output cannot erase the known material limitation');
    await f.loop.steer('改成检查数字范围');
    assert.equal(collaborationReaderReport(f.state()).briefing,undefined,'old accepted findings disappear when the direction changes');
    assert.equal(collaborationReaderReport(f.state()).briefing_status,'unavailable');
  }
  {
    const f=fixture({actionTimeoutMs:300000});await f.start();const action=f.port.last('executor').actionId;
    f.port.idle('executor');f.time(47000);await f.loop.tick();
    assert.equal(f.port.sent.length,2,'confirmed idle without a deliverable resumes instead of silently stalling');
    assert.equal(f.port.last('executor').actionId,action,'recovery continues the same action, not a new research task');
    assert.match(f.port.sent[1].prompt,/不重复执行已有操作/);
    f.port.reply('executor');await f.loop.tick();assert.equal(f.state().state,'reviewing');
    f.port.reply('reviewer');await f.loop.tick();assert.equal(f.state().state,'accepted');
  }
  {
    const f=fixture({actionTimeoutMs:300000});await f.start();
    for(const time of [47000,94000,141000]){f.port.idle('executor');f.time(time);await f.loop.tick();}
    assert.equal(f.port.sent.length,3,'recovery has two attempts, not an unbounded model loop');
    assert.equal(f.state().state,'needs_attention');
  }
  { const f=fixture();await f.start();f.time(47000);f.port.rows.get('executor')!.lastProgressAt=new Date(45000).toISOString();await f.loop.tick();assert.equal(f.state().state,'executing','healthy research activity prevents an age-only timeout'); }
  assert.equal(parseCollaborationReply('ACK'), null);
  assert.equal(parseCollaborationReply('\n\n---\n\n{\"actionId\":\"native-final\",\"revision\":1,\"kind\":\"sync\",\"summary\":\"confirmed\"}')?.kind, 'sync');
  assert.equal(parseCollaborationReply('Here is a quoted example: {\"actionId\":\"a\",\"revision\":1,\"kind\":\"sync\",\"summary\":\"example\"}'), null);
  assert.equal(parseCollaborationReply('```json\n{}\n```'), null);
  assert.equal(parseCollaborationReply('{"actionId":"a","revision":1,"kind":"review","verdict":"accept","feedback":"ok","checks":[]}'), null);
  {
    const callbacks: string[] = [];
    const f = fixture({ onEvent: async event => { await Promise.resolve(); callbacks.push((event as { type: string }).type); } });
    await f.start();
    assert.equal(f.state().state, 'executing'); assert.equal(f.port.sent.length, 1);
    f.port.reply('executor'); await f.loop.tick();
    assert.equal(f.state().state, 'reviewing'); assert.match(f.port.last('reviewer').prompt, /实际运行适当测试/);
    const negative = f.port.reply('reviewer', { verdict: 'revise', feedback: 'component.ts:8 步长未使用；运行测试得到 1 而预期 2' });
    await f.loop.tick();
    assert.equal(f.state().state, 'executing'); assert.equal(f.state().revisionsUsed, 1);
    assert.match(f.port.last('executor').prompt, /步长未使用/);
    f.port.reply('executor', { tests: ['node component.test.ts: PASS after fix'] }); await f.loop.tick();
    assert.equal(f.port.sent.filter(sent => sent.sessionId === 'reviewer').length, 2);
    assert.ok(f.port.sent.filter(sent => sent.kind === 'review').every(sent => sent.sessionId === 'reviewer'), 'reuse one independent reviewer session');
    const positive = f.port.reply('reviewer'); await f.loop.tick();
    assert.equal(f.state().state, 'accepted'); assert.equal(f.state().round, 2);
    assert.ok(callbacks.includes('execute_completed') && callbacks.includes('revision_requested') && callbacks.includes('accepted'), 'async native-state callback is awaited');
    const saved = readFileSync(f.loop.file, 'utf8'); assert.ok(saved.includes(negative.replaceAll('"', '\\"'))); assert.ok(saved.includes(positive.replaceAll('"', '\\"')));
    assert.equal(f.state().actions.filter(action => action.reply?.kind === 'review').length, 2);
    await f.loop.tick(); assert.equal(f.port.sent.length, 4);
  }
  {
    const f = fixture(); await f.start();
    const row = f.port.rows.get('executor')!; row.status = 'idle'; row.messages.push({ id: 'ack', role: 'assistant', text: 'ACK' });
    for (let i = 0; i < 3; i++) await f.loop.tick();
    assert.equal(f.state().state, 'executing'); assert.equal(f.port.sent.length, 1, 'send accepted plus idle ACK cannot trigger review');
    assert.ok(f.state().actions[0].replies.some(reply => reply.text === 'ACK'));
    f.port.reply('executor', { revision: 999 }); await f.loop.tick(); assert.equal(f.port.sent.length, 1);
    f.port.reply('executor', {}, { idle: false }); row.status = 'running'; await f.loop.tick();
    assert.equal(f.port.sent.length, 1, 'JSON emitted before the turn is idle cannot complete');
    row.status = 'idle'; await f.loop.tick(); assert.equal(f.port.sent.length, 2, 'same final receipt can complete once idle is observed');
    f.port.reply('reviewer', {}, { final: false }); await f.loop.tick(); assert.equal(f.state().state, 'reviewing', 'explicit nonfinal message cannot accept');
  }
  {
    const f = fixture(); await f.start(); f.port.reply('executor'); await f.loop.tick();
    const oldReview = f.port.last('reviewer');
    await f.loop.steer('改成步长 2，界面改为蓝色');
    assert.equal(f.state().state, 'stopping'); assert.deepEqual(f.port.interrupts, ['reviewer']);
    assert.equal(f.port.sent.length, 2, 'interrupt ACK is insufficient to dispatch synchronization');
    await f.loop.tick(); assert.equal(f.port.interrupts.length, 1, 'do not repeatedly interrupt an uncertain stop');
    const oldRaw = f.port.reply('reviewer', { verdict: 'accept', feedback: '旧要求已通过' }, { sent: oldReview });
    await f.loop.tick(); assert.equal(f.state().state, 'synchronizing');
    assert.ok(f.state().events.some(event => event.type === 'stale_reply_discarded'));
    assert.ok(f.state().actions.find(action => action.id === oldReview.actionId)!.replies.some(reply => reply.text === oldRaw && reply.disposition === 'discarded'));
    await f.loop.tick();
    const syncs = f.port.sent.filter(sent => sent.kind === 'sync');
    assert.equal(syncs.length, 2); assert.deepEqual(syncs.map(sent => sent.sessionId).sort(), ['executor', 'reviewer']);
    assert.ok(syncs.every(sent => sent.revision === 2 && sent.prompt.includes('步长 2') && sent.prompt.includes('蓝色')));
    f.port.reply('executor'); await f.loop.tick(); assert.equal(f.port.sent.length, 4, 'both sessions must acknowledge synchronization before execution resumes');
    f.port.reply('reviewer'); await f.loop.tick();
    assert.equal(f.state().state, 'executing'); assert.equal(f.port.last('executor').revision, 2);
    assert.ok(f.state().events.some(event => event.type === 'directions_synchronized'));
    f.port.reply('executor'); await f.loop.tick(); f.port.reply('reviewer'); await f.loop.tick(); assert.equal(f.state().state, 'accepted');
    assert.equal(f.state().revision, 2); assert.equal(f.port.last('reviewer').sessionId, 'reviewer');
  }
  {
    const f = fixture(); f.port.loseNextSend = true; await f.start();
    assert.equal(f.state().actions[0].status, 'unknown');
    for (let i = 0; i < 4; i++) await f.loop.tick();
    assert.equal(f.port.sent.length, 1, 'ambiguous sends are never blindly replayed');
    const restored = new CollaborationLoop(f.config); await restored.tick(); assert.equal(f.port.sent.length, 1);
    f.port.reply('executor'); await restored.tick(); assert.equal(restored.status()!.state, 'reviewing');
    f.port.reply('reviewer'); await restored.tick(); assert.equal(restored.status()!.state, 'accepted');
  }
  {
    const f = fixture(); f.port.hangNextSend = true; await f.start();
    assert.equal(f.state().actions[0].status, 'unknown'); await f.loop.tick(); assert.equal(f.port.sent.length, 1, 'hung transport is bounded without resend');
    const saved = JSON.parse(readFileSync(f.loop.file, 'utf8')); saved.runs[0].actions[0].status = 'sending'; writeFileSync(f.loop.file, JSON.stringify(saved));
    const restored = new CollaborationLoop(f.config); assert.equal(restored.status()!.actions[0].status, 'unknown');
    await restored.tick(); assert.equal(f.port.sent.length, 1, 'crash at send boundary is treated as unknown');
  }
  {
    const f = fixture();
    let finishTransport!: (result: { accepted: boolean }) => void;
    const ordinarySend = f.port.send.bind(f.port);
    f.port.send = async (id, prompt) => {
      const result = await ordinarySend(id, prompt);
      f.port.idle(id); // The queued transport has not delivered a turn yet.
      if (f.port.sent.length === 1) return new Promise(resolve => { finishTransport = resolve; });
      return result;
    };
    await f.start(); await f.loop.steer('消息仍在途中时调整步长 4');
    for (let i = 0; i < 3; i++) await f.loop.tick();
    assert.equal(f.state().state, 'stopping'); assert.equal(f.port.sent.length, 1, 'idle does not authorize replacement work while old send is unresolved');
    assert.ok(f.state().events.some(event => event.type === 'send_stop_unconfirmed'));
    finishTransport({ accepted: true }); await Promise.resolve(); await f.loop.tick(); await f.loop.tick();
    assert.equal(f.port.sent.filter(sent => sent.kind === 'sync').length, 2, 'resolved late transport permits fresh stop and synchronization observations');
  }
  {
    const f = fixture(); let steer!: Promise<CollaborationRun>;
    f.port.beforeSend = sent => { if (sent.kind === 'execute' && sent.revision === 1) steer = f.loop.steer('发送过程中改成步长 5'); };
    await f.start(); await steer;
    assert.equal(f.state().state, 'stopping'); assert.equal(f.state().revision, 2);
    assert.equal(f.state().actions[0].status, 'obsolete', 'late send ACK cannot overwrite steering state');
    await f.loop.tick(); assert.deepEqual(f.port.interrupts, ['executor']);
    f.port.idle('executor'); await f.loop.tick(); await f.loop.tick();
    assert.equal(f.port.sent.filter(sent => sent.kind === 'sync').length, 2);
  }
  {
    const f = fixture(); await f.start();
    f.port.sent.length = 0; f.port.idle('executor');
    const saved = JSON.parse(readFileSync(f.loop.file, 'utf8')); saved.runs[0].actions[0].status = 'planned'; writeFileSync(f.loop.file, JSON.stringify(saved));
    const restored = new CollaborationLoop(f.config); await restored.tick(); await restored.tick();
    assert.equal(f.port.sent.length, 1, 'a crash before the persisted send boundary can dispatch the planned action once');
  }
  {
    const f = fixture(); await f.start();
    const pending = Array.from({ length: 12 }, () => f.loop.tick()); assert.ok(pending.every(item => item === pending[0])); await Promise.all(pending);
    assert.equal(f.port.sent.length, 1, 'ticks are single flight');
    const restored = new CollaborationLoop(f.config); f.port.reply('executor'); await restored.tick();
    const restoredAgain = new CollaborationLoop(f.config); await restoredAgain.tick(); assert.equal(f.port.sent.length, 2, 'restart does not repeat review dispatch');
    f.port.reply('reviewer'); await restoredAgain.tick(); assert.equal(restoredAgain.status()!.state, 'accepted');
  }
  {
    const f = fixture({ maxRevisions: 0 }); await f.start();
    f.port.reply('executor'); await f.loop.tick(); f.port.reply('reviewer', { verdict: 'revise', feedback: '测试失败，不能接受' }); await f.loop.tick();
    assert.equal(f.state().state, 'budget_exhausted'); assert.equal(f.port.sent.length, 2);
    await f.loop.tick(); assert.equal(f.port.sent.length, 2);
    const defaults = fixture(); await defaults.start(); assert.equal(defaults.state().maxRevisions, 3);
    for (let i = 0; i < 4; i++) {
      defaults.port.reply('executor'); await defaults.loop.tick();
      defaults.port.reply('reviewer', { verdict: 'revise', feedback: `第 ${i + 1} 轮测试仍失败` }); await defaults.loop.tick();
    }
    assert.equal(defaults.state().state, 'budget_exhausted'); assert.equal(defaults.state().round, 4); assert.equal(defaults.port.sent.length, 8);
  }
  {
    const f = fixture({ maxDurationMs: 100 }); await f.start(); f.time(1101); await f.loop.tick();
    assert.equal(f.state().state, 'stopping'); assert.deepEqual(f.port.interrupts, ['executor']);
    f.port.idle('executor'); await f.loop.tick(); assert.equal(f.state().state, 'budget_exhausted'); assert.equal(f.port.sent.length, 1);
    const timeout = fixture({ actionTimeoutMs: 50 }); await timeout.start(); timeout.time(1051); await timeout.loop.tick();
    assert.equal(timeout.state().state, 'stopping'); timeout.port.idle('executor'); await timeout.loop.tick(); assert.equal(timeout.state().state, 'needs_attention');
  }
  {
    const f = fixture(); await f.start(); await f.loop.pause(); assert.equal(f.state().state, 'stopping');
    f.port.idle('executor'); await f.loop.tick(); assert.equal(f.state().state, 'paused');
    await f.loop.steer('恢复并改成步长 3'); await f.loop.tick(); assert.equal(f.port.sent.filter(sent => sent.kind === 'sync').length, 2);
  }
  {
    const f = fixture(); f.port.rows.get('reviewer')!.provider = 'dsh-pi'; await assert.rejects(f.start(), /Codex/); assert.equal(f.port.sent.length, 0);
    f.port.rows.get('reviewer')!.provider = 'codex'; f.port.rows.get('executor')!.activeTurn = { id: 'active' };
    await assert.rejects(f.start(), /实际空闲/); assert.equal(f.port.sent.length, 0);
  }
  {
    const f = fixture({ onEvent: async () => { throw new Error('native state helper unavailable'); } }); await f.start();
    assert.equal(f.port.sent.length, 1); assert.match(f.state().callbackError!, /helper unavailable/); await f.loop.tick(); assert.equal(f.port.sent.length, 1);
    f.port.rejectNextSend = true; f.port.reply('executor'); await f.loop.tick(); assert.equal(f.state().state, 'stopping');
    await f.loop.tick(); assert.equal(f.state().state, 'needs_attention');
  }
  {
    const f = fixture({ onEvent: async event => { if ((event as { type: string }).type === 'accepted') throw new Error('artifact missing'); } });
    await f.start(); f.port.reply('executor'); await f.loop.tick(); const raw = f.port.reply('reviewer'); await f.loop.tick();
    assert.equal(f.state().state, 'needs_attention'); assert.match(f.state().reason!, /评审通过，但产物\/ARIS记录未完成/);
    assert.ok(f.state().actions.at(-1)!.replies.some(reply => reply.text === raw && reply.disposition === 'completed'));
    await f.loop.tick(); assert.equal(f.port.sent.length, 2, 'failed native record callback never resends a model request');
  }
  {
    const f = fixture(); await f.start(); f.port.reply('executor'); await f.loop.tick(); f.port.reply('reviewer'); await f.loop.tick();
    const saved = JSON.parse(readFileSync(f.loop.file, 'utf8')); saved.runs.at(-1).acceptanceRecordPending = true;
    writeFileSync(f.loop.file, JSON.stringify(saved));
    let recorded = 0;
    const recovered = new CollaborationLoop({...f.config, onEvent: async event => { if (event.type === 'accepted') recorded++; }});
    assert.equal(recovered.status()!.state, 'reviewing', 'crash before durable local acceptance is not accepted');
    await recovered.tick(); assert.equal(recorded,1); assert.equal(recovered.status()!.state,'accepted');
    assert.equal(f.port.sent.length,2,'local acceptance recovery never replays model work');
  }
  {
    const f = fixture(); const outside = join(temp, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(f.root, '.bri'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => new CollaborationLoop(f.config), /项目之外/);
    await assert.rejects(f.start(), /项目之外/); assert.equal(f.port.sent.length, 0, 'live writes recheck the project boundary');
    const fileFixture = fixture(); mkdirSync(join(fileFixture.root, '.bri'));
    const target = join(outside, 'collaboration.json'); writeFileSync(target, '{"version":1,"runs":[]}');
    // Windows junctions exercise the same realpath boundary without requiring
    // elevated privileges to create a file symlink.
    symlinkSync(process.platform === 'win32' ? outside : target, join(fileFixture.root, '.bri', 'collaboration.json'), process.platform === 'win32' ? 'junction' : 'file');
    assert.throws(() => new CollaborationLoop(fileFixture.config), /项目之外/);
  }
  console.log('PASS collaboration loop: independent review, real final receipts, automatic fixes, both-session steering, stale discard, uncertain-send nonreplay, crash recovery, single-flight ticks, bounded revisions/time, confirmed pause, durable raw replies and awaited callbacks');
} finally { rmSync(temp, { recursive: true, force: true }); }
