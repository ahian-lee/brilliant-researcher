import { useI18n, catalogGroupKey } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchWorkbenchAttention, fetchWorkbenchProject, fetchWorkbenchSkill, fetchWorkbenchSkills, workbenchArtifactUrl } from '../workbenchApi';
import { useAsync, type Async } from '../hooks/useAsync';
import type { Overview, Project } from '../types';
import type { WorkbenchFigure, WorkbenchSession, WorkbenchSkill, WorkbenchWorkflow } from '../workbenchTypes';
import { ChatPanel, sessionStatus, StartSessionForm } from '../components/ChatPanel';
import { ProjectOverview } from '../components/ProjectOverview';
import { ProjectScope } from '../components/ProjectScope';
import { ProjectActions } from '../components/ProjectActions';
import { ProjectBudget } from '../components/ProjectBudget';
import { version } from '../../../../package.json';
import { CollaborationPanel } from '../components/CollaborationPanel';
import '../styles/workbench.css';

function FigureCard({ figure, projectId }: { figure: WorkbenchFigure; projectId: string }): JSX.Element {
  const { t: tr } = useI18n();
  const [failed, setFailed] = useState(false);
  const baseUrl = workbenchArtifactUrl(projectId, figure.path);
  const url = figure.updatedAt ? `${baseUrl}&updatedAt=${encodeURIComponent(figure.updatedAt)}` : baseUrl;
  useEffect(() => { setFailed(false); }, [url]);
  const isPdf = /\.pdf$/i.test(figure.path);
  const isImage = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(figure.path);
  return <article className="wb-figure">
    <div className="wb-figure-preview">{isImage && !failed ? <img src={url} alt={figure.title || figure.path} loading="lazy" onError={() => setFailed(true)} /> : isPdf ? <object data={url} type="application/pdf" aria-label={figure.title}><a href={url} target="_blank" rel="noreferrer">{tr("打开 PDF 预览")}</a></object> : <div className="wb-empty">{failed ? tr("暂时无法加载预览") : tr("此格式暂无内嵌预览")}</div>}</div>
    <div className="wb-figure-caption"><strong>{figure.title || figure.path.split('/').pop()}</strong><span>{figure.stage || tr("未关联阶段")}</span>{isPdf || isImage ? <a href={url} target="_blank" rel="noreferrer">{isPdf ? tr("打开 PDF") : tr("查看原图")} ↗</a> : null}<small title={figure.path}>{figure.path}</small></div>
  </article>;
}

export function Figures({ figures, projectId }: { figures: WorkbenchFigure[]; projectId: string }): JSX.Element {
  const { t: tr } = useI18n();
  return <div className="wb-gallery">{!figures.length ? <section className="wb-card wb-empty"><strong>{tr("图表会在这里汇集")}</strong><p>{tr("绘图阶段写入的图表、主图和补充图会自动出现在项目图库。")}</p></section> : ['main', 'supplementary', 'unclassified'].map((role) => {
    const group = figures.filter((figure) => role === 'unclassified' ? !['main', 'supplementary'].includes(figure.role) : figure.role === role);
    return group.length ? <section key={role}><div className="wb-section-heading"><h2>{role === 'main' ? tr("主图") : role === 'supplementary' ? tr("补充图表") : tr("其他图表")}</h2><span className="wb-muted">{group.length}  {tr("张")}</span></div><div className="wb-figure-grid">{group.map((figure) => <FigureCard key={figure.path} projectId={projectId} figure={figure} />)}</div></section> : null;
  })}</div>;
}

export function WorkflowCard({ workflow, projectId, figures, onSelectRun, onSelectSkill, historical, onIterate }: {
  historical?: boolean; onIterate: (scope:string)=>void; workflow: WorkbenchWorkflow; projectId: string; figures: WorkbenchFigure[]; onSelectRun: (runId: string) => void; onSelectSkill: (id: string) => void;
}): JSX.Element {
  const { t: tr, locale } = useI18n();
  const [stepId, setStepId] = useState('');
  const step = workflow.steps.find((item) => item.id === stepId);
  const related = figures.filter((figure) => step && (figure.stage === step.id || figure.stage === step.name || figure.path === step.artifact || (step.artifact && figure.path.startsWith(`${step.artifact}/`))));
  return <section className="wb-card wb-workflow"><div className="wb-section-heading"><div><span className="wb-eyebrow">{historical ? tr("历史轮次") : tr("当前轮次")}</span><h2>{workflow.skillId==='research-pipeline' ? tr("研究流程") : tr(workflow.name)}</h2></div><span className="wb-status">{sessionStatus(workflow.status)}</span></div>
    <p className="wb-muted wb-run-date">{workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString(locale) : tr("尚无更新时间")} · {workflow.steps.length}  {tr("个阶段")}</p>
    {workflow.summary ? <p className="wb-muted">{workflow.summary}</p> : null}
    <ol className="wb-workflow-steps">{workflow.steps.map((item, index) => <li key={item.id}><button type="button" className={stepId === item.id ? 'is-selected' : ''} onClick={() => setStepId(stepId === item.id ? '' : item.id)} aria-expanded={stepId === item.id}><span className="wb-step-number">{index + 1}</span><strong>{tr(item.name)}</strong><span className="wb-status">{sessionStatus(item.status)}</span></button></li>)}</ol>
    {!workflow.steps.length ? <p className="wb-muted">{tr("流程尚未写入阶段记录。")}</p> : null}
    {step ? <div className="wb-step-detail"><strong>{tr(step.name)}</strong><button className="wb-text-button" type="button" onClick={()=>onIterate(`from:${step.id}`)}>{tr("从此阶段重做 →")}</button><p>{tr("阶段状态：")}{sessionStatus(step.status)}{step.updatedAt ? tr(" · 更新于 {0}", { 0: new Date(step.updatedAt).toLocaleString(locale) }) : ''}</p>{step.artifact ? <p className="wb-artifact-path">{tr("阶段产物：")}{step.artifact}</p> : <p className="wb-muted">{tr("此阶段还没有登记产物。")}</p>}{related.length ? <div className="wb-figure-grid">{related.map((figure) => <FigureCard key={figure.path} figure={figure} projectId={projectId} />)}</div> : null}</div> : null}
    <div className="wb-workflow-actions">{workflow.runId ? <button type="button" className="wb-text-button" onClick={() => onSelectRun(workflow.runId as string)}>{tr("查看执行记录 ↗")}</button> : null}<button type="button" className="wb-text-button" onClick={() => onSelectSkill(workflow.skillId || 'research-pipeline')}>{tr("查看流程说明 ↗")}</button></div>
  </section>;
}

function SkillDetail({ skillId, projectId, onClose, onStarted }: { skillId: string; projectId: string; onClose: () => void; onStarted: (session: WorkbenchSession, error?: string) => void }): JSX.Element {
  const { t: tr } = useI18n();
  const state = useAsync(() => fetchWorkbenchSkill(skillId), [skillId], { resetKey: skillId });
  const [starting, setStarting] = useState(false);
  const skill = state.data?.skill;
  const detail = useRef<HTMLElement>(null);
  useEffect(() => { detail.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);
  return <section ref={detail} className="wb-card wb-skill-detail" aria-label={tr("技能详情")}><div className="wb-section-heading"><div><span className="wb-eyebrow">{skill?.group ? tr(catalogGroupKey(skill.group)) : 'ARIS Skill'}</span><h2>{tr(skill?.title || skill?.name || skillId)}</h2></div><button type="button" className="wb-icon-button" onClick={onClose} aria-label={tr("关闭技能详情")}>×</button></div>
    {state.loading ? <p className="wb-muted">{tr("正在读取技能说明…")}</p> : null}{state.error || state.data?.error ? <p className="wb-error" role="alert">{state.data?.error || state.error?.message}</p> : null}
    {skill ? <><p>{skill.description}</p>{skill.steps?.length ? <ol className="wb-skill-steps">{skill.steps.map((step, index) => <li key={index}>{typeof step === 'string' ? step : <><strong>{step.title || step.name || step.id || tr("阶段 {0}", { 0: index + 1 })}</strong>{step.description ? <p>{step.description}</p> : null}</>}</li>)}</ol> : null}{skill.content ? <details className="wb-skill-source"><summary>{tr("完整技能说明")}</summary><pre>{skill.content}</pre></details> : null}{starting ? <StartSessionForm key={skillId} projectId={projectId} workflow={skill.id} onCancel={() => setStarting(false)} onStarted={onStarted} /> : <button type="button" className="wb-button primary" onClick={() => setStarting(true)}>{tr("选择 agent 并执行此技能")}</button>}</> : null}
  </section>;
}

export function SkillLibrary({ skills, selected, onSelect }: { skills: WorkbenchSkill[]; selected: string; onSelect: (id: string) => void }): JSX.Element {
  const { t: tr } = useI18n();
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('全部');
  const groups = [...new Set(skills.map((skill) => skill.group || '其他'))];
  const filtered = skills.filter((skill) => (group === '全部' || (skill.group || '其他') === group) && `${skill.name} ${skill.title} ${tr(skill.title)} ${skill.description}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="wb-skill-library"><div className="wb-section-heading"><div><span className="wb-eyebrow">{tr("从研究到论文")}</span><h2>{tr("ARIS 技能与流程")}</h2></div><span className="wb-muted">{skills.length}  {tr("项")}</span></div>
    <div className="wb-skill-filters"><label className="wb-sr-only" htmlFor="skill-search">{tr("搜索技能")}</label><input id="skill-search" type="search" placeholder={tr("搜索技能、流程或用途")} value={search} onChange={(event) => setSearch(event.target.value)} /><label className="wb-sr-only" htmlFor="skill-group">{tr("技能分组")}</label><select id="skill-group" value={group} onChange={(event) => setGroup(event.target.value)}><option value="全部">{tr("全部")}</option>{groups.map((item) => <option key={item} value={item}>{tr(catalogGroupKey(item))}</option>)}</select></div>
    <div className="wb-skill-grid">{filtered.map((skill) => <button type="button" className={`wb-skill-card${selected === skill.id ? ' is-selected' : ''}`} key={skill.id} onClick={() => onSelect(skill.id)}><span className="wb-eyebrow">{skill.group ? tr(catalogGroupKey(skill.group)) : tr('其他')}{skill.workflow ? tr(" · 流程") : ''}</span><strong>{tr(skill.title || skill.name)}</strong><p>{skill.description || tr("点击查看技能说明与执行方式。")}</p><span className="wb-text-button">{tr("查看与执行 ↗")}</span></button>)}</div>
    {!filtered.length ? <p className="wb-empty">{skills.length ? tr("没有符合条件的技能。") : tr("尚未读取到 ARIS 技能。")}</p> : null}
  </section>;
}

export function WorkbenchPage({ project, projectId, overview, revision, now, onSelectRun, onProjectChanged }: {
  project: Project | null; projectId: string; overview: Async<Overview | null>; revision: number; now: number; onSelectRun: (runId: string) => void; onProjectChanged: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [tab, setTab] = useState<'overview' | 'workflows' | 'figures'>('overview');
  const [chatOpen, setChatOpen] = useState(true);
  const [requestOpen,setRequestOpen]=useState(0);
  const [iterationRequest,setIterationRequest]=useState({key:0,scope:''});
  const openRequests=()=>{setChatOpen(true);setRequestOpen(n=>n+1);setTimeout(()=>document.getElementById('wb-chat-panel')?.scrollIntoView({behavior:'smooth',block:'start'}),0);};
  const [sessionId, setSessionId] = useState('');
  const [addedSessions, setAddedSessions] = useState<WorkbenchSession[]>([]);
  const [tick, setTick] = useState(0);
  const [skillId, setSkillId] = useState('');
  const [notice, setNotice] = useState('');
  const state = useAsync(() => fetchWorkbenchProject(projectId), [projectId, revision, tick], { resetKey: projectId, pollMs: 5000 });
  const attention = useAsync(() => fetchWorkbenchAttention(projectId), [projectId, tick], {resetKey:projectId,pollMs:5000});
  const catalog = useAsync(fetchWorkbenchSkills, []);
  const sessions = useMemo(() => {
    const map = new Map(addedSessions.map((session) => [session.id, session]));
    for (const session of state.data?.sessions ?? []) map.set(session.id, session);
    const priority=(session:WorkbenchSession)=>session.id===state.data?.collaboration?.executorSessionId ? 3 : session.role!=='reviewer' && ['running','starting','waiting_input'].includes(session.status) ? 2 : session.role!=='reviewer' ? 1 : 0;
    return [...map.values()].filter(session => !session.title.startsWith('BRI approval review ')).sort((a,b)=>priority(b)-priority(a));
  }, [addedSessions, state.data?.sessions, state.data?.collaboration?.executorSessionId]);
  useEffect(() => {
    if (!sessionId && sessions.length) setSessionId(sessions[0].id);
  }, [sessionId, sessions]);
  const selectedSession = sessions.some((session) => session.id === sessionId) ? sessionId : sessions[0]?.id || '';
  const onStarted = (session: WorkbenchSession, error?: string): void => {
    setAddedSessions((previous) => [...previous.filter((item) => item.id !== session.id), session]); setSessionId(session.id); setChatOpen(true); setSkillId(''); setTick((n) => n + 1); setNotice(error || "新会话已创建，正在读取执行状态。");
  };
  const figures = state.data?.figures ?? [];
  const workflows=state.data?.workflows??[];
  const currentWorkflow=workflows.find(w=>w.runId===state.data?.focus?.pipeline_run_id)??workflows[0];
  const history=workflows.filter(w=>w.id!==currentWorkflow?.id);
  const mode = state.data?.control?.mode || (state.data?.control?.workflow === 'free' ? 'free' : undefined);
  const focus = state.data?.focus ?? (overview.data?.project?.id === projectId ? overview.data.focus : undefined);
  const collaboration = mode === 'free' || mode === 'skill';
  const collaborationRun = state.data?.collaboration ?? null;
  const refreshCollaboration = (): void => { setTick((value) => value + 1); onProjectChanged(); };
  const openSession = (id: string): void => { setSessionId(id); setChatOpen(true); };
  const iterate=(scope:string)=>{setSessionId(collaborationRun?.executorSessionId || sessions.find(s=>s.role!=='reviewer')?.id || selectedSession);setChatOpen(true);setIterationRequest(r=>({key:r.key+1,scope}));setTimeout(()=>{document.getElementById('chat-message')?.scrollIntoView({block:'center',behavior:'smooth'});document.getElementById('chat-message')?.focus();},0);};
  return <div className={`wb-workbench ${chatOpen ? 'with-chat' : ''}`}><div className="wb-research-main">
    <p className="wb-interface-version">Brilliant Researcher · v{version}</p>
    <ProjectScope projectId={projectId} accessMode={state.data?.control?.accessMode} scope={state.data?.control?.scope} onChanged={() => setTick(n=>n+1)} />
    <ProjectBudget key={projectId} projectId={projectId} budget={state.data?.control?.budget} runBudget={collaborationRun??undefined} usage={collaborationRun?.usage} onChanged={()=>setTick(n=>n+1)}/>
    <ProjectActions projectId={projectId} completedAt={project?.completed_at} hasRunningSessions={sessions.some(session => ['starting', 'running', 'queued', 'waiting_input', 'waiting'].includes(session.status))} onChanged={onProjectChanged} />

    <div className="wb-toolbar"><div className="wb-tabs" role="tablist" aria-label={tr("项目工作台视图")}>{([['overview', tr("概览")], ['workflows', tr("流程与技能")], ['figures', tr("图表")]] as const).map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} aria-controls={`wb-tab-${id}`} id={`wb-tab-button-${id}`} key={id} className={tab === id ? 'is-selected' : ''} onClick={() => setTab(id)}>{tr(label)}{id === 'figures' && figures.length ? <span>{figures.length}</span> : null}</button>)}</div>{!chatOpen ? <button type="button" className="wb-button" onClick={() => setChatOpen(true)}>{tr("打开项目对话")}</button> : <button type="button" className="wb-button wb-mobile-chat-link" onClick={() => document.getElementById('wb-chat-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{tr("前往项目对话 ↓")}</button>}</div>
    {state.loading && !state.data ? <p className="wb-muted" role="status">{tr("正在读取流程、图表与会话…")}</p> : null}
    {state.error || state.data?.error || state.data?.control?.error ? <p className="wb-error" role="alert">{state.error?.message || state.data?.error || state.data?.control?.error}</p> : null}
    {notice ? <p className="wb-notice" role="status">{tr(notice)}<button type="button" className="wb-icon-button" aria-label={tr("关闭通知")} onClick={() => setNotice('')}>×</button></p> : null}
    <div role="tabpanel" id={`wb-tab-${tab}`} aria-labelledby={`wb-tab-button-${tab}`}>
      {tab === 'overview' && state.data ? <ProjectOverview projectId={projectId} error={state.data?.control?.error || state.data?.control?.reviewError} collaboration={collaborationRun} onIterate={()=>iterate('')} project={project} focus={focus} continuation={state.data.continuation} sessions={sessions} attention={attention} now={now} onOpenRequests={openRequests} onRefresh={refreshCollaboration} onOpenSession={id=>{openSession(id);document.getElementById('wb-chat-panel')?.scrollIntoView({behavior:'smooth',block:'start'});}} /> : null}
      {tab === 'overview' && (collaborationRun || mode==='free') ? <details className="wb-card wb-loop-records"><summary>{tr("执行与审核的协作记录")}</summary><CollaborationPanel key={projectId} projectId={projectId} run={collaborationRun} allowStart={mode==='free'} onChanged={refreshCollaboration} onOpenSession={openSession}/></details> : null}
      {tab==='overview' && figures.length>0 ? <section className="wb-card wb-overview-figures"><div className="wb-section-heading"><h2>{tr("当前图表")}</h2><button className="wb-text-button" type="button" onClick={()=>setTab('figures')}>{tr("查看全部")} {figures.length}  {tr("张 →")}</button></div><div className="wb-figure-grid">{figures.slice(0,3).map(figure=><FigureCard key={figure.path} figure={figure} projectId={projectId}/>)}</div></section> : null}
      {tab === 'workflows' ? <div className="wb-workflow-page">{currentWorkflow ? <WorkflowCard key={currentWorkflow.id} workflow={currentWorkflow} figures={figures} projectId={projectId} onSelectRun={onSelectRun} onSelectSkill={setSkillId} onIterate={iterate}/> : null}{history.length ? <details className="wb-workflow-history"><summary>{tr("历史轮次 ·")} {history.length}  {tr("轮")}</summary><p className="wb-muted">{tr("保留前轮结果与验收，展开后查看。")}</p>{history.map(workflow=><WorkflowCard key={workflow.id} historical workflow={workflow} figures={figures} projectId={projectId} onSelectRun={onSelectRun} onSelectSkill={setSkillId} onIterate={iterate}/>)}</details> : null}{!state.loading && !state.data?.workflows?.length ? <div className="wb-card wb-empty"><strong>{collaboration ? tr("按需使用 ARIS") : tr("尚无已登记的流程记录")}</strong><p>{collaboration ? tr("当前项目通过对话协作。需要特定任务或完整研究流程时，可以从下方选择。") : tr("可从下方选择技能启动执行，阶段记录会在运行后自动更新。")}</p></div> : null}{skillId ? <SkillDetail key={skillId} skillId={skillId} projectId={projectId} onClose={() => setSkillId('')} onStarted={onStarted} /> : null}{catalog.error || catalog.data?.error ? <p className="wb-error" role="alert">{tr("技能目录读取失败：")}{catalog.data?.error || catalog.error?.message}</p> : null}{catalog.loading && !catalog.data ? <p className="wb-muted">{tr("正在读取 ARIS 技能目录…")}</p> : <SkillLibrary skills={catalog.data?.skills ?? []} selected={skillId} onSelect={setSkillId} />}</div> : null}
      {tab === 'figures' ? <Figures figures={figures} projectId={projectId} /> : null}
    </div>
  </div>{chatOpen ? <ChatPanel defaultAuditFirst={collaborationRun?.auditFirst===true || ['accepted','audited','budget_exhausted'].includes(collaborationRun?.state || '') || state.data?.continuation?.state==='completed' || !!project?.completed_at} iterationStages={state.data?.iterationStages??[]} iterationRequest={iterationRequest} attention={attention} focus={focus} requestOpen={requestOpen} onOpenSession={openSession} loading={!state.data && state.loading} projectId={projectId} sessions={sessions} selectedId={selectedSession} onSelect={setSessionId} onStarted={onStarted} onCollapse={() => setChatOpen(false)} questions={focus?.questions??[]} collaboration={collaborationRun} onCollaborationChanged={refreshCollaboration} /> : null}</div>;
}
