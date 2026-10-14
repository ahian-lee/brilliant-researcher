import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalCoordinator, parseApprovalVerdict, type ApprovalCandidate, type ApprovalCoordinatorPort, type ApprovalReviewer, type HumanNotificationStatus, type ReviewerInspection } from '../packages/core/src/approvalCoordinator.ts';

const temp = mkdtempSync(join(tmpdir(), 'bri-approval-coordinator-'));
let files = 0;
const verdict = (decision: 'allow' | 'deny', risk = 'low') => JSON.stringify({ decision, risk, reason: decision === 'allow' ? '精确请求符合用户已授权范围' : '缺少具体授权或上下文' });
const candidate = (): ApprovalCandidate => ({
  projectId: 'p1', projectName: '组件协作', goal: '读取组件目录并检查', constraints: '仅限项目目录，不删除文件或调整系统安全设置',
  session: { id: 's1', title: 'DSH 实现组件', provider: 'dsh-pi', cwd: '/research/component', model: 'original-dsh-model', status: 'waiting_input', permissionPreset: 'standard' },
  approvals: [{ id: 'permission-1', title: '执行命令', description: 'command: ls components\ncwd: /research/component', options: [{ id: 'reject', label: '拒绝' }, { id: 'allow-once', label: '仅本次允许' }, { id: 'always', label: '永久允许' }] }],
  authorizationVersion: 'direction-1',
  userMessages: ['请检查 components 下有哪些现成组件。', 'SENSITIVE_HUMAN_TRACE_DO_NOT_PERSIST'],
});
interface Review { row: ApprovalReviewer; inspection: ReviewerInspection; visible: boolean }
class FakePort implements ApprovalCoordinatorPort {
  source: ApprovalCandidate | null = candidate();
  created: Array<{ projectId: string; reviewKey: string; provider: string; model?: string; prompt: string }> = [];
  reviewers: Review[] = [];
  plans: Record<string, ReviewerInspection> = {
    'dsh-pi': { status: 'completed', messages: [{ role: 'assistant', text: verdict('allow') }], approvals: [] },
    codex: { status: 'completed', messages: [{ role: 'assistant', text: verdict('allow') }], approvals: [] },
  };
  allowed: Array<{ sessionId: string; approvalId: string; optionId: string }> = [];
  notifications: Array<{ id: string; projectId: string; projectName: string; sessionId: string; reason: string }> = [];
  notificationStatus: HumanNotificationStatus = 'sent';
  notificationReady = false;
  failList = false; failRead = false; failInspect = new Set<string>();
  lostCreate = new Set<string>(); hiddenCreate = false; lostAllow = false; lostNotify = false;
  readCount = 0;
  beforeRead?: (count: number) => void;
  includeReviewers = false;
  async listCandidates() {
    if (this.failList) throw new Error('disconnected');
    const rows = this.source ? [structuredClone(this.source)] : [];
    if (this.includeReviewers) for (const reviewer of this.reviewers) rows.push({ ...candidate(), session: { ...candidate().session, id: reviewer.row.id, title: reviewer.row.title, provider: reviewer.row.provider!, permissionPreset: 'standard' }, approvals: [{ id: 'reviewer-approval', title: '工具请求', description: 'command: dangerous', options: [{ id: 'allow-once', label: '仅本次' }] }] });
    return rows;
  }
  async createReviewer(input: { projectId: string; reviewKey: string; provider: string; model?: string; prompt: string }) {
    this.created.push(input);
    const row = { id: `review-${this.reviewers.length + 1}`, title: input.reviewKey, provider: input.provider };
    this.reviewers.push({ row, inspection: structuredClone(this.plans[input.provider]), visible: !this.hiddenCreate });
    if (this.lostCreate.delete(input.provider)) throw new Error('created remotely; response lost');
    return row;
  }
  async findReviewer(_projectId: string, key: string) { return this.reviewers.find(review => review.visible && review.row.title === key)?.row ?? null; }
  async inspectReviewer(_projectId: string, id: string) {
    const review = this.reviewers.find(row => row.row.id === id)!;
    if (this.failInspect.has(review.row.provider!)) throw new Error('review disconnected');
    return structuredClone(review.inspection);
  }
  async readPending(_projectId: string, sessionId: string) {
    this.beforeRead?.(++this.readCount);
    if (this.failRead) throw new Error('source disconnected');
    return this.source?.session.id === sessionId ? structuredClone(this.source) : null;
  }
  async allowOnce(_projectId: string, sessionId: string, approvalId: string, optionId: 'allow-once') {
    assert.equal(optionId, 'allow-once');
    this.allowed.push({ sessionId, approvalId, optionId });
    if (this.lostAllow) throw new Error('permission reply lost');
    return { ok: true };
  }
  async notifyHuman(input: { id: string; projectId: string; projectName: string; sessionId: string; reason: string }) {
    this.notifications.push(input);
    if (this.lostNotify) throw new Error('notification reply lost');
    return { status: this.notificationStatus, ...(this.notificationStatus === 'sent' ? { messageId: 'feishu-message-1' } : {}) };
  }
  humanNotificationReady() { return this.notificationReady; }
}
function fixture(port = new FakePort()) {
  let now = 10_000;
  const file = join(temp, `approvals-${++files}.json`);
  const options = { file, port, now: () => now, reviewTimeoutMs: 120_000, operationTimeoutMs: 1000 };
  const coordinator = new ApprovalCoordinator(options);
  return { port, file, options, coordinator, time(value: number) { now = value; }, state() { return coordinator.reviews('p1', 's1')[0]; } };
}

try {
  {
    const f = fixture(); f.port.source!.session.provider = 'codex';
    const coordinator = new ApprovalCoordinator({...f.options, additionalProviders:['codex'], codexModel:'gpt-6.1-sol'});
    await coordinator.tick(); assert.equal(f.port.created.length,1);
    assert.equal(f.port.created[0].provider,'codex'); assert.equal(f.port.created[0].model,'gpt-6.1-sol');
    assert.match(f.port.created[0].prompt,/禁止使用任何工具/);
    await coordinator.tick(); assert.equal(f.port.allowed.length,1);
    f.port.includeReviewers=true; await coordinator.tick(); assert.equal(f.port.created.length,1,'permission reviewer cannot recursively approve itself');
  }
  {
    const f = fixture();
    f.port.source!.approvals[0].kind = 'question';
    await f.coordinator.tick();
    assert.equal(f.port.created.length, 0, 'human questions do not launch tool reviewers');
    assert.equal(f.port.allowed.length, 0);
    assert.equal(f.port.notifications.length, 0, 'no misleading tool rejection notice for a question');
    assert.equal(f.coordinator.reviews('p1','s1').length, 0);
  }
  assert.equal(parseApprovalVerdict('ACK'), null);
  assert.equal(parseApprovalVerdict('```json\n' + verdict('allow') + '\n```'), null);
  assert.equal(parseApprovalVerdict('{"decision":"allow","risk":"medium","reason":""}'), null);
  assert.equal(parseApprovalVerdict(verdict('allow'))?.decision, 'allow');

  {
    const f = fixture(); await f.coordinator.tick();
    assert.equal(f.state().state, 'approved'); assert.equal(f.port.allowed.length, 1); assert.equal(f.port.created.length, 1);
    assert.equal(f.port.created[0].provider, 'dsh-pi'); assert.equal(f.port.created[0].model, 'original-dsh-model');
    assert.match(f.port.created[0].prompt, /禁止使用任何工具/); assert.match(f.port.created[0].prompt, /具体操作及范围的明确授权/);
    assert.match(f.port.created[0].prompt, /审核 reason/); assert.match(f.port.created[0].prompt, /缺少具体命令/);
    assert.equal(f.port.notifications.length, 0);
    for (let i = 0; i < 4; i++) await f.coordinator.tick();
    assert.equal(f.port.allowed.length, 1); assert.equal(f.port.created.length, 1);
    assert.ok(!readFileSync(f.file, 'utf8').includes('SENSITIVE_HUMAN_TRACE_DO_NOT_PERSIST'), 'private transcript is never persisted');
  }
  {
    const f = fixture(); f.port.plans['dsh-pi'].messages[0].text = verdict('deny');
    await f.coordinator.tick(); assert.equal(f.state().state, 'approved'); assert.deepEqual(f.port.created.map(row => row.provider), ['dsh-pi', 'codex']);
    assert.equal(f.port.created[1].model, undefined, 'Codex uses runtime default unless explicitly configured');
    assert.equal(f.port.allowed.length, 1);
  }
  {
    const f = fixture(); f.port.source!.session.permissionPreset = 'auto'; f.port.source!.session.modeId = 'ptc';
    await f.coordinator.tick(); assert.deepEqual(f.port.created.map(row => row.provider), ['codex']); assert.equal(f.state().reviewers[0].status, 'native_not_allowed');
    const other = fixture(); other.port.source!.session.modeId = 'auto'; other.port.source!.session.permissionPreset = 'standard';
    await other.coordinator.tick(); assert.equal(other.port.created[0].provider, 'dsh-pi', 'Paseo modeId is not DSH permissionPreset');
  }
  {
    const f = fixture(); f.port.plans['dsh-pi'].messages[0].text = verdict('deny'); f.port.plans.codex.messages[0].text = verdict('deny', 'medium');
    await f.coordinator.tick(); for (let i = 0; i < 4; i++) await f.coordinator.tick();
    assert.equal(f.state().state, 'human_required'); assert.equal(f.state().notification?.status, 'sent'); assert.equal(f.port.allowed.length, 0); assert.equal(f.port.notifications.length, 1); assert.equal(f.port.created.length, 2);
    const notification = JSON.stringify(f.port.notifications[0]); assert.ok(!notification.includes('command:')); assert.ok(!notification.includes('components')); assert.ok(!notification.includes('SENSITIVE_HUMAN'));
  }
  {
    const f = fixture(); f.port.failInspect.add('dsh-pi'); f.port.failInspect.add('codex');
    await f.coordinator.tick(); assert.equal(f.state().state, 'human_required'); assert.equal(f.port.allowed.length, 0); assert.equal(f.port.created.length, 2);
    const missing = fixture(); missing.port.failRead = true; await missing.coordinator.tick(); assert.equal(missing.state().state, 'human_required'); assert.equal(missing.port.allowed.length, 0); assert.equal(missing.port.created.length, 0);
    const list = fixture(); list.port.failList = true; await list.coordinator.tick(); assert.equal(list.port.allowed.length, 0); assert.equal(list.port.created.length, 0); assert.ok(list.coordinator.lastError);
  }
  {
    const f = fixture(); f.port.beforeRead = count => { if (count === 2) f.port.source!.approvals[0].description = 'command: rm -rf /different'; };
    await f.coordinator.tick(); assert.equal(f.state().state, 'human_required'); assert.equal(f.port.allowed.length, 0);
    const cwd = fixture(); cwd.port.beforeRead = count => { if (count === 2) cwd.port.source!.session.cwd = '/different'; };
    await cwd.coordinator.tick(); assert.equal(cwd.state().state, 'human_required'); assert.equal(cwd.port.allowed.length, 0);
    const manual = fixture(); manual.port.beforeRead = count => { if (count === 2) manual.port.source!.approvals = []; };
    await manual.coordinator.tick(); assert.equal(manual.state().state, 'resolved'); assert.equal(manual.port.allowed.length, 0); assert.equal(manual.port.notifications.length, 0);
  }
  {
    const f = fixture(); f.port.lostCreate.add('dsh-pi'); f.port.hiddenCreate = true;
    await f.coordinator.tick(); assert.equal(f.state().reviewers[0].status, 'create_unknown'); assert.equal(f.port.created.length, 1);
    const restored = new ApprovalCoordinator(f.options); f.port.reviewers[0].visible = true;
    await restored.tick(); assert.equal(restored.reviews('p1', 's1')[0].state, 'approved'); assert.equal(f.port.created.length, 1, 'lost creation reply reconciles by persistent reviewKey without duplicate');
  }
  {
    const f = fixture(); const tasks = Array.from({ length: 25 }, () => f.coordinator.tick()); assert.ok(tasks.every(task => task === tasks[0]));
    await Promise.all(tasks); assert.equal(f.port.created.length, 1); assert.equal(f.port.allowed.length, 1);
  }
  {
    const f = fixture();
    f.port.source!.approvals.push({ ...structuredClone(f.port.source!.approvals[0]), id: 'permission-2' });
    f.port.plans['dsh-pi'] = { status: 'running', messages: [], approvals: [] };
    await f.coordinator.tick();
    assert.equal(f.port.created.length, 1, 'a burst of pending approvals does not launch concurrent reviewers');
    f.port.reviewers[0].inspection = { status: 'idle', messages: [{ role: 'assistant', text: verdict('allow') }], approvals: [] };
    await f.coordinator.tick();
    assert.equal(f.port.created.length, 2, 'the next reviewer starts when the first finishes');
  }
  {
    const f = fixture(); f.port.includeReviewers = true;
    f.port.plans['dsh-pi'].approvals = [{ id: 'dsh-reviewer-needs-tool' }];
    f.port.plans.codex.approvals = [{ id: 'codex-reviewer-needs-tool' }];
    await f.coordinator.tick(); for (let i = 0; i < 3; i++) await f.coordinator.tick();
    assert.equal(f.state().state, 'human_required'); assert.equal(f.port.created.length, 2, 'reviewer tool approvals must not recurse'); assert.equal(f.port.allowed.length, 0);
    assert.equal(f.coordinator.reviews('p1', 'review-1').length, 0);
  }
  {
    const f = fixture(); f.port.plans['dsh-pi'] = { status: 'running', messages: [{ role: 'assistant', text: 'ACK' }], approvals: [] };
    await f.coordinator.tick(); assert.equal(f.state().state, 'reviewing_dsh'); assert.equal(f.port.allowed.length, 0); assert.equal(f.port.created.length, 1);
    f.port.reviewers[0].inspection.status = 'completed'; await f.coordinator.tick(); assert.equal(f.state().state, 'approved'); assert.equal(f.state().reviewers[0].status, 'invalid'); assert.equal(f.port.created[1].provider, 'codex');
    const high = fixture(); high.port.plans['dsh-pi'].messages[0].text = verdict('allow', 'high'); high.port.plans.codex.messages[0].text = verdict('allow', 'high');
    await high.coordinator.tick(); assert.equal(high.state().state, 'human_required'); assert.equal(high.port.allowed.length, 0);
    const incomplete = fixture(); incomplete.port.source!.approvals[0].description = ''; await incomplete.coordinator.tick(); assert.equal(incomplete.state().state, 'human_required'); assert.equal(incomplete.port.created.length, 2); assert.equal(incomplete.port.allowed.length, 0);
  }
  {
    const f = fixture(); f.port.plans['dsh-pi'].status = 'running'; f.port.plans.codex.status = 'running';
    await f.coordinator.tick(); f.time(130_001); await f.coordinator.tick(); assert.equal(f.state().state, 'reviewing_codex'); assert.equal(f.state().reviewers[0].status, 'timed_out');
    f.time(250_002); await f.coordinator.tick(); assert.equal(f.state().state, 'human_required'); assert.equal(f.state().reviewers[1].status, 'timed_out'); assert.equal(f.port.notifications.length, 1); assert.equal(f.port.allowed.length, 0);
  }
  {
    const f = fixture(); f.port.lostAllow = true; await f.coordinator.tick(); assert.equal(f.state().state, 'unknown');
    const restored = new ApprovalCoordinator(f.options); for (let i = 0; i < 3; i++) await restored.tick(); assert.equal(f.port.allowed.length, 1, 'lost allow response is never replayed');
    f.port.source!.approvals = []; await restored.tick(); assert.equal(restored.reviews('p1', 's1')[0].state, 'resolved');
    const offered = fixture(); offered.port.source!.approvals[0].options = [{ id: 'always', label: '永久允许' }]; await offered.coordinator.tick(); assert.equal(offered.state().state, 'human_required'); assert.equal(offered.port.allowed.length, 0, 'always cannot substitute for allow-once');
  }
  {
    const f = fixture(); f.port.plans['dsh-pi'].messages[0].text = verdict('deny'); f.port.plans.codex.messages[0].text = verdict('deny'); f.port.notificationStatus = 'unconfigured';
    await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.port.notifications.length, 1); assert.equal(f.state().notification?.status, 'unconfigured');
    f.port.notificationReady = true; f.port.notificationStatus = 'sent'; await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.port.notifications.length, 2); assert.equal(f.state().notification?.status, 'sent'); assert.equal(f.port.notifications[0].id, f.port.notifications[1].id, 'configuration retry reuses persisted message UUID'); assert.match(f.port.notifications[0].id, /^[a-f0-9-]{36}$/); assert.notEqual(f.port.notifications[0].id, f.state().id); assert.equal(f.coordinator.retryUnconfiguredNotification(f.state().id), false);
    const explicit = fixture(); explicit.port.source!.session.permissionPreset = 'auto'; explicit.port.plans.codex.messages[0].text = verdict('deny'); explicit.port.notificationStatus = 'unconfigured'; await explicit.coordinator.tick();
    assert.equal(explicit.coordinator.retryUnconfiguredNotification(explicit.state().id), true); explicit.port.notificationStatus = 'sent'; await explicit.coordinator.tick(); assert.equal(explicit.port.notifications.length, 2);
    const unknown = fixture(); unknown.port.source!.session.permissionPreset = 'auto'; unknown.port.plans.codex.messages[0].text = verdict('deny'); unknown.port.lostNotify = true;
    await unknown.coordinator.tick(); await unknown.coordinator.tick(); assert.equal(unknown.state().notification?.status, 'unknown'); assert.equal(unknown.port.notifications.length, 1);
  }
  {
    const f = fixture(); f.port.plans['dsh-pi'].status = 'running'; await f.coordinator.tick();
    const saved = JSON.parse(readFileSync(f.file, 'utf8')); saved.records[0].state = 'allowing'; saved.records[0].notification = { status: 'sending', attempts: 1 }; writeFileSync(f.file, JSON.stringify(saved));
    const restored = new ApprovalCoordinator(f.options); await restored.tick(); assert.equal(restored.reviews('p1', 's1')[0].state, 'unknown'); assert.equal(restored.reviews('p1', 's1')[0].notification?.status, 'unknown'); assert.equal(f.port.allowed.length, 0); assert.equal(f.port.notifications.length, 0);
    const broken = join(temp, 'broken.json'); writeFileSync(broken, '{bad'); assert.throws(() => new ApprovalCoordinator({ file: broken, port: f.port }));
  }
  {
    for (const marker of ['执行端未提供变更详情', '详情已截断，请核实完整内容。']) {
      const f = fixture(); f.port.source!.approvals[0].description = `工具审批请求：${marker}`;
      await f.coordinator.tick(); assert.equal(f.state().state, 'human_required'); assert.equal(f.port.created.length, 2); assert.equal(f.port.allowed.length, 0, 'nonempty incomplete descriptions never authorize');
    }
    const version = fixture(); version.port.beforeRead = count => { if (count === 2) { version.port.source!.authorizationVersion = 'direction-2'; version.port.source!.userMessages!.push('新的限制：别删，也先不要执行。'); } };
    await version.coordinator.tick(); assert.equal(version.state().state, 'human_required'); assert.match(version.state().reason, /新的指示/); assert.equal(version.port.allowed.length, 0);
    const waiting = fixture(); waiting.port.plans['dsh-pi'].status = 'running'; await waiting.coordinator.tick();
    waiting.port.source!.authorizationVersion = 'direction-2'; waiting.port.source!.userMessages!.push('别删'); waiting.port.reviewers[0].inspection.status = 'completed';
    await waiting.coordinator.tick(); assert.equal(waiting.state().state, 'human_required'); assert.match(waiting.state().reason, /旧审核结论失效/); assert.equal(waiting.port.allowed.length, 0); assert.equal(waiting.port.created.length, 1);
    assert.ok(!readFileSync(waiting.file, 'utf8').includes('别删'), 'only the ordinary authorization version, not private user directions, is stored');
  }
  {
    const port = new FakePort(); const ordinaryCreate = port.createReviewer.bind(port); let uncertainCreates = 0;
    port.createReviewer = async input => {
      if (input.provider === 'dsh-pi') { uncertainCreates++; return new Promise<{ id: string; title: string; provider: string }>(() => undefined); }
      return ordinaryCreate(input);
    };
    let now = 0; const file = join(temp, `approvals-${++files}.json`);
    const coordinator = new ApprovalCoordinator({ file, port, now: () => now, operationTimeoutMs: 5, reviewTimeoutMs: 120_000 });
    await coordinator.tick(); assert.equal(coordinator.reviews('p1', 's1')[0].reviewers[0].status, 'create_unknown'); assert.equal(port.allowed.length, 0);
    now = 120_001; await coordinator.tick(); assert.equal(coordinator.reviews('p1', 's1')[0].state, 'approved'); assert.equal(uncertainCreates, 1); assert.equal(port.created[0].provider, 'codex', 'hung create times out without replay and can progress to Codex');
  }
  console.log('PASS approval coordinator: DSH/Codex chain, native permissionPreset, strict verdicts, authorization policy/version invalidation, missing/truncated request context, no ACK allow, stale/manual handling, fail-closed loss/timeouts, create reconciliation, single-flight ticks, no reviewer recursion, allow-once only, notification dedup/retry, crash recovery, bounded private persistence');
} finally { rmSync(temp, { recursive: true, force: true }); }
