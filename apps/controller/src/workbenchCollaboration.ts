import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArisReader, loadArisProjectRegistrations } from '../../../packages/adapters/src/arisReader.ts';
import { CollaborationLoop, type CollaborationEvent, type CollaborationRun } from '../../../packages/core/src/collaborationLoop.ts';
import { WorkbenchError, type ResearchWorkbench } from '../../../packages/core/src/researchWorkbench.ts';
import { collaborationReaderReport } from '../../../packages/core/src/readerBriefing.ts';

const inactive = new Set(['accepted', 'audited', 'paused', 'budget_exhausted', 'needs_attention']);
const toWsl = (path: string) => path.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive) => `/mnt/${drive.toLowerCase()}`);
function scoped(root: string, path: string): string {
  const base = realpathSync(root), target = resolve(root, path);
  const inside = (p: string) => { const rel = relative(base, p); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
  if (!inside(target)) throw new Error('协作产物必须位于本项目内');
  let cursor = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && !inside(realpathSync(cursor))) throw new Error('协作记录或产物不能指向项目之外');
  }
  return target;
}
function json(root: string, path: string, value: unknown): void {
  const file = scoped(root, path);
  mkdirSync(resolve(file, '..'), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temp, file);
}
async function aris(workbench: ResearchWorkbench, args: string[]): Promise<any> {
  const script = join(workbench.arisRoot, 'tools/run_state.py');
  const windows = process.platform === 'win32';
  return new Promise((resolveResult, reject) => {
    const child = spawn(windows ? 'C:/Windows/System32/wsl.exe' : 'python3', windows
      ? ['--exec', 'python3', toWsl(script), ...args.map(toWsl)] : [script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('ARIS 原生状态工具超时')); }, 20_000);
    child.stdout.on('data', data => { output += String(data).slice(0, 100_000 - output.length); });
    child.stderr.on('data', data => { error += String(data).slice(0, 8000 - error.length); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`ARIS 记录失败：${error || code}`)); else { try { resolveResult(JSON.parse(output)); } catch { resolveResult(output); } } });
  });
}

/** Transport-independent orchestration. The runtime owns session lifetime; ARIS owns phase acceptance. */
export function connectCollaborations(workbench: ResearchWorkbench, options: { recordAris?: boolean } = {}): void {
  const loops = new Map<string, CollaborationLoop>();
  const starting = new Set<string>();
  const publishBriefing=(id:string,run:CollaborationRun,nativeRunId:string,acceptance?:string)=>{
    // Check again after native-state I/O: an old callback may finish after a steer.
    const current=loops.get(id)?.status();
    if(current&&(current.id!==run.id||current.revision!==run.revision))return;
    const root=workbench.project(id).root;
    const prior=(()=>{try{return JSON.parse(readFileSync(scoped(root,'.aris/progress.json'),'utf8'));}catch{return {};}})();
    const report=collaborationReaderReport(run);
    const independenceNote=acceptance==='provisional'?'本轮执行与审核来自同一模型家族，原生记录仅为暂定。':acceptance==='unclassified'?'尚不能确认模型家族独立性，原生记录保留为执行结束，未宣称独立验收。':'';
    if(independenceNote){if(report.briefing)report.briefing.limitation=[report.briefing.limitation,independenceNote].filter(Boolean).join(' ');else report.summary+=' '+independenceNote;}
    const answers=workbench.control(workbench.project(id))?.recordedDecisions??[];
    if(Array.isArray(prior.questions))prior.questions=prior.questions.map((q:any)=>answers.some(d=>(d.runId===prior.run_id||d.appliesToRuns?.includes(prior.run_id))&&d.questionId===q.id&&d.title===q.title)?{...q,status:'answered'}:q);
    // Explicit undefined clears a previous briefing; a new round must not inherit
    // the old round's conclusion simply because the executor omitted a field.
    json(root,'.aris/progress.json',{...prior,run_id:nativeRunId,...report,updated_at:new Date().toISOString()});
  };
  const get = (id: string): CollaborationLoop => {
    const project = workbench.project(id);
    let loop = loops.get(id);
    if (!loop) {
      loop = new CollaborationLoop({ projectRoot: project.root, operationTimeoutMs: 55_000,
        port: {
          async inspect(sessionId) {
            const detail = await workbench.session(id, sessionId);
            const native=detail.session as {lastActivityAt?:string;lastMessageAt?:string};
            const progress=Math.max(Date.parse(native.lastActivityAt||'')||0,Date.parse(native.lastMessageAt||'')||0);
            return { status: detail.session.status, ...(progress?{lastProgressAt:new Date(progress).toISOString()}:{}), error: (detail as {error?:string}).error || (detail.session as {error?:string}).error, provider: detail.session.provider, activeTurn: detail.activeTurn, approvals: detail.approvals, messages: detail.messages };
          },
          async send(sessionId, prompt) {
            // These checks precede the send boundary: their failure cannot
            // create an uncertain task delivery or an unresolvable stop.
            try{
              await workbench.session(id, sessionId); // project ownership; automated messages are not human authorization
              await workbench.prepareSessionAccess(id, sessionId);
            }catch(error){return {accepted:false,error:`任务尚未发送：${error instanceof Error?error.message:String(error)}`};}
            return workbench.options.runtime.sendMessage(sessionId, workbench.executionScope(id) + '\n\n' + prompt);
          },
          interrupt: sessionId => workbench.interrupt(id, sessionId),
        },
        onEvent: (event, run) => record(id, event, run),
      });
      loops.set(id, loop);
    }
    return loop;
  };
  const record = async (id: string, event: CollaborationEvent, run: CollaborationRun) => {
    if (!['started', 'direction_changed', 'action_sent', 'plan_completed', 'iteration_planned', 'iteration_audited', 'iteration_needs_input', 'execute_completed', 'review_completed', 'accepted', 'revision_requested', 'directions_synchronized', 'paused', 'budget_exhausted', 'needs_attention'].includes(event.type)) return;
    const project = workbench.project(id), root = project.root;
    const action = run.actions.find(row => row.id === event.actionId);
    const runId = `collab-${run.id}-r${event.revision}`;
    const folder = `collaboration/${run.id}`;
    json(root, `${folder}/run.json`, run);
    if (action?.reply) json(root, `${folder}/${action.id}.json`, { sessionId: action.sessionId, reply: action.reply, originalReplies: action.replies });
    if (event.type === 'accepted') {
      const execution = run.actions.find(row => row.id === run.lastExecutionId)?.reply;
      if (execution?.kind !== 'execute') throw new Error('没有本轮执行产物记录');
      for (const path of execution.artifacts) if (!statSync(scoped(root, path)).isFile()) throw new Error(`未找到文件产物：${path}`);
    }
    let acceptance = 'pending';
    if (workbench.control(project)?.mode !== 'pipeline' && options.recordAris !== false && ['action_sent', 'execute_completed', 'accepted', 'revision_requested'].includes(event.type) && (event.type !== 'action_sent' || action?.kind === 'execute'&&action.status==='sent')) {
      scoped(root, `.aris/runs/${runId}.json`);
      const executor = (await workbench.session(id, run.executorSessionId)).session;
      const reviewer = (await workbench.session(id, run.reviewerSessionId)).session;
      const executorModel = executor.runtimeModel || executor.model || executor.configuredModel || 'unknown';
      const reviewerModel = reviewer.runtimeModel || reviewer.model || reviewer.configuredModel || 'unknown';
      const nativeFile = join(root, '.aris/runs', `${runId}.json`);
      if (!existsSync(nativeFile)) await aris(workbench, ['start', root, runId, '--phases', 'implementation', '--executor', executorModel]);
      if (event.type === 'action_sent' && action?.kind === 'execute' || event.type === 'revision_requested') await aris(workbench, ['set', root, runId, 'implementation', 'running']);
      if (event.type === 'execute_completed') await aris(workbench, ['set', root, runId, 'implementation', 'done', '--artifact', `${folder}/${action!.id}.json`]);
      if (event.type === 'accepted') {
        // The upstream helper distinguishes same-family provisional review from cross-family acceptance.
        const state = JSON.parse(readFileSync(nativeFile, 'utf8'));
        if (!['done', 'accepted', 'provisional'].includes(state.phases?.[0]?.status)) await aris(workbench, ['set', root, runId, 'implementation', 'done', '--artifact', `${folder}/${run.lastExecutionId}.json`]);
        try {
          await aris(workbench, ['accept', root, runId, 'implementation', '--verdict-id', `${folder}/${action!.id}.json`, '--reviewer', reviewerModel]);
          acceptance = 'accepted';
        } catch (error) {
          if (String(error).includes('cannot classify acceptance families')) {
            acceptance = 'unclassified'; // Keep native done, never manufacture scientific acceptance for an unknown model family.
          } else {
          if (!String(error).includes('known same-family')) throw error;
          await aris(workbench, ['mark-provisional', root, runId, 'implementation', '--verdict-id', `${folder}/${action!.id}.json`, '--reviewer', reviewerModel, '--executor', executorModel]);
          acceptance = 'provisional';
          }
        }
      }
    }
    // Steering may arrive during native tool I/O; old events remain evidence but must not overwrite current progress.
    const current = loops.get(id)?.status();
    if (current && (current.id !== run.id || current.revision !== event.revision)) return;
    if(workbench.control(project)?.mode==='pipeline'){
      const affected=workbench.control(project)?.continuation?.affectedStages??[];
      const followupId=`followup-${run.id}-r${event.revision}`;
      // Audit-only iterations create no scientific run. A fresh native round
      // starts when the executor actually receives this revision's task.
      if(options.recordAris!==false && affected.length && action?.kind==='execute' && (event.type==='action_sent'&&action.status==='sent'||event.type==='execute_completed') && !existsSync(scoped(root,`.aris/runs/${followupId}.json`))){
        const executor=(await workbench.session(id,run.executorSessionId)).session;
        await aris(workbench,['start',root,followupId,'--phases',affected.join(','),'--executor',executor.runtimeModel||executor.model||executor.configuredModel||'unknown']);
        const latest=loops.get(id)?.status();
        if(latest&&(latest.id!==run.id||latest.revision!==event.revision))return;
        const prior=(()=>{try{return JSON.parse(readFileSync(scoped(root,'.aris/progress.json'),'utf8'));}catch{return {};}})();
        const answered=workbench.control(project)?.recordedDecisions??[];
        const questions=Array.isArray(prior.questions)?prior.questions.filter((q:any)=>!answered.some(d=>(d.runId===prior.run_id||d.appliesToRuns?.includes(prior.run_id))&&d.questionId===q.id&&d.title===q.title)):[];
        json(root,'.aris/progress.json',{run_id:followupId,workbench_iteration:true,summary:run.directions.at(-1)?.text||run.task,next_step:'按本轮要求执行，再交由绑定 Codex 独立审核。',questions,updated_at:new Date().toISOString()});
      }
      if(options.recordAris!==false && affected.length && event.type==='action_sent' && action?.kind==='execute' && action.status==='sent' && existsSync(scoped(root,`.aris/runs/${followupId}.json`))){
        await aris(workbench,['set',root,followupId,affected[0],'running']);
      }
      // A real independent acceptance closes the affected follow-up phases;
      // it never rewrites an older, already-accepted research round.
      if(event.type==='accepted' && options.recordAris!==false){
        const control=workbench.control(project)!;
        const affected=control.continuation?.affectedStages??[];
        if(!affected.length){publishBriefing(id,run,new ArisReader([project]).overview(id).focus.pipeline_run_id??followupId);return;}
        let nativeId=followupId;
        let native:any=null;
        if(nativeId){try{native=JSON.parse(readFileSync(scoped(root,`.aris/runs/${nativeId}.json`),'utf8'));}catch{}}
        const executor=(await workbench.session(id,run.executorSessionId)).session;
        const reviewer=(await workbench.session(id,run.reviewerSessionId)).session;
        const executorModel=executor.runtimeModel||executor.model||executor.configuredModel||'unknown';
        const reviewerModel=reviewer.runtimeModel||reviewer.model||reviewer.configuredModel||'unknown';
        const oldRound=!native||affected.some(stage=>!native.phases?.some((p:any)=>p.phase===stage));
        if(oldRound){nativeId=`followup-${run.id}-r${event.revision}`;await aris(workbench,['start',root,nativeId,'--phases',affected.join(','),'--executor',executorModel]);native=JSON.parse(readFileSync(scoped(root,`.aris/runs/${nativeId}.json`),'utf8'));}
        for(const stage of affected){
          const phase=native.phases?.find((p:any)=>p.phase===stage);
          if(!phase)continue;
          if(phase.status==='accepted')continue;
          if(!['done','provisional'].includes(phase.status))await aris(workbench,['set',root,nativeId!,stage,'done','--artifact',`${folder}/${stage==='auto-review-loop'?action!.id:run.lastExecutionId}.json`]);
          try{await aris(workbench,['accept',root,nativeId!,stage,'--verdict-id',`${folder}/${action!.id}.json`,'--reviewer',reviewerModel]);if(acceptance==='pending')acceptance='accepted';}
          catch(error){
            if(String(error).includes('cannot classify acceptance families')){acceptance='unclassified';}
            else{if(!String(error).includes('known same-family'))throw error;await aris(workbench,['mark-provisional',root,nativeId!,stage,'--verdict-id',`${folder}/${action!.id}.json`,'--reviewer',reviewerModel,'--executor',executorModel]);if(acceptance!=='unclassified')acceptance='provisional';}
          }
        }
      }
      publishBriefing(id,run,new ArisReader([project]).overview(id).focus.pipeline_run_id??followupId,acceptance);
      return;
    }
    const priorId=(()=>{try{return JSON.parse(readFileSync(scoped(root,'.aris/progress.json'),'utf8')).run_id;}catch{return undefined;}})();
    publishBriefing(id,run,run.actions.some(a=>a.revision===run.revision&&a.kind==='execute')?runId:priorId??runId,acceptance);
  };
  workbench.collaborationStatus = id => get(id).status();
  workbench.startCollaboration = async (id, input) => {
    if (starting.has(id)) throw new WorkbenchError('本项目正在启动协作', 409);
    starting.add(id);
    try {
      const loop = get(id), current = loop.status();
      if (current && !inactive.has(current.state)) throw new WorkbenchError('已有协作正在运行，请在项目对话调整方向', 409);
      if(input.auditFirst!==undefined&&typeof input.auditFirst!=='boolean')throw new WorkbenchError('审计规划选项必须为布尔值');
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (!task || task.length > 40_000) throw new WorkbenchError('请提供具体任务（最多 40000 字）');
      // New tasks create distinct conversations; research continuation explicitly reuses its bound pair.
      const reviewerChoice=workbench.options.reviewerSelection??{};
      let reviewerModel=reviewerChoice.model,reviewerEffort=reviewerChoice.thinkingOptionId;
      if(input.reuseExisting!==true){
        const models=(await workbench.models('codex')).models.filter(m=>m.available!==false);
        const selected=reviewerModel?models.find(m=>m.id===reviewerModel):models.find(m=>m.id==='gpt-6.1-sol')??models[0];
        if(!selected)throw new WorkbenchError(reviewerModel?'The configured reviewer model is unavailable; update workbench.local.json.':'No Codex reviewer model is available.',503);
        reviewerModel=selected.id;
        reviewerEffort??=selected.thinkingOptions?.some(e=>e.id==='high')?'high':selected.defaultThinkingOptionId??selected.thinkingOptions?.[0]?.id;
      }
      const reviewer = input.reuseExisting===true ? (await workbench.session(id,String(input.reviewerSessionId))).session : await workbench.createSession(id, { provider: 'codex', model: reviewerModel, thinkingOptionId: reviewerEffort, role: 'reviewer', workflow: 'free', idle: true });
      const executor = input.reuseExisting===true ? (await workbench.session(id,String(input.executorSessionId))).session : await workbench.createSession(id, { provider: input.provider, model: input.model, thinkingOptionId: input.thinkingOptionId, role: 'executor', workflow: 'free', idle: true });
      if(input.reuseExisting===true){
        for(const session of [executor,reviewer]){
          if(['running','starting'].includes(session.status)){await workbench.interrupt(id,session.id);const deadline=Date.now()+20000;let detail=await workbench.session(id,session.id);while(['running','starting'].includes(detail.session.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));detail=await workbench.session(id,session.id);}if(['running','starting'].includes(detail.session.status))throw new WorkbenchError('执行端尚未确认中断，保留原会话，请稍后查看',409);}
        }
      }
      workbench.recordDirection(id, task, executor.id);
      workbench.recordDirection(id, task, reviewer.id);
      return await loop.start({ task, executorSessionId: executor.id, reviewerSessionId: reviewer.id,auditFirst:input.auditFirst===true });
    } finally { starting.delete(id); }
  };
  workbench.steerCollaboration = async (id, message, options={}) => {
    if(options.auditFirst!==undefined&&typeof options.auditFirst!=='boolean')throw new WorkbenchError('审计规划选项必须为布尔值');
    if (typeof message !== 'string' || !message.trim() || message.length > 40_000) throw new WorkbenchError('请填写新的任务方向（最多 40000 字）');
    const loop = get(id), run = loop.status();
    if (!run) throw new WorkbenchError('尚未启动自动协作', 409);
    workbench.recordDirection(id, message.trim(), run.executorSessionId);
    workbench.recordDirection(id, message.trim(), run.reviewerSessionId);
    return loop.steer(message,options);
  };
  workbench.pauseCollaboration = id => get(id).pause();
  let ticking = false;
  workbench.tickCollaborations = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const project of loadArisProjectRegistrations(workbench.options.registryFile, workbench.options.repoRoot)) {
        if (!existsSync(join(project.root, '.bri/collaboration.json'))) continue;
        try { await get(project.id).tick(); } catch (error) { console.error('Collaboration observation failed:', project.id, error instanceof Error ? error.message : String(error)); }
      }
    } finally { ticking = false; }
  };
}
