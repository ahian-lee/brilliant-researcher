import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ResearchWorkbench, sameResearchDirectory, type ResearchRuntime, type LiveSession } from '../packages/core/src/researchWorkbench.ts';
import { registerWorkbenchRoutes } from '../apps/controller/src/workbenchRoutes.ts';
import { ArisReader, loadArisProjectRegistrations } from '../packages/adapters/src/arisReader.ts';
import type { CollaborationRun } from '../packages/core/src/collaborationLoop.ts';

const root = mkdtempSync(join(tmpdir(), 'bri-workbench-'));
const aris = join(root, 'upstream/aris');
for (const id of ['research-pipeline', 'paper-figure']) {
  mkdirSync(join(aris, 'skills', id), { recursive: true });
  writeFileSync(join(aris, 'skills', id, 'SKILL.md'), `---\nname: ${id}\ndescription: test skill\n---\n# Test ${id}\n`);
}
mkdirSync(join(aris, 'tools'));
const config = join(root, 'projects.json');
writeFileSync(config, '{"projects":[],"keep":"existing metadata"}');
let serial = 0; let reads = 0; let sent = ''; let pendingLoss = false; let configured = 0;
let failSend = false; let sends = 0;
let questionSession = ''; let answeredQuestion = '';
const sessions: LiveSession[] = [];
const prompts: Array<string | undefined> = [];
const runtime: ResearchRuntime = {
  async providers() { return [{ id: 'codex', name: 'Codex', available: true }, { id: 'dsh-pi', name: 'DSH', available: true }]; },
  async models() { return [{ id: 'test-model', name: 'Test', thinkingOptions: [{ id: 'high', label: 'High' }] }, { id: 'missing-key', name: 'Missing', available: false, unavailableReason: 'missing credential' }]; },
  async listSessions() { return sessions; },
  async createSession(input) {
    const session = { id: `session-${++serial}`, title: input.title!, provider: input.provider, cwd: input.cwd, model: input.model, permissionPreset: input.permissionPreset, configuredThinkingOptionId: input.thinkingOptionId, status: input.prompt ? 'running' : 'idle' };
    sessions.push(session); prompts.push(input.prompt);
    if (pendingLoss) { pendingLoss = false; throw new Error('write response lost'); }
    return session;
  },
  async inspectSession(id) { reads++; return { session: sessions.find(s => s.id === id)!, messages: [{ id: 'm1', role: 'assistant', text: '真实返回' }], approvals: id === questionSession ? [{id:'question-1',kind:'question',title:'选择格式',description:'SVG 或 PNG',options:[],questions:[{key:'Format',question:'选择格式',options:[{label:'SVG'},{label:'PNG'}],multiSelect:false,allowOther:true,allowEmpty:false}]}] : [] }; },
  async sendMessage(id, message) { sends++; if(failSend) return {accepted:false}; sent = `${id}:${message}`; return { accepted: true }; },
  async interruptSession() { return { ok: true }; },
  async respondApproval() { return { ok: true }; },
  async respondQuestion(id, requestId) { answeredQuestion = `${id}:${requestId}`; return {ok:true}; },
  async updateSession(id, input) { configured++; const session = sessions.find(s => s.id === id)!; session.configuredModel = input.model; session.configuredThinkingOptionId = input.thinkingOptionId; return { ok: true, session }; },
};
const workbench = new ResearchWorkbench({ repoRoot: root, registryFile: config, runtime });
const app = Fastify(); registerWorkbenchRoutes(app, workbench);
const headers = { host: '127.0.0.1:8791', origin: 'http://127.0.0.1:8791', 'content-type': 'application/json', 'x-bri-workbench': '1' };
try {
  assert.equal(sameResearchDirectory('D:\\Research\\x', '/mnt/d/Research/x'), true);
  assert.equal(sameResearchDirectory('/home/a', '/home/ab'), false);
  const payload = { name: '测试研究', goal: '绘图并检查', provider: 'dsh-pi', model: 'test-model', thinkingOptionId: 'high', workflow: 'research-pipeline', constraints: '不访问外部资源' };
  for (const unsafeHeaders of [{ ...headers, origin: 'https://evil.example' }, { ...headers, 'x-bri-workbench': '' }, { ...headers, host: 'evil.example', origin: 'http://evil.example' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/projects', headers: unsafeHeaders, payload })).statusCode, 403);
  }
  assert.equal(sessions.length, 0, 'invalid cross-origin requests never create remote sessions');
  const created = await app.inject({ method: 'POST', url: '/api/workbench/projects', headers, payload });
  assert.equal(created.statusCode, 201, created.body);
  const { project, session } = created.json();
  assert.equal(prompts[0], undefined, 'independent reviewer is created idle');
  assert.match(prompts[1]!, /session-1/);
  assert.match(prompts[1]!, /不访问外部资源/);
  assert.equal(session.provider, 'dsh-pi');
  assert.equal(session.configuredThinkingOptionId, 'high');
  const configUrl = `/api/workbench/projects/${project.id}/sessions/${session.id}/config`;
  assert.equal((await app.inject({ method: 'POST', url: configUrl, headers, payload: { model: 'test-model', thinkingOptionId: 'high' } })).statusCode, 409);
  assert.equal(configured, 0, 'running configuration is never changed');
  sessions.find(s => s.id === session.id)!.status = 'error';
  assert.equal((await app.inject({ method: 'POST', url: configUrl, headers, payload: { model: 'missing-key' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: configUrl, headers, payload: { model: 'test-model', thinkingOptionId: 'made-up' } })).statusCode, 400);
  assert.equal(configured, 0);
  assert.equal((await app.inject({ method: 'POST', url: configUrl, headers, payload: { model: 'test-model', thinkingOptionId: 'high' } })).json().session.configuredThinkingOptionId, 'high');
  assert.equal((await app.inject({ method: 'POST', url: configUrl, headers, payload: { model: null, thinkingOptionId: null } })).json().session.configuredThinkingOptionId, null);
  const projectsBeforeInvalid = JSON.parse(readFileSync(config, 'utf8')).projects.length;
  assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/projects', headers, payload: { ...payload, model: 'missing-key' } })).statusCode, 409);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).projects.length, projectsBeforeInvalid, 'missing credential rejected before creating project');
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).keep, 'existing metadata');
  assert.match(readFileSync(join(project.root, 'RESEARCH_BRIEF.md'), 'utf8'), /绘图并检查/);
  let workspace = await workbench.workspace(project.id);
  assert.equal(workspace.sessions.length, 2);
  writeFileSync(join(project.root,'.aris/progress.json'),JSON.stringify({summary:'已找到资料，正在验证实验环境',blockers:[{id:'b1',title:'实验环境待修复',detail:'缺少依赖'}],questions:[{id:'q1',title:'请选择交付形式',detail:'报告或论文'}]}));
  const currentWorkspace=await workbench.workspace(project.id);
  assert.equal(currentWorkspace.focus.summary,'已找到资料，正在验证实验环境');
  assert.equal(currentWorkspace.focus.questions[0].id,'q1','workbench itself carries the real research questions');
  const decisionsUrl=`/api/workbench/projects/${project.id}/decisions`;
  const decisionBody={questionId:'q1',sessionId:session.id,runId:currentWorkspace.focus.pipeline_run_id,answer:'报告即可'};
  failSend=true;
  assert.equal((await app.inject({method:'POST',url:decisionsUrl,headers,payload:decisionBody})).statusCode,502);
  assert.equal((await workbench.workspace(project.id)).focus.questions.length,1,'rejected delivery never closes a question');
  failSend=false;
  assert.equal((await app.inject({method:'POST',url:decisionsUrl,headers,payload:decisionBody})).json().accepted,true);
  const sendsAfterReply=sends;
  assert.equal((await app.inject({method:'POST',url:decisionsUrl,headers,payload:decisionBody})).json().duplicate,true);
  assert.equal(sends,sendsAfterReply,'duplicate clicks do not send the same decision again');
  const restarted=new ResearchWorkbench({repoRoot:root,registryFile:config,runtime});
  assert.equal((await restarted.workspace(project.id)).focus.questions.length,0,'answer survives backend restart with original open progress still on disk');
  assert.equal((await restarted.workspace(project.id)).focus.answeredQuestions[0].answer,'报告即可');
  assert.equal(new ArisReader([workbench.project(project.id)]).listProjects()[0].human_question_count,0,'sidebar projection agrees with project');
  assert.equal((await workbench.attentionCounts()).projects[project.id].human,0);
  const observations=await workbench.attention(project.id);
  assert.equal(observations.observations.length,2,'running and idle sessions are both observable, not just waiting sessions');
  assert.ok(observations.observations.every(row=>row.session.role),'activity keeps executor/reviewer identity');
  assert.equal(workspace.workflows[0].status, 'pending', 'session creation does not manufacture completed ARIS stages');
  assert.equal(workspace.sessions[0].role, 'reviewer');
  const message = await app.inject({ method: 'POST', url: `/api/workbench/projects/${project.id}/sessions/${session.id}/messages`, headers, payload: { message: '改为蓝色曲线' } });
  assert.equal(message.json().accepted, true);
  assert.ok(sent.startsWith(`${session.id}:项目目录：`)); assert.ok(sent.endsWith('用户消息：\n改为蓝色曲线')); assert.match(sent,/项目已授权的执行范围/);
  sessions.push({ id: 'foreign', title: 'other project', cwd: join(root, 'other'), provider: 'codex', status: 'idle' });
  const readBefore = reads;
  assert.equal((await app.inject({ method: 'GET', url: `/api/workbench/projects/${project.id}/sessions/foreign` })).statusCode, 403);
  assert.equal(reads, readBefore, 'reject cross-project metadata before reading transcript');
  assert.equal((await app.inject({ method: 'POST', url: `/api/workbench/projects/${project.id}/sessions/foreign/messages`, headers, payload: { message: 'forbidden' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workbench/projects/${project.id}/sessions/foreign/config`, headers, payload: { model: null } })).statusCode, 403);
  mkdirSync(join(project.root, 'figures'));
  writeFileSync(join(project.root, 'figures/chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svg = await app.inject({ method: 'GET', url: `/api/workbench/projects/${project.id}/artifact?path=figures/chart.svg` });
  assert.equal(svg.statusCode, 200);
  assert.match(String(svg.headers['content-security-policy']), /sandbox/);
  assert.equal(svg.headers['x-content-type-options'], 'nosniff');
  assert.equal((await app.inject({ method: 'GET', url: `/api/workbench/projects/${project.id}/artifact?path=../../projects.json` })).statusCode, 404);
  pendingLoss = true;
  await assert.rejects(workbench.createSession(project.id, { provider: 'codex', workflow: 'paper-figure' }), /write response lost/);
  const afterLoss = sessions.length;
  workspace = await workbench.workspace(project.id);
  assert.equal(workspace.control?.launch?.state, 'ready', 'reconcile the created remote session after a lost response');
  assert.equal(sessions.length, afterLoss, 'reconciliation must not create a duplicate');
  const freeStart = sessions.length;
  const free = await workbench.createProject({ name: '组件协作', goal: '实现一个组件', provider: 'codex', workflow: 'free' });
  assert.equal(sessions.length, freeStart + 1, 'free work does not force a second reviewer or full pipeline');
  assert.match(readFileSync(join(free.project.root, 'PROJECT_BRIEF.md'), 'utf8'), /自由协作/);
  assert.match(prompts.at(-1)!, /不默认启动完整研究/);
  assert.equal((await workbench.workspace(free.project.id)).workflows.length, 0, 'free project has no invented ARIS stages');
  workbench.options.dshAutoReview = true;
  const ordinaryReviewer = await workbench.createSession(free.project.id, { provider: 'dsh-pi', role: 'reviewer', prompt: '审核组件' });
  assert.equal(ordinaryReviewer.permissionPreset, 'danger-full-access', 'user-created DSH reviewer follows the project access choice');
  const permissionReviewer = await workbench.createSession(free.project.id, { provider: 'dsh-pi', role: 'reviewer', reviewKey: 'BRI approval review test', prompt: 'Only classify, no tools' });
  assert.equal(permissionReviewer.permissionPreset, undefined, 'internal tool reviewer must not recursively trigger Auto');
  assert.equal(prompts.at(-1), 'Only classify, no tools', 'permission reviewer is not told to execute the project task');
  const completionUrl = `/api/workbench/projects/${project.id}/completion`;
  const exportUrl = `/api/workbench/projects/${project.id}/export`;
  for (const unsafeHeaders of [{ ...headers, origin: 'https://evil.example' }, { ...headers, 'x-bri-workbench': '' }]) {
    assert.equal((await app.inject({ method: 'POST', url: completionUrl, headers: unsafeHeaders, payload: { completed: true } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: exportUrl, headers: unsafeHeaders, payload: {} })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: completionUrl, headers, payload: { completed: 'true' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/projects/missing/completion', headers, payload: { completed: true } })).statusCode, 404);
  const originalControl = readFileSync(join(project.root, '.bri/workbench.json'), 'utf8');
  mkdirSync(join(project.root, '.aris/runs'), { recursive: true });
  const scientificState = JSON.stringify({ run_id: 'completion-check', phases: [{ phase: 'writing', status: 'done', artifact: 'REPORT.md' }] });
  writeFileSync(join(project.root, '.aris/runs/completion-check.json'), scientificState);
  const completed = await app.inject({ method: 'POST', url: completionUrl, headers, payload: { completed: true } });
  assert.equal(completed.statusCode, 200);
  const completedAt = completed.json().completedAt;
  assert.ok(Number.isFinite(Date.parse(completedAt)));
  assert.equal((await app.inject({ method: 'POST', url: completionUrl, headers, payload: { completed: true } })).json().completedAt, completedAt, 'repeat completion keeps date stable');
  const reloaded = new ArisReader(loadArisProjectRegistrations(config, root));
  assert.equal(reloaded.listProjects().find(item => item.id === project.id)?.completed_at, completedAt, 'completion survives reader reload');
  assert.equal(reloaded.overview(project.id).project.completed_at, completedAt);
  assert.equal(reloaded.overview(project.id).tasks[0].verdict, 'pending', 'user completion does not manufacture scientific acceptance');
  assert.equal(reloaded.listProjects().find(item => item.id === free.project.id)?.completed_at, null, 'other project unchanged');
  assert.equal(readFileSync(join(project.root, '.bri/workbench.json'), 'utf8'), originalControl, 'session bindings unchanged');
  assert.equal(readFileSync(join(project.root, '.aris/runs/completion-check.json'), 'utf8'), scientificState);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).keep, 'existing metadata');
  const archive = await app.inject({ method: 'POST', url: exportUrl, headers, payload: { root: root } });
  assert.equal(archive.statusCode, 200, archive.body.slice(0, 100));
  assert.equal(archive.headers['content-type'], 'application/zip');
  assert.match(String(archive.headers['content-disposition']), /attachment;.*filename\*=UTF-8''/);
  assert.equal(archive.rawPayload.readUInt32LE(0), 0x04034b50);
  assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/projects/missing/export', headers, payload: {} })).statusCode, 404);
  const restored = await app.inject({ method: 'POST', url: completionUrl, headers, payload: { completed: false } });
  assert.equal(restored.json().completedAt, null);
  assert.equal(workbench.project(project.id).completed_at, null);
  questionSession = session.id;
  sessions.find(item => item.id === session.id)!.status = 'waiting_input';
  const inbox = await app.inject({ method:'GET',url:`/api/workbench/projects/${project.id}/attention`,headers:{host:headers.host} });
  assert.equal(inbox.statusCode,200);
  assert.equal(inbox.json().pending.length,1);
  assert.equal(inbox.json().pending[0].approvals[0].kind,'question');
  assert.equal((await workbench.attentionCounts()).projects[project.id].human,2,'new-round recorded question plus native question contribute to sidebar count');
  const questionUrl = `/api/workbench/projects/${project.id}/sessions/${session.id}/questions/question-1`;
  assert.equal((await app.inject({method:'POST',url:questionUrl,headers:{...headers,origin:'https://evil.example'},payload:{answers:{Format:{selected:['SVG']}}}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/api/workbench/projects/${project.id}/sessions/foreign/questions/question-1`,headers,payload:{answers:{}}})).statusCode,403);
  assert.equal(answeredQuestion,'','unauthorized question cannot be answered');
  assert.equal((await app.inject({method:'POST',url:questionUrl,headers,payload:{answers:{Format:{selected:['SVG']}}}})).statusCode,200);
  assert.equal(answeredQuestion,`${session.id}:question-1`);
  const answeredHistory = await workbench.attention(project.id);
  assert.ok(answeredHistory.recent.some((item: any) => item.review.state === 'answered' && item.review.reason === 'SVG'), 'accepted question answers retain a visible history');
  {
    const followup = await workbench.createProject({ ...payload, name: '续跑决定回归' });
    const decisionWorkbench = new ResearchWorkbench({ repoRoot: root, registryFile: config, runtime });
    const bound = decisionWorkbench.control(followup.project)!.sessions;
    const activeRun = { id: 'decision-loop', state: 'executing', revision: 1, round: 1, updatedAt: Date.now(), executorSessionId: followup.session.id, reviewerSessionId: bound.find(s=>s.role==='reviewer')!.id } as CollaborationRun;
    decisionWorkbench.collaborationStatus = () => activeRun;
    const progressFile = join(followup.project.root, '.aris/progress.json');
    const question = {id:'followup-choice',title:'是否保留现有实验',detail:'保留或重跑',status:'open'};
    const writeRevision = () => {
      const runId = `followup-${activeRun.id}-r${activeRun.revision}`;
      mkdirSync(join(followup.project.root,'.aris/runs'),{recursive:true});
      writeFileSync(join(followup.project.root,`.aris/runs/${runId}.json`),JSON.stringify({run_id:runId,created:new Date().toISOString(),updated:new Date().toISOString(),phases:[{phase:'experiment-bridge',status:'running'},{phase:'summary',status:'pending'}]}));
      writeFileSync(progressFile,JSON.stringify({run_id:runId,workbench_iteration:true,questions:[question]}));
    };
    writeRevision();
    decisionWorkbench.steerCollaboration = async () => { activeRun.revision++; writeRevision(); return activeRun; };
    const originalRunId = `followup-${activeRun.id}-r1`;
    assert.equal((await decisionWorkbench.workspace(followup.project.id)).focus.questions.length,1);
    const answer = await decisionWorkbench.answerRecordedQuestion(followup.project.id,{questionId:question.id,sessionId:followup.session.id,runId:originalRunId,answer:'保留现有实验'});
    assert.equal(answer.accepted,true);
    assert.equal(activeRun.revision,2,'answer steers the active follow-up before it is recorded');
    assert.equal(answer.decision.runId,originalRunId,'original decision provenance is preserved');
    const current = await decisionWorkbench.workspace(followup.project.id);
    assert.equal(current.focus.pipeline_run_id,`followup-${activeRun.id}-r2`);
    assert.equal(current.focus.questions.length,0,'answered follow-up question does not become pending again in the new revision');
    const reloadedDecision = new ResearchWorkbench({ repoRoot: root, registryFile: config, runtime });
    assert.equal((await reloadedDecision.workspace(followup.project.id)).focus.questions.length,0,'decision applies to the new follow-up revision after restart');
    const foreignRunId='followup-other-loop-r1';
    writeFileSync(join(followup.project.root,`.aris/runs/${foreignRunId}.json`),JSON.stringify({run_id:foreignRunId,created:new Date().toISOString(),updated:new Date().toISOString(),phases:[{phase:'experiment-bridge',status:'running'},{phase:'summary',status:'pending'}]}));
    writeFileSync(progressFile,JSON.stringify({run_id:foreignRunId,workbench_iteration:true,questions:[question]}));
    assert.equal((await reloadedDecision.workspace(followup.project.id)).focus.questions.length,1,'a same-named question in a different collaboration remains pending');
  }
  const outside = join(root, 'outside'); mkdirSync(outside);
  const controlFile = join(project.root, '.bri/workbench.json');
  const before = readFileSync(controlFile, 'utf8');
  rmSync(join(project.root, '.bri'), { recursive: true });
  symlinkSync(outside, join(project.root, '.bri'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => workbench.control(workbench.project(project.id)), /项目之外/);
  assert.ok(before.includes(session.id));
  console.log('PASS research workbench: real route contracts, create+idle reviewer, scoped chat, origin checks, artifact sandbox, lost-response recovery, symlink boundary');
} finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
