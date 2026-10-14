import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaseoRuntime, PaseoRuntimeError } from '../packages/adapters/src/paseoRuntime.ts';

const fixture = mkdtempSync(join(tmpdir(), 'bri-paseo-runtime-'));
const cliPath = join(fixture, 'bin', 'paseo');
const home = join(fixture, 'home');
mkdirSync(join(fixture, 'bin'), { recursive: true });
mkdirSync(join(fixture, 'dist', 'utils'), { recursive: true });
mkdirSync(home);
writeFileSync(cliPath, '// mock CLI installation marker');
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(join(home, 'state.json'), JSON.stringify({ sessions: [], messages: [], resolutions: [], cancellations: [] }));
writeFileSync(join(fixture, 'dist', 'utils', 'client.js'), String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function connectToDaemon(options) {
  if (options.target.kind !== 'instance') throw Error('Expected explicit private home');
  const file = join(options.target.home, 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const save = () => writeFileSync(file, JSON.stringify(state));
  state.activeConnections = (state.activeConnections ?? 0) + 1;
  state.maximumActive = Math.max(state.maximumActive ?? 0, state.activeConnections);
  state.processStarts = [...(state.processStarts ?? []), process.pid];
  state.events ??= [];
  save();
  const get = (id) => state.sessions.find((a) => a.id === id || a.id.startsWith(id));
  return {
    close: async () => { const current = JSON.parse(readFileSync(file, 'utf8')); current.activeConnections -= 1; writeFileSync(file, JSON.stringify(current)); },
    getProvidersSnapshot: async () => ({ entries: [
      { provider: 'codex', label: 'Codex', enabled: true, status: 'ready' },
      { provider: 'dsh-pi', label: 'DeepSeek Harness', enabled: true, status: 'ready' },
      { provider: 'disabled', enabled: false, status: 'ready' },
    ] }),
    getLastServerInfoMessage: () => ({ features: { agentConfigApply: !state.disableConfigUpdates } }),
    listProviderModels: async (provider) => {
      state.events.push('models:' + provider); save();
      if (provider === 'queue-slow') await new Promise((resolve) => setTimeout(resolve, 200));
      if (provider === 'queue-fail') { await new Promise((resolve) => setTimeout(resolve, 100)); return { error: 'Queued provider failure' }; }
      if (provider === 'slow') await new Promise((resolve) => setTimeout(resolve, 5000));
      if (provider === 'large') return { models: [{ id: 'large', label: 'x'.repeat(20000) }] };
      if (provider === 'bad') return { error: 'Provider unavailable' };
      if (provider === 'secret') throw Error('password=private-secret token=another-secret');
      if (provider === 'codex') return { models: [
        { id: 'review-model', label: 'Reviewer model', isDefault: true, thinkingOptions: [
          { id: 'low', label: 'Low', description: 'Less reasoning' }, { id: 'high', label: 'High', isDefault: true },
        ], defaultThinkingOptionId: 'high' },
        { id: 'another-model', label: 'Another model', thinkingOptions: [{ id: 'off', label: 'Off', isDefault: true }], defaultThinkingOptionId: 'off' },
      ] };
      return { models: [{ id: provider + '/model', label: provider + ' model' }] };
    },
    createWorkspace: async (options) => {
      state.workspace = options; save();
      return { workspace: { id: 'workspace-1', workspaceDirectory: options.source.path } };
    },
    createAgent: async (options) => {
      if (options.provider === 'broken') throw Error('Unavailable provider');
      if (options.featureValues?.permissionPreset && !state.nativeAutoSupported) throw Error('Unknown DSH permission preset: auto');
      const agent = { ...options, currentModeId:options.modeId ?? 'auto', availableModes:[{id:'auto'},{id:'full-access'}], id: 'session-' + (state.sessions.length + 1), status: options.initialPrompt ? 'running' : 'idle',
        effectiveThinkingOptionId: options.thinkingOptionId ?? null,
        runtimeInfo: { model: options.model ?? null, thinkingOptionId: options.thinkingOptionId ?? null },
        features: options.provider === 'dsh-pi' ? [{ id: 'permissionPreset', type: 'select',
          value: state.ignoreAutoCreation ? 'default' : options.featureValues?.permissionPreset ?? 'default',
          options: [{ id: 'default', label: 'Default' }, ...(state.nativeAutoSupported ? [{ id: 'auto', label: 'Auto' }, {id:'danger-full-access',label:'Full access'}] : [])],
        }] : [],
        pendingPermissions: [{ id: 'permission-1', kind: 'tool', name: 'write', title: 'Write file?',
          actions: [{ id: 'allow-once', label: 'Allow once', behavior: 'allow' }, { id: 'reject', label: 'Reject', behavior: 'deny' }] }],
      };
      if (!options.initialPrompt) agent.pendingPermissions = [];
      if (options.provider === 'question') agent.pendingPermissions = [{ id: 'question-1', kind: 'question', actions: [{ id: 'yes', label: 'Yes', behavior: 'allow' }] }];
      if (options.provider === 'structured-question') agent.pendingPermissions = [{id:'question-2',kind:'question',title:'需要选择交付格式',input:{questions:[
        {header:'Format',question:'主图导出什么格式？',options:[{label:'SVG',description:'可编辑矢量图'},{label:'PNG'}],multiSelect:false,allowOther:true},
        {header:'Extras',question:'补充材料包含哪些？',options:[{label:'代码'},{label:'数据'}],multiSelect:true,allowOther:false},
      ]},metadata:{token:'question-metadata-secret'}}];
      if (options.provider === 'fallback') delete agent.pendingPermissions[0].actions;
      if (options.provider === 'empty-actions') agent.pendingPermissions[0].actions = [];
      if (options.provider === 'edit-details') agent.pendingPermissions = [{ id: 'permission-edit-1', name: 'CodexFileChange', kind: 'tool', title: 'Apply file changes', metadata: { itemId: 'edit-1', password: 'metadata-secret-must-not-export' } }];
      if (options.provider === 'command-details') agent.pendingPermissions = [{ id: 'permission-command-1', name: 'CodexBash', kind: 'tool', title: 'Run read command', description: '请核实命令', input: { command: 'Get-Content PROJECT_BRIEF.md; token=command-secret', cwd: options.cwd, privateField: 'input-secret-must-not-export' } }];
      if (options.provider === 'acp-details') agent.pendingPermissions = [{ id: 'acp-random-id', name: 'pwsh', kind: 'tool', title: 'Allow pwsh?', detail: { type: 'unknown', input: { command: 'pwsh', args: ['-Command', 'Get-Content PROJECT_BRIEF.md; token=acp-secret'], cwd: options.cwd, reason: 'reason-must-not-be-treated-as-command' } }, metadata: { toolCallId: 'acp-call-1', rawRequest: { toolCall: { rawInput: { password: 'raw-request-secret' } } } } }];
      if (options.provider === 'acp-linked') agent.pendingPermissions = [{ id: 'acp-random-linked', name: 'pwsh', kind: 'tool', title: 'Allow pwsh?', input: { callId: 'acp-call-1' } }];
      if (options.provider === 'no-cwd') delete agent.cwd;
      state.sessions.push(agent); save(); return agent;
    },
    fetchAgent: async ({ agentId }) => ({ agent: get(agentId) ?? null }),
    applyAgentConfig: async (id, config) => {
      state.events.push('update:' + id); state.updates ??= []; state.updates.push({ id, config });
      const agent = get(id);
      if (!state.ignoreConfigUpdates) {
        if (config.modeId !== undefined) agent.currentModeId=config.modeId;
        if (config.modelId !== undefined) { agent.model = config.modelId; agent.runtimeInfo = { ...agent.runtimeInfo, model: config.modelId }; }
        if (config.featureValues?.permissionPreset !== undefined && !state.ignorePresetUpdates) {
          agent.features.find((f) => f.id === 'permissionPreset').value = config.featureValues.permissionPreset;
        }
        if (state.partialUpdateFailure) { save(); throw Error('Provider rejected remaining update'); }
        if (config.thinkingOptionId !== undefined) {
          const thinking = config.thinkingOptionId ?? (agent.model === 'another-model' ? 'off' : 'high');
          agent.thinkingOptionId = thinking; agent.effectiveThinkingOptionId = thinking;
          agent.runtimeInfo = { ...agent.runtimeInfo, thinkingOptionId: thinking };
        }
      }
      save(); return null;
    },
    fetchAgents: async (options) => {
      const start = options.page.cursor ? Number(options.page.cursor) : 0;
      const entries = state.sessions.slice(start, start + 1).map((agent) => ({ agent }));
      return { entries, pageInfo: { hasMore: start + 1 < state.sessions.length, nextCursor: String(start + 1) } };
    },
    sendAgentMessage: async (id, text) => { state.events.push('send:' + text); state.messages.push({ id, text }); save(); },
    fetchAgentTimeline: async (id, options) => {
      if (options.limit !== 200) throw Error('Unbounded transcript');
      return { epoch: 'epoch-1', hasOlder: true, entries: [
        { item: { type: 'user_message', text: 'hello' }, timestamp: '2026-10-13T00:00:00Z', seqStart: 1 },
        { item: { type: 'tool_call', name: 'private-tool' }, seqStart: 2 },
        { item: { type: 'tool_call', callId: 'unrelated-edit', detail: { type: 'edit', filePath: 'wrong-project-path', unifiedDiff: 'UNRELATED_DIFF_MUST_NOT_EXPORT' } }, seqStart: 4 },
        { item: { type: 'tool_call', callId: 'edit-1', detail: { type: 'edit', filePath: 'figures/main.svg', unifiedDiff: '-fill="blue"\n+fill="red"\n+api_key=diff-secret\n' + 'x'.repeat(14000) } }, seqStart: 5 },
        { item: { type: 'tool_call', callId: 'acp-call-1', detail: { type: 'unknown', input: { raw: JSON.stringify({command:'Get-Content PROJECT_BRIEF.md',workdir:'mock-acp-cwd'}) } } }, seqStart: 6 },
        { item: {type:'tool_call',callId:'read-path',name:'read',status:'completed',detail:{type:'read',filePath:'',content:'<path>project/results.json</path>never-render-file-body'}},seqStart:7 },
        { item: { type: 'assistant_message', text: 'observed reply' }, timestamp: '2026-10-13T00:00:01Z', seqStart: 3 },
      ] };
    },
    cancelAgent: async (id) => { state.cancellations.push(id); save(); },
    respondToPermissionAndWait: async (id, permission, response) => { state.resolutions.push({ id, permission, response }); save(); },
  };
}
`);

const readState = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
const runtime = new PaseoRuntime({ cliPath, home, timeoutMs: 5000 });
const rejectsCode = async (work: Promise<unknown>, code: string) => {
  await assert.rejects(work, (error: unknown) => error instanceof PaseoRuntimeError && error.code === code);
};

try {
  assert.deepEqual((await runtime.providers()).map((p) => [p.id, p.available]), [['codex', true], ['dsh-pi', true], ['disabled', false]]);
  assert.deepEqual(await runtime.models('dsh-pi'), [{ id: 'dsh-pi/model', name: 'dsh-pi model', thinkingOptions: [] }]);
  const codexModels = await runtime.models('codex');
  assert.deepEqual(codexModels[0].thinkingOptions.map((o) => o.id), ['low', 'high']);
  assert.deepEqual(codexModels[1].thinkingOptions.map((o) => o.id), ['off']);
  assert.equal(codexModels[0].defaultThinkingOptionId, 'high');
  await rejectsCode(runtime.models('bad'), 'PROVIDER_ERROR');
  await assert.rejects(runtime.models('secret'), (error: Error) => !error.message.includes('private-secret') && !error.message.includes('another-secret'));

  const reviewer = await runtime.createSession({ cwd: fixture, provider: 'codex', model: 'review-model', thinkingOptionId: 'high', title: 'Reviewer' });
  assert.equal(reviewer.status, 'idle');
  assert.equal(reviewer.cwd, fixture);
  assert.equal(reviewer.model, 'review-model');
  assert.equal(reviewer.configuredThinkingOptionId, 'high');
  assert.equal(reviewer.thinkingOptionId, 'high');
  assert.equal(readState().sessions[0].thinkingOptionId, 'high');
  assert.equal(Object.hasOwn(readState().sessions[0], 'initialPrompt'), false);
  await rejectsCode(runtime.createSession({ cwd: fixture, provider: 'codex', model: 'another-model', thinkingOptionId: 'high' }), 'INVALID_THINKING_OPTION');
  const changed = await runtime.updateSession(reviewer.id, { cwd: fixture, model: 'another-model', thinkingOptionId: 'off' });
  assert.equal(changed.ok, true);
  assert.equal(changed.session.configuredModel, 'another-model');
  assert.equal(changed.session.runtimeModel, 'another-model');
  assert.equal(changed.session.thinkingOptionId, 'off');
  assert.deepEqual(readState().updates.at(-1).config, { modelId: 'another-model', thinkingOptionId: 'off' });
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'high' }), 'INVALID_THINKING_OPTION');
  await rejectsCode(runtime.updateSession('session-', { cwd: fixture, model: 'review-model' }), 'SESSION_NOT_FOUND');
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: join(fixture, 'other'), model: 'review-model' }), 'CWD_MISMATCH');
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, model: 'not-in-catalog' }), 'INVALID_MODEL');
  assert.throws(() => runtime.updateSession(reviewer.id, { cwd: fixture }), /change is required/);
  const reset = await runtime.updateSession(reviewer.id, { cwd: fixture, model: null, thinkingOptionId: null });
  assert.equal(reset.session.configuredModel, null);
  assert.equal(reset.session.thinkingOptionId, 'high');
  await runtime.updateSession(reviewer.id, { cwd: fixture, model: 'review-model', thinkingOptionId: 'high' });
  const ignored = readState(); ignored.ignoreConfigUpdates = true; writeFileSync(join(home, 'state.json'), JSON.stringify(ignored));
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, model: 'another-model', thinkingOptionId: 'off' }), 'UPDATE_UNVERIFIED');
  const partial = readState(); partial.ignoreConfigUpdates = false; partial.partialUpdateFailure = true; writeFileSync(join(home, 'state.json'), JSON.stringify(partial));
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, model: 'another-model', thinkingOptionId: 'off' }), 'UPDATE_FAILED');
  assert.equal(readState().sessions[0].model, 'another-model');
  const unsupported = readState(); unsupported.partialUpdateFailure = false; unsupported.disableConfigUpdates = true; writeFileSync(join(home, 'state.json'), JSON.stringify(unsupported));
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'off' }), 'UNSUPPORTED');
  const enabled = readState(); enabled.disableConfigUpdates = false; writeFileSync(join(home, 'state.json'), JSON.stringify(enabled));
  await runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'off' });
  const updatesBeforeBusy = readState().updates.length;
  for (const status of ['running', 'starting', 'queued', 'waiting_input', 'unknown']) {
    const busy = readState(); busy.sessions[0].status = status; writeFileSync(join(home, 'state.json'), JSON.stringify(busy));
    await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'off' }), 'SESSION_BUSY');
  }
  const approvalBusy = readState(); approvalBusy.sessions[0].status = 'idle'; approvalBusy.sessions[0].pendingPermissions = [{ id: 'pending', kind: 'tool' }]; writeFileSync(join(home, 'state.json'), JSON.stringify(approvalBusy));
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'off' }), 'SESSION_BUSY');
  const turnBusy = readState(); turnBusy.sessions[0].pendingPermissions = []; turnBusy.sessions[0].activeTurn = { turnId: 'active' }; writeFileSync(join(home, 'state.json'), JSON.stringify(turnBusy));
  await rejectsCode(runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'off' }), 'SESSION_BUSY');
  const inactive = readState(); inactive.sessions[0].activeTurn = null; writeFileSync(join(home, 'state.json'), JSON.stringify(inactive));
  assert.equal(inactive.updates.length, updatesBeforeBusy);
  const failedAgent = readState(); failedAgent.sessions[0].status = 'error'; writeFileSync(join(home, 'state.json'), JSON.stringify(failedAgent));
  assert.equal((await runtime.updateSession(reviewer.id, { cwd: fixture, thinkingOptionId: 'off' })).ok, true, 'a settled credential failure can be reconfigured');

  const prompt = 'Treat $(whoami), `echo private`, --home and "quotes" as literal text.\n第二行';
  const worker = await runtime.createSession({ cwd: fixture, provider: 'dsh-pi', prompt, title: 'Worker' });
  assert.equal(worker.status, 'waiting_input');
  await rejectsCode(runtime.updateSession(worker.id, { cwd: fixture, model: 'dsh-pi/model' }), 'SESSION_BUSY');
  assert.equal(readState().sessions[1].initialPrompt, prompt);
  assert.equal(readState().workspace.source.kind, 'directory');
  assert.equal(Object.hasOwn(readState().sessions[1], 'modeId'), false);
  assert.deepEqual(await runtime.sendMessage(worker.id, prompt), { accepted: true, status: 'accepted' });
  assert.equal(readState().messages[0].text, prompt);
  const inspection = await runtime.inspectSession(worker.id);
  assert.deepEqual(inspection.messages.map((m) => [m.role, m.text]), [['user', 'hello'], ['assistant', 'observed reply']]);
  assert.equal(inspection.hasOlderMessages, true);
  assert.ok(inspection.activity?.some(item=>item.summary==='读取文件 · results.json'&&item.status==='completed'&&item.target==='project/results.json'));
  assert.ok(!JSON.stringify(inspection.activity).includes('never-render-file-body'),'activity only displays paths, never arbitrary file contents');
  assert.equal(inspection.session.cwd, fixture);
  assert.equal(inspection.session.status, 'waiting_input');
  assert.deepEqual(inspection.approvals[0].options.map((o) => o.id), ['allow-once', 'reject']);
  assert.match(inspection.approvals[0].description, /执行端未提供变更详情/);
  assert.equal((await runtime.listSessions(fixture)).length, 2);
  assert.deepEqual(await runtime.listSessions(join(fixture, 'different-project')), []);
  const presetState = readState(); presetState.nativeAutoSupported = true; writeFileSync(join(home, 'state.json'), JSON.stringify(presetState));
  const nativeAuto = await runtime.createSession({ cwd: fixture, provider: 'dsh-pi', permissionPreset: 'auto' });
  assert.equal(nativeAuto.permissionPreset, 'auto');
  const nativeConfig = readState().sessions.find((s: { id: string }) => s.id === nativeAuto.id);
  assert.deepEqual(nativeConfig.featureValues, { permissionPreset: 'auto' });
  assert.equal(Object.hasOwn(nativeConfig, 'modeId'), false);
  const changedPreset = await runtime.updateSession(nativeAuto.id, { cwd: fixture, permissionPreset: 'auto' });
  assert.equal(changedPreset.session.permissionPreset, 'auto');
  assert.deepEqual(readState().updates.at(-1).config, { featureValues: { permissionPreset: 'auto' } });
  await rejectsCode(runtime.createSession({ cwd: fixture, provider: 'codex', permissionPreset: 'auto' }), 'UNSUPPORTED_PERMISSION_PRESET');
  await rejectsCode(runtime.createSession({ cwd: fixture, provider: 'dsh-pi', permissionPreset: 'full-access' as 'auto' }), 'INVALID_PERMISSION_PRESET');
  assert.throws(() => runtime.createSession({ cwd: fixture, provider: 'dsh-pi', modeId: 'auto' } as never), /permissionPreset/);
  await rejectsCode(runtime.updateSession(nativeAuto.id, { cwd: fixture, modeId: 'auto' }), 'INVALID_MODE');
  const missingAuto = readState(); missingAuto.nativeAutoSupported = false; missingAuto.sessions.find((s: { id: string }) => s.id === nativeAuto.id).features[0].options = [{ id: 'default', label: 'Default' }]; writeFileSync(join(home, 'state.json'), JSON.stringify(missingAuto));
  await rejectsCode(runtime.createSession({ cwd: fixture, provider: 'dsh-pi', permissionPreset: 'auto' }), 'SESSION_CREATE_FAILED');
  await rejectsCode(runtime.updateSession(nativeAuto.id, { cwd: fixture, permissionPreset: 'auto' }), 'UNSUPPORTED_PERMISSION_PRESET');
  const ignoresAuto = readState(); ignoresAuto.nativeAutoSupported = true; ignoresAuto.ignoreAutoCreation = true; writeFileSync(join(home, 'state.json'), JSON.stringify(ignoresAuto));
  await assert.rejects(runtime.createSession({ cwd: fixture, provider: 'dsh-pi', permissionPreset: 'auto' }), (error: PaseoRuntimeError) => error.code === 'PERMISSION_PRESET_UNVERIFIED' && error.message.includes('Session session-'));
  const presetMismatch = readState(); presetMismatch.ignoreAutoCreation = false; presetMismatch.ignorePresetUpdates = true; const existingPreset = presetMismatch.sessions.find((s: { id: string }) => s.id === nativeAuto.id).features[0]; existingPreset.value = 'default'; existingPreset.options.push({ id: 'auto', label: 'Auto' }); writeFileSync(join(home, 'state.json'), JSON.stringify(presetMismatch));
  await rejectsCode(runtime.updateSession(nativeAuto.id, { cwd: fixture, permissionPreset: 'auto' }), 'PERMISSION_PRESET_UNVERIFIED');
  const presetReady = readState(); presetReady.ignorePresetUpdates = false; writeFileSync(join(home, 'state.json'), JSON.stringify(presetReady));
  await runtime.updateSession(nativeAuto.id, { cwd: fixture, permissionPreset: 'auto' });

  // No fuzzy IDs, stale approval IDs, or invented allow choices can reach a write.
  await rejectsCode(runtime.sendMessage('session-', 'must not send'), 'SESSION_NOT_FOUND');
  await rejectsCode(runtime.respondApproval(worker.id, 'gone', 'allow-once'), 'APPROVAL_NOT_FOUND');
  await rejectsCode(runtime.respondApproval(worker.id, 'permission-1', 'invented'), 'INVALID_APPROVAL_OPTION');
  assert.deepEqual(readState().resolutions, []);
  assert.deepEqual(await runtime.respondApproval(worker.id, 'permission-1', 'reject'), { ok: true });
  assert.equal(readState().resolutions[0].response.behavior, 'deny');
  assert.equal(readState().resolutions[0].response.selectedActionId, 'reject');
  assert.deepEqual(await runtime.interruptSession(reviewer.id), { ok: true });
  assert.deepEqual(readState().cancellations, []);
  await runtime.interruptSession(worker.id);
  assert.deepEqual(readState().cancellations, [worker.id]);

  const question = await runtime.createSession({ cwd: fixture, provider: 'question' });
  const questionInspection = await runtime.inspectSession(question.id);
  assert.equal(questionInspection.approvals[0].unsupported, true);
  assert.deepEqual(questionInspection.approvals[0].options, []);
  await rejectsCode(runtime.respondApproval(question.id, 'question-1', 'yes'), 'UNSUPPORTED');
  assert.equal(questionInspection.session.status, 'waiting_input');
  assert.equal(questionInspection.approvals[0].kind, 'question');
  const form = await runtime.createSession({cwd:fixture,provider:'structured-question'});
  const formDetail = await runtime.inspectSession(form.id);
  assert.equal(formDetail.approvals[0].unsupported, undefined);
  assert.equal(formDetail.approvals[0].questions?.[0].question, '主图导出什么格式？');
  assert.equal(formDetail.approvals[0].questions?.[0].options[0].description, '可编辑矢量图');
  assert.ok(!JSON.stringify(formDetail).includes('question-metadata-secret'));
  const validAnswers = {Format:{selected:['SVG']},Extras:{selected:['代码','数据']}};
  const resolutionCount = readState().resolutions.length;
  await rejectsCode(runtime.respondQuestion(form.id,'question-2',{}), 'INVALID_ANSWER');
  await rejectsCode(runtime.respondQuestion(form.id,'question-2',{...validAnswers,Format:{selected:['made-up']}}), 'INVALID_ANSWER');
  await rejectsCode(runtime.respondQuestion(form.id,'question-2',{...validAnswers,Format:{selected:['SVG','PNG']}}), 'INVALID_ANSWER');
  await rejectsCode(runtime.respondQuestion(form.id,'gone',validAnswers), 'APPROVAL_NOT_FOUND');
  await rejectsCode(runtime.respondQuestion(worker.id,'permission-1',validAnswers), 'INVALID_QUESTION');
  assert.equal(readState().resolutions.length,resolutionCount,'invalid answers must never resolve a request');
  await runtime.respondQuestion(form.id,'question-2',validAnswers);
  assert.deepEqual(readState().resolutions.at(-1).response,{behavior:'allow',updatedInput:{answers:{Format:'SVG',Extras:'代码, 数据'}}});
  await runtime.respondQuestion(form.id,'question-2',{...validAnswers,Format:{selected:[],text:'PDF'}});
  assert.equal(readState().resolutions.at(-1).response.updatedInput.answers.Format,'PDF');
  await runtime.respondQuestion(form.id,'question-2',{},true);
  assert.equal(readState().resolutions.at(-1).response.behavior,'deny');
  const editSession = await runtime.createSession({ cwd: fixture, provider: 'edit-details' });
  const editApproval = (await runtime.inspectSession(editSession.id)).approvals[0];
  assert.match(editApproval.description, /figures\/main\.svg/);
  assert.match(editApproval.description, /-fill="blue"\n\+fill="red"/);
  assert.match(editApproval.description, /\[redacted\]/);
  assert.match(editApproval.description, /详情已截断/);
  assert.ok(editApproval.description.length <= 12000);
  for (const secret of ['diff-secret', 'metadata-secret-must-not-export', 'UNRELATED_DIFF_MUST_NOT_EXPORT', 'wrong-project-path']) assert.equal(editApproval.description.includes(secret), false);
  const commandSession = await runtime.createSession({ cwd: fixture, provider: 'command-details' });
  const commandApproval = (await runtime.inspectSession(commandSession.id)).approvals[0];
  assert.match(commandApproval.description, /请核实命令/);
  assert.match(commandApproval.description, /Get-Content PROJECT_BRIEF\.md/);
  assert.ok(commandApproval.description.includes(fixture));
  assert.equal(commandApproval.description.includes('command-secret'), false);
  assert.equal(commandApproval.description.includes('input-secret-must-not-export'), false);
  for (const provider of ['acp-details', 'acp-linked']) {
    const acp = await runtime.createSession({ cwd: fixture, provider });
    const approval = (await runtime.inspectSession(acp.id)).approvals[0];
    assert.match(approval.description, /Get-Content PROJECT_BRIEF\.md/);
    assert.equal(approval.description.includes('acp-secret'), false);
    assert.equal(approval.description.includes('raw-request-secret'), false);
    assert.equal(approval.description.includes('reason-must-not-be-treated-as-command'), false);
    if (provider === 'acp-details') assert.match(approval.description, /pwsh -Command/);
  }
  for (const provider of ['fallback', 'empty-actions']) {
    const ordinary = await runtime.createSession({ cwd: fixture, provider, prompt: 'Read project brief' });
    const observed = await runtime.inspectSession(ordinary.id);
    assert.equal(observed.session.status, 'waiting_input');
    assert.equal(observed.approvals[0].unsupported, undefined);
    assert.deepEqual(observed.approvals[0].options.map((o) => o.id), ['reject', 'allow-once']);
    await rejectsCode(runtime.respondApproval(ordinary.id, 'permission-1', 'allow-always'), 'INVALID_APPROVAL_OPTION');
    await runtime.respondApproval(ordinary.id, 'permission-1', 'allow-once');
    assert.deepEqual(readState().resolutions.at(-1).response, { behavior: 'allow' });
    await runtime.respondApproval(ordinary.id, 'permission-1', 'reject');
    assert.deepEqual(readState().resolutions.at(-1).response, { behavior: 'deny' });
    await runtime.interruptSession(ordinary.id);
    assert.equal(readState().cancellations.at(-1), ordinary.id);
  }
  const fullDsh = await runtime.createSession({cwd:fixture,provider:'dsh-pi',permissionPreset:'danger-full-access'});
  assert.equal(fullDsh.permissionPreset,'danger-full-access');
  const fullCodex = await runtime.createSession({cwd:fixture,provider:'codex',modeId:'full-access'});
  assert.equal(fullCodex.modeId,'full-access');
  assert.equal((await runtime.updateSession(fullCodex.id,{cwd:fixture,modeId:'auto'})).session.modeId,'auto');
  assert.equal((await runtime.updateSession(fullCodex.id,{cwd:fixture,modeId:'full-access'})).session.modeId,'full-access');
  const orphan = await runtime.createSession({ cwd: fixture, provider: 'no-cwd' });
  assert.equal(orphan.cwd, '');
  await rejectsCode(runtime.sendMessage(orphan.id, 'must not send'), 'MISSING_CWD');
  await rejectsCode(runtime.interruptSession(orphan.id), 'MISSING_CWD');
  await rejectsCode(runtime.updateSession(orphan.id, { cwd: fixture, thinkingOptionId: 'high' }), 'MISSING_CWD');
  await rejectsCode(runtime.createSession({ cwd: fixture, provider: 'broken' }), 'SESSION_CREATE_FAILED');
  // Real mock subprocesses record active connections and observed operation order.
  // Equivalent concurrent reads share work across runtime instances, while two
  // identical queued messages still produce two distinct daemon deliveries.
  const peer = new PaseoRuntime({ home, cliPath, timeoutMs: 5000 });
  const beforeQueue = readState();
  const firstRead = runtime.models('queue-slow');
  const sameRead = peer.models('queue-slow');
  const nextRead = runtime.models('queue-next');
  const firstWrite = runtime.sendMessage(worker.id, 'queued message');
  const secondWrite = peer.sendMessage(worker.id, 'queued message');
  await Promise.all([firstRead, sameRead, nextRead, firstWrite, secondWrite]);
  const afterQueue = readState();
  assert.equal(afterQueue.maximumActive, 1);
  assert.equal(afterQueue.activeConnections, 0);
  assert.equal(afterQueue.processStarts.length - beforeQueue.processStarts.length, 4);
  assert.deepEqual(afterQueue.events.slice(beforeQueue.events.length), [
    'models:queue-slow', 'send:queued message', 'send:queued message', 'models:queue-next',
  ]);
  assert.equal(afterQueue.messages.filter((m: { text: string }) => m.text === 'queued message').length, 2);
  const beforeFreshRead = afterQueue.processStarts.length;
  await peer.models('queue-slow');
  assert.equal(readState().processStarts.length, beforeFreshRead + 1);

  const failures = await Promise.allSettled([
    runtime.models('queue-fail'), runtime.models('queue-after-failure'), runtime.sendMessage(worker.id, 'after failed read'),
  ]);
  assert.equal(failures[0].status, 'rejected');
  if (failures[0].status === 'rejected') assert.equal(failures[0].reason.code, 'PROVIDER_ERROR');
  assert.equal(failures[1].status, 'fulfilled');
  assert.equal(failures[2].status, 'fulfilled');
  assert.equal(readState().maximumActive, 1);
  assert.equal(readState().activeConnections, 0);
  const afterFailedRead = await runtime.models('queue-fail').catch((error) => error.code);
  assert.equal(afterFailedRead, 'PROVIDER_ERROR');

  const waitingRead = runtime.models('queue-slow');
  const expiry = rejectsCode(new PaseoRuntime({ cliPath, home, timeoutMs: 20 }).sendMessage(worker.id, 'expired request must not send'), 'TIMEOUT');
  const afterExpiry = runtime.sendMessage(worker.id, 'after queue expiry');
  await Promise.all([waitingRead, expiry, afterExpiry]);
  assert.equal(readState().messages.some((m: { text: string }) => m.text === 'expired request must not send'), false);
  assert.equal(readState().messages.at(-1).text, 'after queue expiry');

  const holdingRead = runtime.models('queue-slow');
  const shortQueue = new PaseoRuntime({ cliPath, home, timeoutMs: 20 });
  const overflow = await Promise.allSettled(Array.from({ length: 129 }, (_, index) => shortQueue.models('queued-capacity-' + index)));
  assert.equal(overflow.filter((r) => r.status === 'rejected' && r.reason.code === 'RUNTIME_BUSY').length, 1);
  assert.equal(overflow.filter((r) => r.status === 'rejected' && r.reason.code === 'TIMEOUT').length, 128);
  await holdingRead;
  assert.equal(readState().maximumActive, 1);
  assert.equal(readState().activeConnections, 0);

  await rejectsCode(new PaseoRuntime({ cliPath, home, timeoutMs: 400 }).models('slow'), 'TIMEOUT');
  // A killed mock cannot run SDK close(), so check recovery through a fresh call,
  // not the fixture's SDK-only connection count. The runtime waits for OS close.
  const recoveredState = readState(); recoveredState.activeConnections = 0;
  writeFileSync(join(home, 'state.json'), JSON.stringify(recoveredState));
  assert.deepEqual(await runtime.models('after-timeout'), [{ id: 'after-timeout/model', name: 'after-timeout model', thinkingOptions: [] }]);
  await rejectsCode(new PaseoRuntime({ cliPath, home, maxOutputBytes: 1000 }).models('large'), 'OUTPUT_TOO_LARGE');
  await rejectsCode(new PaseoRuntime({ cliPath, home, nodePath: join(fixture, 'missing-node') }).providers(), 'SPAWN_FAILED');
  await rejectsCode(runtime.sendMessage(worker.id, 'x'.repeat(300000)), 'INPUT_TOO_LARGE');
  assert.throws(() => runtime.sendMessage('', 'hello'), /sessionId/);
  console.log('paseoRuntime: mock SDK creation, messages, inspection, approvals, isolation, and process errors PASS');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
