import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArisReader, loadArisProjectRegistrations } from '../../../packages/adapters/src/arisReader.ts';
import { CollaborationLoop, type CollaborationEvent, type CollaborationRun, type CollaborationUsage } from '../../../packages/core/src/collaborationLoop.ts';
import { WorkbenchError, sameResearchDirectory, type ResearchWorkbench } from '../../../packages/core/src/researchWorkbench.ts';
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
export function connectCollaborations(workbench: ResearchWorkbench, options: { recordAris?: boolean; maxConcurrentTicks?:number; now?:()=>number; failureBackoffMs?:number; maxFailureBackoffMs?:number } = {}): void {
  const loops = new Map<string, CollaborationLoop>();
  const starting = new Set<string>();
  const publishBriefing=(id:string,run:CollaborationRun,nativeRunId:string,acceptance?:string)=>{
    // Check again after native-state I/O: an old callback may finish after a steer.
    const current=loops.get(id)?.status();
    if(current&&(current.id!==run.id||current.revision!==run.revision))return;
    const root=workbench.project(id).root;
    const prior=(()=>{try{return JSON.parse(readFileSync(scoped(root,'.aris/progress.json'),'utf8'));}catch{return {};}})();
    const report=collaborationReaderReport(run);
    const independenceNote=acceptance==='provisional'?'本轮执行与审核来自同一模型家族，原生记录仅为暂定。':acceptance==='unclassified'?'尚不能确认模型家族独立性，原生记录保留为执行结束，未宣称独立验收。':acceptance==='unlinked'?'本轮产物已独立审核，但尚无可关联的 ARIS 阶段交付证据；未登记科学阶段验收。':acceptance==='partial'?'本轮只登记有实际产物与独立回执的阶段；未交付、跳过与可选阶段保留原状态。':'';
    if(independenceNote){if(report.briefing)report.briefing.limitation=[report.briefing.limitation,independenceNote].filter(Boolean).join(' ');else report.summary+=' '+independenceNote;}
    const answers=workbench.control(workbench.project(id))?.recordedDecisions??[];
    if(Array.isArray(prior.questions))prior.questions=prior.questions.map((q:any)=>answers.some(d=>(d.runId===prior.run_id||d.appliesToRuns?.includes(prior.run_id))&&d.questionId===q.id&&d.title===q.title)?{...q,status:'answered'}:q);
    // Explicit undefined clears a previous briefing; a new round must not inherit
    // the old round's conclusion simply because the executor omitted a field.
    json(root,'.aris/progress.json',{...prior,run_id:nativeRunId,...report,updated_at:new Date().toISOString()});
  };
  const fileArtifact=(root:string,value:unknown):string|undefined=>{
    if(typeof value!=='string'||!value.trim())return undefined;
    try{return statSync(scoped(root,value)).isFile()?value:undefined;}catch{return undefined;}
  };
  const actualRun=(root:string,run:CollaborationRun):string|undefined=>{
    const action=run.actions.find(row=>row.id===run.lastExecutionId),reply=action?.reply;
    if(reply?.kind!=='execute'||!Array.isArray(action?.arisRunsBefore))return undefined;
    const expected=run.arisRunIds?.[String(run.revision)]??/\brun_id=([A-Za-z0-9._-]+)/.exec(run.task)?.[1];
    const candidates=[reply.arisRunId,...reply.artifacts.flatMap(path=>/^\.aris\/runs\/([A-Za-z0-9._-]+)\.json$/.exec(path)?.[1]??[]),expected];
    for(const candidate of candidates){
      if(typeof candidate!=='string'||!candidate||!/^[A-Za-z0-9._-]+$/.test(candidate))continue;
      if(action.arisRunsBefore.includes(candidate)){
        const sameRound=run.actions.some(prior=>prior.kind==='execute'&&prior.revision===run.revision&&prior.reply?.kind==='execute'&&Array.isArray(prior.arisRunsBefore)&&!prior.arisRunsBefore.includes(candidate)&&(prior.reply.arisRunId===candidate||expected===candidate||prior.reply.artifacts.includes(`.aris/runs/${candidate}.json`)));
        if(!sameRound)continue;
      }
      try{const value=JSON.parse(readFileSync(scoped(root,`.aris/runs/${candidate}.json`),'utf8'));if(value.run_id===candidate&&Array.isArray(value.phases))return candidate;}catch{}
    }
  };
  const acceptDelivered=async(id:string,nativeId:string,run:CollaborationRun,reviewActionId:string,allowed?:string[],receiptArtifacts:Record<string,string>={}):Promise<string>=>{
    const project=workbench.project(id),root=project.root;
    const native=JSON.parse(readFileSync(scoped(root,`.aris/runs/${nativeId}.json`),'utf8'));
    const executor=(await workbench.session(id,run.executorSessionId)).session,reviewer=(await workbench.session(id,run.reviewerSessionId)).session;
    const executorModel=executor.runtimeModel||executor.model||executor.configuredModel||'unknown',reviewerModel=reviewer.runtimeModel||reviewer.model||reviewer.configuredModel||'unknown';
    const execution=run.actions.find(row=>row.id===run.lastExecutionId)?.reply;
    let result='pending',accepted=0;
    for(const phase of native.phases??[]){
      if(allowed&&!allowed.includes(phase.phase)||['accepted','skipped'].includes(phase.status))continue;
      const receipt=fileArtifact(root,receiptArtifacts[phase.phase]);
      if(!['done','provisional'].includes(phase.status)){
        if(!receipt||!['pending','running'].includes(phase.status))continue;
        await aris(workbench,['set',root,nativeId,phase.phase,'done','--artifact',receipt]);phase.status='done';phase.artifact=receipt;
      }
      if(!fileArtifact(root,phase.artifact)&&execution?.kind==='execute'){
        const paths=execution.phaseArtifacts?.[phase.phase];
        if(Array.isArray(paths)&&paths.length&&paths.every(path=>!!fileArtifact(root,path))){await aris(workbench,['set',root,nativeId,phase.phase,'done','--artifact',paths[0]]);phase.artifact=paths[0];}
      }
      if(!fileArtifact(root,phase.artifact))continue;
      // DSH is an agent, not a model family. Fill that declaration from the
      // actual native reply, never from a requested/configured model setting.
      const observedExecutor=executor.runtimeModel?.trim();
      const executorArgs=['dsh','dsh-pi'].includes(phase.executor_model??native.executor_model)&&observedExecutor?['--executor',observedExecutor]:[];
      try{await aris(workbench,['accept',root,nativeId,phase.phase,'--verdict-id',`collaboration/${run.id}/${reviewActionId}.json`,'--reviewer',reviewerModel,...executorArgs]);accepted++;if(result==='pending')result='accepted';}
      catch(error){
        if(String(error).includes('cannot classify acceptance families'))result='unclassified';
        else{if(!String(error).includes('known same-family'))throw error;await aris(workbench,['mark-provisional',root,nativeId,phase.phase,'--verdict-id',`collaboration/${run.id}/${reviewActionId}.json`,'--reviewer',reviewerModel,'--executor',executorModel]);accepted++;if(result!=='unclassified')result='provisional';}
      }
    }
    if(result==='pending')return 'unlinked';
    const remaining=(native.phases??[]).some((phase:any)=>(!allowed||allowed.includes(phase.phase))&&!['done','provisional','accepted','skipped'].includes(phase.status));
    return result==='accepted'&&accepted&&remaining?'partial':result;
  };
  const get = (id: string): CollaborationLoop => {
    const project = workbench.project(id);
    let loop = loops.get(id);
    if (!loop) {
      loop = new CollaborationLoop({ projectRoot: project.root, operationTimeoutMs: 55_000, sendOperationTimeoutMs:420_000,
        port: {
          async inspect(sessionId) {
            const detail = await workbench.session(id, sessionId);
            const native=detail.session as {lastActivityAt?:string;lastMessageAt?:string};
            const progress=Math.max(Date.parse(native.lastActivityAt||'')||0,Date.parse(native.lastMessageAt||'')||0);
            return { status: detail.session.status, ...(progress?{lastProgressAt:new Date(progress).toISOString()}:{}), usage:(detail as {usage?:CollaborationUsage}).usage??(detail.session as {usage?:CollaborationUsage}).usage,error: (detail as {error?:string}).error || (detail.session as {error?:string}).error, provider: detail.session.provider, activeTurn: detail.activeTurn, approvals: detail.approvals, messages: detail.messages };
          },
          async send(sessionId, prompt,scope) {
            // These checks precede the send boundary: their failure cannot
            // create an uncertain task delivery or an unresolvable stop.
            try{
              await workbench.session(id, sessionId); // project ownership; automated messages are not human authorization
              await workbench.prepareSessionAccess(id, sessionId);
            }catch(error){return {accepted:false,error:`任务尚未发送：${error instanceof Error?error.message:String(error)}`};}
            if(scope){
              const current=loops.get(id)?.status(),action=current?.actions.find(row=>row.id===scope.actionId);
              if(!current||current.id!==scope.collaborationId||current.revision!==scope.revision||current.state==='stopping'||inactive.has(current.state)||!action||action.revision!==scope.revision||!['sending','sent'].includes(action.status)||action.revocationConfirmed)return {accepted:false,error:'任务尚未发送：动作已暂停、撤销或被新方向替代'};
            }
            return workbench.options.runtime.sendMessage(sessionId, workbench.executionScope(id) + '\n\n' + prompt,scope?{collaboration:scope}:undefined);
          },
          async children(scope){
            const runtime=workbench.options.runtime;
            if(!runtime.listDescendants)return [];
            const run=loops.get(id)?.status();if(!run||run.id!==scope.collaborationId)return [];
            const groups=await Promise.all([run.executorSessionId,run.reviewerSessionId].map(parent=>runtime.listDescendants!(parent)));
            const children=[...new Map(groups.flat().filter(child=>child.delegation?.collaborationId===scope.collaborationId).map(child=>[child.id,child])).values()];
            return Promise.all(children.map(async child=>{
              if(!sameResearchDirectory(child.cwd,project.root))throw new WorkbenchError('子会话目录不属于本项目',403);
              const detail=await runtime.inspectSession(child.id);
              return {id:child.id,actionId:child.delegation?.actionId,revision:child.delegation?.revision,status:detail.session.status,error:(detail.session as {error?:string}).error,activeTurn:detail.activeTurn,approvals:detail.approvals,messages:[],usage:(detail as {usage?:CollaborationUsage}).usage??(detail.session as {usage?:CollaborationUsage}).usage};
            }));
          },
          async revoke(sessionId,scope){await workbench.options.runtime.setCollaborationScope?.(sessionId,scope);},
          async interrupt(sessionId){
            const run=loops.get(id)?.status();
            if(run&&![run.executorSessionId,run.reviewerSessionId].includes(sessionId)){
              const detail=await workbench.options.runtime.inspectSession(sessionId);
              if(!sameResearchDirectory(detail.session.cwd,project.root)||detail.session.delegation?.collaborationId!==run.id)throw new WorkbenchError('子会话不属于当前协作',403);
              return workbench.options.runtime.interruptSession(sessionId);
            }
            return workbench.interrupt(id,sessionId);
          },
        },
        onEvent: (event, run) => record(id, event, run),
      });
      loops.set(id, loop);
    }
    return loop;
  };
  const record = async (id: string, event: CollaborationEvent, run: CollaborationRun) => {
    if (!['started', 'direction_changed', 'action_sent', 'plan_completed', 'iteration_planned', 'iteration_audited', 'iteration_needs_input', 'execute_completed', 'execute_blocked','execution_blocked','review_completed', 'accepted', 'revision_requested', 'directions_synchronized', 'paused', 'budget_exhausted', 'needs_attention'].includes(event.type)) return;
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
    const control=workbench.control(project);
    const affected=control?.mode==='pipeline'?control.continuation?.affectedStages??[]:[];
    if(control?.workflow!=='free'&&!affected.length&&event.type==='accepted'&&options.recordAris!==false){
      const nativeId=actualRun(root,run);
      acceptance=nativeId?await acceptDelivered(id,nativeId,run,action!.id):'unlinked';
      const previous=(()=>{try{return JSON.parse(readFileSync(scoped(root,'.aris/progress.json'),'utf8')).run_id;}catch{return '';}})();
      publishBriefing(id,run,nativeId??previous??'',acceptance);return;
    }
    if (control?.workflow==='free'&&control.mode !== 'pipeline' && options.recordAris !== false && ['action_sent', 'execute_completed', 'accepted', 'revision_requested'].includes(event.type) && (event.type !== 'action_sent' || action?.kind === 'execute'&&action.status==='sent')) {
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
        const state=JSON.parse(readFileSync(scoped(root,`.aris/runs/${followupId}.json`),'utf8'));
        if(state.phases?.find((phase:any)=>phase.phase===affected[0])?.status==='pending')await aris(workbench,['set',root,followupId,affected[0],'running']);
      }
      // A real independent acceptance closes the affected follow-up phases;
      // it never rewrites an older, already-accepted research round.
      if(event.type==='accepted' && options.recordAris!==false){
        const control=workbench.control(project)!;
        const affected=control.continuation?.affectedStages??[];
        if(!affected.length){publishBriefing(id,run,new ArisReader([project]).overview(id).focus.pipeline_run_id??'',acceptance);return;}
        let nativeId=followupId;
        let native:any=null;
        if(nativeId){try{native=JSON.parse(readFileSync(scoped(root,`.aris/runs/${nativeId}.json`),'utf8'));}catch{}}
        const executor=(await workbench.session(id,run.executorSessionId)).session;
        const executorModel=executor.runtimeModel||executor.model||executor.configuredModel||'unknown';
        const oldRound=!native||affected.some(stage=>!native.phases?.some((p:any)=>p.phase===stage));
        if(oldRound){nativeId=`followup-${run.id}-r${event.revision}`;await aris(workbench,['start',root,nativeId,'--phases',affected.join(','),'--executor',executorModel]);native=JSON.parse(readFileSync(scoped(root,`.aris/runs/${nativeId}.json`),'utf8'));}
        const execution=run.actions.find(row=>row.id===run.lastExecutionId)?.reply;
        const receipts:Record<string,string>={};
        if(execution?.kind==='execute'&&execution.artifacts.length&&execution.artifacts.every(path=>!!fileArtifact(root,path))){
          // Each receipt supports its actual role, not every optional scientific phase.
          receipts[affected[0]]=`${folder}/${run.lastExecutionId}.json`;
          for(const stage of affected){if(/review|审核|评审/i.test(stage))receipts[stage]=`${folder}/${action!.id}.json`;else if(/summary|summar|report|总结|汇总/i.test(stage))receipts[stage]=`${folder}/${run.lastExecutionId}.json`;}
        }
        acceptance=await acceptDelivered(id,nativeId!,run,action!.id,affected,receipts);
      }
      publishBriefing(id,run,new ArisReader([project]).overview(id).focus.pipeline_run_id??(affected.length?followupId:''),acceptance);
      return;
    }
    const priorId=(()=>{try{return JSON.parse(readFileSync(scoped(root,'.aris/progress.json'),'utf8')).run_id;}catch{return undefined;}})();
    if(control?.workflow!=='free'){publishBriefing(id,run,actualRun(root,run)??priorId??'',acceptance);return;}
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
      const control=workbench.control(workbench.project(id)),automatedTask=workbench.automationTask(id,task);
      const arisRunId=control?.workflow!=='free'?/\brun_id=([A-Za-z0-9._-]+)/.exec(automatedTask)?.[1]:undefined;
      return await loop.start({ ...control?.budget,task:automatedTask,arisRunId, executorSessionId: executor.id, reviewerSessionId: reviewer.id,auditFirst:input.auditFirst===true });
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
  const inFlight=new Map<string,Promise<void>>(),pending=new Set<string>(),failures=new Map<string,{count:number;nextAt:number}>();
  const now=options.now??Date.now,limit=options.maxConcurrentTicks??3;
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error('maxConcurrentTicks must be a positive integer');
  const baseDelay=options.failureBackoffMs??1000,maxDelay=options.maxFailureBackoffMs??30000;
  function drain(){
    while(inFlight.size<limit&&pending.size){
      const id=pending.values().next().value!;pending.delete(id);
      if(inFlight.has(id)||(failures.get(id)?.nextAt??0)>now())continue;
      const task=Promise.resolve().then(async()=>{
        try{const loop=get(id);await loop.tick();if(loop.status()?.error)throw new Error(loop.status()!.error);failures.delete(id);}
        catch(error){const count=(failures.get(id)?.count??0)+1;failures.set(id,{count,nextAt:now()+Math.min(maxDelay,baseDelay*2**Math.min(count-1,16))});console.error('Collaboration observation failed:',id,error instanceof Error?error.message:String(error));}
      }).finally(()=>{inFlight.delete(id);drain();});
      inFlight.set(id,task);
    }
  }
  workbench.tickCollaborations=async()=>{
    for(const project of loadArisProjectRegistrations(workbench.options.registryFile,workbench.options.repoRoot)){
      if(!existsSync(join(project.root,'.bri/collaboration.json'))||inFlight.has(project.id)||(failures.get(project.id)?.nextAt??0)>now())continue;
      pending.add(project.id);
    }
    drain();
    // Each project owns its promise: a slow project does not prevent another
    // timer invocation from scheduling a newly ready healthy project.
    await Promise.allSettled([...inFlight.values()]);
  };
}
