import { useI18n, translate as tr } from '../i18n';
import type { Async } from '../hooks/useAsync';
import type { Overview, Project, ProjectContinuation } from '../types';
import type { WorkbenchCollaborationRun, WorkbenchSession } from '../workbenchTypes';
import type { fetchWorkbenchAttention } from '../workbenchApi';
import { sessionStatus } from './ChatPanel';
import { ResearchSummary } from './ResearchSummary';

function stageStatus(status: string): string {
  const labels: Record<string, string> = { accepted: tr("已验收"), done: tr("执行结束 · 待审核"), provisional: tr("暂定结果 · 待审核"), completed: tr("执行已结束"), succeeded: tr("执行已结束"), running: tr("进行中"), waiting_input: tr("待答复"), blocked: tr("受阻"), failed: tr("执行失败"), skipped: tr("已跳过"), not_started: tr("未开始"), pending: tr("待推进"), queued: tr("排队中"), unknown: tr("尚未记录") };
  return labels[status] || sessionStatus(status);
}

function IterationPlan({ run }: { run: WorkbenchCollaborationRun | null | undefined }): JSX.Element | null {
  const { t: tr } = useI18n();
  if (!run) return null;
  const action = [...run.actions].reverse().find(item => item.revision === run.revision && item.status === 'replied' && item.reply?.kind === 'plan' && (!run.lastPlanId || item.id === run.lastPlanId));
  const plan = action?.reply;
  if (plan?.kind !== 'plan' || plan.revision !== run.revision) return run.state === 'planning' ? <section className="wb-card wb-iteration-plan" aria-label={tr("Codex 审计与计划")}><h2>{tr("Codex 正在审计规划")}</h2><p role="status">{tr("正在检查已有成果并提出下一步建议，本轮执行尚未开始。")}</p><p className="wb-muted">{tr("项目范围内的计划会自动交给 DSH 执行；涉及范围、费用或方向选择时再请你决定。")}</p></section> : null;
  const status = plan.decision === 'needs_input' ? tr("待你决定") : plan.decision === 'no_change' ? tr("审计完成 · 无需新增执行") : run.state === 'accepted' ? tr("本轮执行已审核通过") : run.state === 'paused' ? tr("计划已保留 · 协作已暂停") : run.state === 'needs_attention' ? tr("计划已保留 · 需要处理") : run.state === 'budget_exhausted' ? tr("计划已保留 · 返修预算已用尽") : run.state === 'planning' ? tr("正在交接计划") : tr("执行与审核正在推进");
  return <section className="wb-card wb-iteration-plan" aria-label={tr("Codex 审计与计划")}>
    <div className="wb-section-heading"><h2>{tr("Codex 的审计与计划")}</h2><span className="wb-status">{tr(status)}</span></div>
    <p className="wb-plan-summary">{plan.summary}</p>
    <div className="wb-plan-sections">{([{ title: tr("改进建议"), items: plan.recommendations }, { title: tr("接下来怎么做"), items: plan.steps }]).map(section => <div key={section.title}><h3>{section.title}</h3>{section.items.length ? <ol>{section.items.map((item, index) => <li key={index}>{item}</li>)}</ol> : <p className="wb-muted">{tr("本次没有新增要求。")}</p>}</div>)}</div>
    <details className="wb-plan-evidence"><summary>{tr("查看审计证据与验收口径")}</summary><div className="wb-plan-sections">{([{ title: tr("审计证据"), items: plan.audit }, { title: tr("怎样算完成"), items: plan.acceptanceCriteria }]).map(section => <div key={section.title}><h3>{section.title}</h3>{section.items.length ? <ol>{section.items.map((item, index) => <li key={index}>{item}</li>)}</ol> : <p className="wb-muted">{tr("本次没有新增要求。")}</p>}</div>)}</div></details>
    <p className="wb-muted">{plan.decision === 'needs_input' ? tr("请在项目对话的「待处理」或对话中补充决定。") : plan.decision === 'no_change' ? tr("本次没有派发新执行任务，已有阶段记录保留。") : tr("计划自动交给 DSH，完成后由 Codex 独立审核并按需返修。")}</p>
  </section>;
}

export function ProjectOverview({project,focus,continuation,sessions,attention,now,onOpenSession,onOpenRequests,onIterate,collaboration}: {
  project:Project|null;focus:Overview['focus'];sessions:WorkbenchSession[];
  continuation?:ProjectContinuation;now:number;
  collaboration?:WorkbenchCollaborationRun|null;
  attention:Async<Awaited<ReturnType<typeof fetchWorkbenchAttention>>>;
  onIterate?:()=>void;onOpenSession:(id:string)=>void;onRefresh:()=>void;onOpenRequests:()=>void;
}): JSX.Element {
  const { t: tr, locale } = useI18n();
  const pending=attention.data?.pending??[];
  const blockers=[...(focus?.blockers??[])];
  for(const row of pending) blockers.push({id:`live-${row.session?.id}`,session_id:row.session?.id,title:row.approvals?.some(p=>p.kind==='question')?tr("会话等待回答"):tr("会话有操作待处理"),detail:row.error || row.approvalReviews?.filter(r=>['human_required','unknown'].includes(r.state)).at(-1)?.reason || row.approvals?.[0]?.description || tr("执行端报告等待，但尚未返回具体请求。"),source:row.session?.title || tr("执行后台")});
  const agents=sessions.map(session=>{
    const observation=attention.data?.observations?.find(o=>o.session?.id===session.id);
    const activity=observation?.activity??[];
    const recent=activity.at(-1);
    const status=observation?.session?.status || session.status;
    const idle=status==='idle';
    const active=['running','starting'].includes(status) ? [...activity].reverse().find(item=>['running','pending','in_progress'].includes(item.status||'')) : undefined;
    const latestAt=Math.max(0,...activity.map(item=>Date.parse(item.at || '') || 0),...(observation?.messages??[]).map(item=>Date.parse(item.at || '') || 0));
    // Silence after a finished tool is an observation, not evidence of completion or a dead process.
    const quiet=status==='running' && !active && !!latestAt && now-latestAt>=90_000 && ['completed','failed'].includes(recent?.status || '');
    const label=quiet ? tr("暂无新活动 · 等待确认") : idle ? tr("当前闲置") : ['completed','succeeded','done'].includes(status) ? tr("本轮执行已结束") : sessionStatus(status);
    return {session,observation,activity,recent,status,idle,active,quiet,label};
  });
  const running=agents.some(agent=>['running','starting'].includes(agent.status) && !agent.quiet);
  const quiet=agents.some(agent=>agent.quiet) && !running;
  const projectStatus=collaboration?.state==='planning' ? tr("Codex 正在审计规划") : collaboration?.state==='audited' ? tr("审计完成 · 无需新增执行") : pending.length || continuation?.state==='blocked' ? tr("等待处理请求") : continuation?.state==='idle' ? tr("当前闲置 · 等待继续") : quiet ? tr("暂无新活动 · 等待进展确认") : continuation?.state==='completed' ? tr("本轮核验结束") : running ? tr("Agent 正在执行") : tr("当前没有执行中的操作");
  const stages=focus?.stages??[];
  const affected=new Set(continuation?.state!=='completed' ? continuation?.affectedStages??[] : []);
  const reopened=(stage:typeof stages[number])=>affected.has(stage.id) || affected.has(stage.label);
  const total=stages.filter(stage=>stage.status!=='skipped' || reopened(stage)).length;
  const accepted=stages.filter(stage=>stage.status==='accepted' && !reopened(stage)).length;
  const progress=total ? Math.round(accepted/total*100) : 0;
  const current=stages.filter(stage=>reopened(stage) || ['running','blocked','failed','waiting_input'].includes(stage.status));
  return <div className="wb-unified-overview" data-testid="project-overview">
    <section className="wb-card wb-project-summary"><div className="wb-section-heading"><div><span className="wb-eyebrow">{tr("当前项目")}</span><h1>{project?.name || tr("项目进展")}</h1></div><span className={`wb-status${quiet || continuation?.state==='idle' ? ' is-idle' : ''}`}>{tr(projectStatus)}</span></div>
      <ResearchSummary focus={focus} goal={project?.goal} continuation={continuation}/>
      <small className="wb-muted">{tr("研究摘要：")}{focus?.updated_at ? new Date(focus.updated_at).toLocaleString(locale) : tr("尚未更新")}  {tr("· 会话状态：")}{attention.lastOkAt ? new Date(attention.lastOkAt).toLocaleTimeString(locale) : tr("读取中")}</small>
    </section>
    <IterationPlan run={collaboration} />
    <section className="wb-card wb-research-progress" aria-label={tr("研究阶段进度")} data-testid="research-progress"><div className="wb-section-heading"><h2>{tr("研究阶段")}</h2>{onIterate ? <button type="button" className="wb-button" onClick={onIterate}>{tr("继续迭代 / 重做")}</button> : null}<span className="wb-muted">{total ? tr("当前已验收 {0} / {1}", { 0: accepted, 1: total }) : tr("等待阶段记录")}</span></div>
      {stages.length ? <><div className="wb-research-progress-track" role="progressbar" aria-label={tr("阶段验收进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={tr("当前 {0} 个阶段已验收，共 {1} 个阶段", { 0: accepted, 1: total })}><span style={{width:`${progress}%`}} /></div><ol className="wb-research-stages">{stages.map((stage,index)=>{
        const reopen=reopened(stage);
        const unconfirmed=!reopen && stage.status==='running' && !running;
        const activeReopen=!continuation?.activeStage||continuation.activeStage===stage.id||continuation.activeStage===stage.label;
        const status=reopen && collaboration?.state==='planning' ? 'pending' : reopen && !activeReopen ? stage.status==='done'?'done':'pending' : reopen ? continuation?.state==='blocked' ? 'blocked' : continuation?.state==='idle' || quiet ? 'idle' : 'running' : unconfirmed ? 'idle' : stage.status;
        const label=reopen && collaboration?.state==='planning' ? tr("等待 Codex 审计计划") : reopen && !activeReopen ? stage.status==='done'?tr("执行结束 · 待本轮审核"):tr("本轮待推进") : reopen ? status==='running' ? tr("重新推进中") : status==='blocked' ? tr("重新推进 · 待处理") : quiet ? tr("重新推进 · 等待进展确认") : tr("重新推进 · 待继续") : unconfirmed ? tr("记录进行中 · 待确认") : stageStatus(stage.status);
        return <li key={stage.id} className={`wb-research-stage is-${status}${reopen?' is-reopened':''}`} aria-current={status==='running'?'step':undefined}><span className="wb-research-stage-number">{stage.status==='accepted' && !reopen?'✓':index+1}</span><div><strong>{tr(stage.label)}</strong><span>{tr(label)}</span>{reopen ? <small>{tr("原记录：")}{stageStatus(stage.status)}</small> : null}</div></li>;
      })}</ol><p className="wb-progress-caption">{current.length ? tr("当前关注：{0}。", { 0: current.map(stage=>tr(stage.label)).join(locale === 'zh-CN' ? '、' : ', ') }) : accepted===total && total>0 ? tr("本轮阶段已验收，仍可继续迭代或指定阶段重做。") : tr("执行结束的阶段仍需确认验收。")}{affected.size ? tr(" 本轮调整涉及的阶段已重新列入进度，原验收记录保留。") : tr(" 执行结束与阶段验收分别记录。")}</p></> : <p className="wb-muted">{tr("尚未登记研究阶段，执行活动会显示在下方。")}</p>}
    </section>
    <section className="wb-card" aria-label={tr("Agent 正在做什么")}><div className="wb-section-heading"><h2>{tr("Agent 正在做什么")}</h2><span className="wb-muted">{sessions.length}  {tr("个工作会话")}</span></div>
      <div className="wb-agent-work-list">{agents.map(({session,observation,activity,recent,idle,active,quiet,label})=>{
        const role=collaboration?.state==='planning' && session.id===collaboration.reviewerSessionId ? tr("审计规划") : session.role==='reviewer'?tr("审核"):tr("执行");
        return <article key={session.id} className="wb-agent-work"><div className="wb-section-heading"><strong>{session.provider==='dsh-pi'?'DSH':session.provider==='codex'?'Codex':session.provider} · {tr(role)}</strong><span className={`wb-status${idle || quiet?' is-idle':''}`}>{tr(label)}</span></div>
          <p className="wb-agent-current">{observation?.error ? tr("状态读取失败：{0}", { 0: observation.error }) : quiet ? tr("最近工具已结束，超过 90 秒没有新消息或工具活动，正在等待进展确认。") : active ? tr("正在{0}", { 0: active.summary }) : recent ? tr("{0}：{1}", { 0: idle?tr('本轮最后操作'):tr('最近操作'), 1: recent.summary }) : idle ? role==='审核'?tr("当前闲置，等待成果交接或下一条任务。"):tr("当前没有运行中的操作，可继续发送任务。") : tr("等待执行端返回新的活动记录。")}</p>
          {recent?.at ? <small className="wb-muted">{tr("最近活动")} {new Date(recent.at).toLocaleTimeString(locale)} · {recent.status==='completed'?tr("该工具操作已结束，不代表整个任务完成"):recent.status==='failed'?tr("该工具操作失败"):tr("状态以执行端返回为准")}</small> : null}
          {recent?.error ? <p className="wb-error">{tr("最近工具返回：")}{recent.error}</p> : null}
          <ol className="wb-agent-recent">{activity.slice(-3).reverse().map(item=><li key={item.id}><span>{item.summary}</span>{item.target ? <small title={item.target}>{item.target}</small> : null}</li>)}</ol>
          <button type="button" className="wb-text-button" onClick={()=>onOpenSession(session.id)}>{tr("查看动态、对话与待处理事项 →")}</button>
        </article>;
      })}</div>
      {!sessions.length ? <p className="wb-muted">{tr("尚无工作会话，可在右侧创建。")}</p> : null}
    </section>
    <section className="wb-card wb-unified-blockers" aria-label={tr("卡住的地方")}><div className="wb-section-heading"><h2>{tr("卡住的地方")}</h2><span className="wb-status">{blockers.length}  {tr("项")}</span></div>
      {!attention.data && attention.loading ? <p>{tr("正在读取实时状态…")}</p> : null}
      {attention.error ? <p className="wb-error">{tr("实时状态读取失败：")}{attention.error.message}{tr("。不能据此认定没有阻塞。")}</p> : null}
      {blockers.map(item=><article className="wb-blocker-item" key={item.id}><strong>{item.title}</strong>{item.status==='mitigated-by-scope-change' ? <p className="wb-muted">{tr("已采用替代方案，研究范围发生变化；这不代表会话停止。")}</p> : null}<p>{item.detail}</p><small className="wb-muted">{tr("来源：")}{item.source}</small>{item.session_id ? <button className="wb-text-button" type="button" onClick={()=>onOpenSession(item.session_id!)}>{tr("打开对应会话处理 →")}</button> : null}</article>)}
      {attention.data && !blockers.length ? <p className="wb-muted">{tr("当前未发现挂起请求，也没有尚未解决的研究卡点。")}{running?tr("Agent 仍在执行，最新操作见上方。"):tr("可查看本轮结果。")}</p> : null}
    </section>
    <section className="wb-card wb-unified-decisions" aria-label={tr("待你决定")}><div className="wb-section-heading"><h2>{tr("待你决定")}</h2><button className="wb-button" onClick={onOpenRequests}>{tr("打开待处理与答复记录 →")}</button></div>
      {focus?.questions.map(item=><p key={item.id}><button className="wb-text-button" onClick={onOpenRequests}>{item.title} →</button></p>)}
      {pending.flatMap(row=>(row.approvals??[]).map(item=><p key={`${row.session?.id}:${item.id}`}><button className="wb-text-button" onClick={onOpenRequests}>{item.title || tr("会话操作请求")} →</button></p>))}
      {!focus?.questions.length && !pending.some(row=>row.approvals?.length) ? <p className="wb-muted">{tr("当前没有等待你回答的事项。")}{focus?.answeredQuestions?.length ? tr("已回答 {0} 项，可在右侧查看记录。", { 0: focus.answeredQuestions.length }) : tr("阶段成果的独立评审由 Agent 处理。")}</p> : <p className="wb-muted">{tr("统一在右侧「待处理」回答；阶段成果评审与人工决定分开显示。")}</p>}
      {attention.error ? <p className="wb-error">{tr("会话待办暂未完整读取，请查看右侧状态。")}</p> : null}
    </section>
  </div>;
}
