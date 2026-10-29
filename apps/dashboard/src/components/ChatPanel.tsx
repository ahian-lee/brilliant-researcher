import { useI18n, translate as tr } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { configureWorkbenchSession, createWorkbenchSession, fetchWorkbenchSession, interruptWorkbenchSession, sendWorkbenchMessage } from '../workbenchApi';
import { summarizeAttention } from '../attention';
import { SessionMetadata } from './SessionMetadata';
import { DirectionSync } from './DirectionSync';
import { SessionPulse } from './SessionPulse';
import { useNow } from '../hooks/useNow';
import { activityDetail, activityLabel } from '../sessionSignal';
import { pauseWorkbenchCollaboration } from '../workbenchApi';
import { ProjectAttention } from './ProjectAttention';
import type { Async } from '../hooks/useAsync';
import type { fetchWorkbenchAttention } from '../workbenchApi';
type IterationProps = {defaultAuditFirst?:boolean;iterationStages?:Array<{id:string;name:string;status:string}>;iterationRequest?:{key:number;scope:string}};
type AttentionProps = IterationProps & {attention:Async<Awaited<ReturnType<typeof fetchWorkbenchAttention>>>; focus:Overview['focus']; requestOpen:number; onOpenSession:(id:string)=>void};
import type { Overview } from '../types';
import { useAsync } from '../hooks/useAsync';
import type { WorkbenchCollaborationRun, WorkbenchMessage, WorkbenchSession } from '../workbenchTypes';
import { AgentFields, ModelFields, type AgentSelection, type ModelSelection } from './NewResearchDialog';

function submitOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>, enabled: boolean): void {
  // Enter used to confirm an IME candidate must stay with the input method.
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (enabled && !event.repeat) event.currentTarget.form?.requestSubmit();
}

export function sessionStatus(status?: string): string {
  const labels: Record<string, string> = { planning: tr("Codex 正在审计规划"), audited: tr("审计完成 · 无需新增执行"), running: tr("执行中"), idle: tr("等待消息"), waiting_input: tr("等待回复"), waiting: tr("等待中"), starting: tr("启动中"), queued: tr("排队中"), completed: tr("已完成"), succeeded: tr("已完成"), failed: tr("失败"), error: tr("执行出错"), canceled: tr("已停止"), interrupted: tr("已中断"), stopped: tr("已停止"), archived: tr("已归档"), unknown: tr("状态未知"), approved: tr("已批准"), pending: tr("待处理"), done: tr("执行完成"), accepted: tr("已验收"), skipped: tr("已跳过"), not_started: tr("未开始") };
  return labels[status || 'unknown'] || status || tr("状态未知");
}

function ChatMessage({ message, automatic }: { message: WorkbenchMessage; automatic?: string }): JSX.Element {
  const { t: tr, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  let receipt: {summary?: string; feedback?: string; kind?: string} | null = null;
  try { const value = JSON.parse(message.text.trim().replace(/^(?:---[ \t]*\r?\n\s*)+/, ''));  if (value.actionId && value.revision && ['execute', 'review', 'sync', 'plan'].includes(value.kind)) receipt = value; } catch {}
  if (automatic || receipt) return <article className="wb-message"><strong>{(automatic ? tr(automatic) : undefined) || (receipt?.kind === 'plan' ? tr("Codex 审计与计划") : receipt?.kind === 'review' ? tr("Codex 审核结果") : receipt?.kind === 'sync' ? tr("已确认项目调整") : tr("执行结果"))}</strong>{receipt ? <p>{receipt.summary || receipt.feedback}</p> : null}<details><summary>{tr("查看原始记录")}</summary><pre className="wb-message-text">{message.text}</pre></details></article>;
  const marker = '\n\n用户消息：\n';
  const displayText = message.role === 'user' && message.text.startsWith('项目目录：') && message.text.includes(marker) ? message.text.slice(message.text.indexOf(marker) + marker.length) : message.text;
  const long = displayText.length > 700;
  return <article className={`wb-message ${message.role === 'user' ? 'is-user' : ''}`}><div className="wb-message-meta"><strong>{message.role === 'user' ? tr("你") : message.role === 'assistant' ? 'Agent' : message.role === 'tool' ? tr("工具") : message.role}</strong>{message.at ? <time>{new Date(message.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time> : null}</div><div className="wb-message-text">{long && !expanded ? `${displayText.slice(0, 320)}…` : displayText}{long ? <button type="button" className="wb-text-button wb-expand-message" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? tr("收起完整消息") : tr("展开完整消息")}</button> : null}</div></article>;
}

function SessionModelValues({ session }: { session: WorkbenchSession }): JSX.Element {
  const { t: tr } = useI18n();
  return <dl className="wb-model-values"><div><dt>{tr("配置模型")}</dt><dd>{session.configuredModel === undefined ? tr("执行端未返回配置") : session.configuredModel || tr("执行端默认")}</dd></div><div><dt>{tr("配置思考档位")}</dt><dd>{session.configuredThinkingOptionId === undefined ? tr("执行端未返回配置") : session.configuredThinkingOptionId || tr("执行端默认")}</dd></div><div><dt>{tr("实际运行模型")}</dt><dd>{session.runtimeModel || tr("执行端未返回")}</dd></div><div><dt>{tr("实际思考档位")}</dt><dd>{session.thinkingOptionId || tr("执行端未返回")}</dd></div></dl>;
}

function SessionConfiguration({ projectId, session, editable, blockedReason, onBusyChange, onSaved }: {
  projectId: string; session: WorkbenchSession; editable: boolean; blockedReason: string;
  onBusyChange: (busy: boolean) => void; onSaved: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const formId = useId();
  const [choice, setChoice] = useState<ModelSelection>({ model: session.configuredModel || '', thinkingOptionId: session.configuredThinkingOptionId || '' });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ session: WorkbenchSession; notice?: string } | null>(null);
  const active = useRef(true);
  const submitting = useRef(false);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;
  useEffect(() => { active.current = true; return () => { active.current = false; busyChange.current(false); }; }, []);
  return <form className="wb-form wb-session-config" onSubmit={(event) => {
    event.preventDefault();
    if (!editable || !ready || submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange(true); setError(''); setResult(null);
    configureWorkbenchSession(projectId, session.id, { model: choice.model || null, thinkingOptionId: choice.thinkingOptionId || null }).then((response) => {
      if (!active.current) return;
      if (!response.ok || !response.session) throw new Error(response.error || '配置保存未成功。');
      setResult({ session: response.session, notice: response.notice });
      setChoice({ model: response.session.configuredModel || '', thinkingOptionId: response.session.configuredThinkingOptionId || '' });
      onSaved();
    }).catch((err: unknown) => { if (active.current) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { submitting.current = false; if (active.current) { setBusy(false); onBusyChange(false); } });
  }}>
    <p className="wb-muted">{tr("执行者：")}{session.provider}{tr("。只调整本会话模型与思考档位；实际值以执行端返回为准。")}</p>
    <SessionModelValues session={session} />
    {!editable && !busy ? <p className="wb-muted" role="status">{blockedReason}</p> : null}
    <ModelFields provider={session.provider} value={choice} onChange={setChoice} onValidityChange={setReady} disabled={busy || !editable} idPrefix={`${formId}-config`} />
    {error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}
    {result ? <div className="wb-config-result" role="status"><strong>{tr("已保存")}</strong>{result.notice ? <p>{result.notice}</p> : null}<p className="wb-muted">{tr("本次保存返回的配置与实际值：")}</p><SessionModelValues session={result.session} /></div> : null}
    <div className="wb-form-footer"><button type="submit" className="wb-button primary" disabled={busy || !editable || !ready}>{busy ? tr("正在保存…") : tr("保存模型与思考")}</button></div>
  </form>;
}

function ChatConversation({ projectId, sessionId, sessions, onNewSession, collaboration, onCollaborationChanged, questions, attention, focus, requestOpen, onOpenSession, onReviewerCreated, iterationStages=[], iterationRequest, defaultAuditFirst=false }: { projectId: string; sessionId: string; sessions: WorkbenchSession[]; onNewSession: () => void; onReviewerCreated:(session:WorkbenchSession)=>void; questions: NonNullable<Overview['focus']>['questions']; collaboration?: WorkbenchCollaborationRun | null; onCollaborationChanged?: () => void } & AttentionProps): JSX.Element {
  const { t: tr, locale } = useI18n();
  const [panel,setPanel]=useState<'activity'|'chat'|'requests'>(requestOpen ? 'requests' : 'activity');
  useEffect(()=>{if(requestOpen)setPanel('requests');},[requestOpen]);
  const {humanCount:requestCount,automaticCount}=summarizeAttention(attention.data?.pending??[],questions.length);
  const [revision, setRevision] = useState(0);
  const [text, setText] = useState('');
  const [iteration,setIteration]=useState('');
  const [auditFirst,setAuditFirst]=useState(defaultAuditFirst);
  useEffect(()=>{setAuditFirst(defaultAuditFirst);},[defaultAuditFirst]);
  useEffect(()=>{if(iterationRequest?.key){setIteration(iterationRequest.scope);setAuditFirst(true);setText(previous=>previous.trim()?previous:tr('请检查已有成果，提出改进建议并继续迭代。'));setPanel('chat');setHandoff(null);}},[iterationRequest?.key]);
  const [repairBusy,setRepairBusy]=useState(false);
  const [pending, setPending] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [handoff, setHandoff] = useState<{ id: string; text: string } | null>(null);
  const [targetId, setTargetId] = useState('');
  const [handoffInstruction, setHandoffInstruction] = useState('');
  const sending = useRef(false);
  const active = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [unread, setUnread] = useState(false);
  const state = useAsync(() => fetchWorkbenchSession(projectId, sessionId), [projectId, sessionId, revision], { resetKey: `${projectId}:${sessionId}`, pollMs: 2500 });
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const messages = state.data?.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && message.text.trim());
  const targets = sessions.filter((session) => session.id !== sessionId && session.status !== 'archived');
  const target = targets.find((session) => session.id === targetId);
  const currentSession = state.data?.session ?? sessions.find(session=>session.id===sessionId);
  const bound = !!collaboration && [collaboration.executorSessionId, collaboration.reviewerSessionId].includes(sessionId);
  const canPlan=bound || !collaboration && sessions.some(s=>s.id===sessionId&&s.role==='executor') && sessions.some(s=>s.role==='reviewer'&&s.provider==='codex');
  const canIterate=iterationStages.length>0;
  const reviewerMissing=!canPlan && (!!iteration || !!iterationRequest?.key);
  const canSend = (!!text.trim() || canPlan && auditFirst && !!iterationRequest?.key) && !reviewerMissing && !repairBusy && !pending && !configBusy && !action && !!currentSession && currentSession.status !== 'archived';
  const canHandoff = !!handoff && !!target && !!handoffInstruction.trim() && !pending && !configBusy && !action;
  const approvals = state.data?.approvals ?? [];
  const now = useNow();

  const loopActive = bound && !['paused', 'accepted', 'audited', 'budget_exhausted', 'needs_attention'].includes(collaboration!.state);
  const canConfigure = !loopActive && !!currentSession && ['idle', 'stopped', 'completed', 'succeeded', 'failed', 'error', 'canceled', 'interrupted'].includes(currentSession.status) && !approvals.length && !pending && !action;
  const configBlockedReason = loopActive ? collaboration?.state === 'planning' ? tr("Codex 正在审计规划，请先暂停协作再更换模型。") : tr("请先暂停自动协作，再更换模型。") : approvals.length || ['starting', 'queued', 'running', 'waiting_input', 'waiting'].includes(currentSession?.status || '') ? tr("当前回合正在运行或等待审批，请先结束当前回合后调整。") : pending || action ? tr("请等待当前操作结束后调整。") : tr("当前会话状态尚未确认空闲，暂不能保存配置。");
  useEffect(() => {
    if(panel!=='chat'||approvals.length||!body.current)return;
    if(follow.current)body.current.scrollTop=body.current.scrollHeight;
    else setUnread(true);
  }, [lastMessage?.id,lastMessage?.text,approvals.length,panel]);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const message = text.trim();
    if (!canSend || sending.current) return;
    if((iteration||iterationRequest?.key)&&!canPlan){setError('阶段重做需要独立审核会话，请先修复审核连接。');return;}
    sending.current = true; setPending(true); setError(''); setNotice('');
    try {
      const result = await sendWorkbenchMessage(projectId, sessionId, message, iteration || undefined, canPlan ? auditFirst : undefined);
      if (!active.current) return;
      if (!result.accepted) throw new Error(result.error || tr("消息未被接收，请重试。"));
      setText(''); setIteration(''); setNotice(canPlan && auditFirst ? "已交给 Codex 审计规划；范围内的计划会自动进入 DSH 执行与独立审核。" : bound ? "本轮要求已接收，执行与审核会按新要求推进；阶段进度会随执行更新。" : "消息已接收；执行结果将在会话中更新。"); setRevision((n) => n + 1);
      onCollaborationChanged?.();
    } catch (err) { if (active.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { sending.current = false; if (active.current) setPending(false); }
  };
  const submitHandoff = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canHandoff || !handoff || !target || sending.current) return;
    const selectedTarget = target;
    const sourceTitle = state.data?.session?.title || sessionId;
    const message = [handoffInstruction.trim(), `以下是本项目另一会话的成果引用（会话：${sourceTitle}；消息：${handoff.id}），请结合任务自行核实并继续：`, handoff.text.split('\n').map((line) => `> ${line}`).join('\n')].join('\n\n');
    sending.current = true; setPending(true); setError(''); setNotice('');
    try {
      const result = await sendWorkbenchMessage(projectId, selectedTarget.id, message);
      if (!active.current) return;
      if (!result.accepted) throw new Error(result.error || tr("交接消息未被接收，请重试。"));
      setHandoff(null); setHandoffInstruction(''); setTargetId('');
      setNotice(tr("交接已发送到「{0}」；接收不代表执行完成，请选择该会话查看后续。", { 0: selectedTarget.title || selectedTarget.provider }));
    } catch (err) { if (active.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { sending.current = false; if (active.current) setPending(false); }
  };
  const runAction = async (id: string, operation: () => Promise<{ ok: boolean; error?: string }>, message: string): Promise<void> => {
    if (action || pending || configBusy) return;
    setAction(id); setError(''); setNotice('');
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error || tr("操作未成功。"));
      if (active.current) { setNotice(message); setRevision((n) => n + 1); onCollaborationChanged?.(); }
    } catch (err) { if (active.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (active.current) setAction(''); }
  };
  return <>
    <div className="wb-chat-tabs" role="tablist" aria-label={tr("会话内容")}>{([['activity',tr("动态")],['chat',tr("对话")],['requests',tr("待处理{0}", { 0: requestCount ? ` · ${requestCount}` : '' })]] as const).map(([id,label])=><button key={id} type="button" role="tab" aria-selected={panel===id} onClick={()=>setPanel(id)}>{tr(label)}</button>)}</div>
    {(requestCount)>0 && panel!=='requests' ? <button type="button" className="wb-pending-banner" onClick={()=>setPanel('requests')}>{requestCount}  {tr("项需要查看 · 点击回答或处理 →")}</button> : null}
    <div className="wb-chat-body" data-testid="session-content" ref={body} onScroll={event=>{const el=event.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<90;if(follow.current)setUnread(false);}}>
    {currentSession?<SessionPulse session={currentSession} detail={state.data??undefined} now={now} observedAt={state.lastOkAt} readError={state.error?.message} refreshing={state.loading} onRefresh={()=>{setRevision(n=>n+1);onCollaborationChanged?.();}} onRequests={()=>setPanel('requests')} onConversation={()=>{setPanel('chat');document.getElementById('chat-message')?.focus();}} onConfigure={canConfigure?()=>{setConfigOpen(true);setTimeout(()=>body.current?.querySelector('.wb-model-panel')?.scrollIntoView({block:'nearest'}),0);}:undefined}/>:null}
    <div className="wb-session-controls"><button className="wb-text-button" type="button" onClick={()=>{setPanel('chat');document.getElementById('chat-message')?.focus();}}>{tr('补充要求 / 改方向')}</button>{loopActive?<button type="button" className="wb-text-button" disabled={!!action||pending||collaboration?.state==='stopping'} onClick={()=>void runAction('pause',()=>pauseWorkbenchCollaboration(projectId).then(()=>({ok:true})),'已请求暂停协作，正在等待执行端停止确认。')}>{action==='pause'?tr('正在请求…'):tr('暂停协作')}</button>:!bound&&['running','starting','waiting_input'].includes(currentSession?.status||'')?<button type="button" className="wb-text-button" disabled={!!action||pending} onClick={()=>void runAction('interrupt',()=>interruptWorkbenchSession(projectId,sessionId),'已请求停止当前回合。')}>{tr('停止当前会话')}</button>:null}</div>
    {automaticCount && !requestCount ? <p className="wb-muted" role="status">{tr('自动审核进行中 · {0}',{0:automaticCount})} · {tr('当前无需你批准。')}</p> : null}
    {currentSession?<details className="wb-chat-session-meta"><summary>{tr('会话归属与用量')}</summary><SessionMetadata session={currentSession} sessions={sessions} onOpenSession={onOpenSession}/></details>:null}
    {bound && collaboration?<DirectionSync run={collaboration}/>:null}
    <p className="wb-chat-collaboration">{bound ? tr("消息会同步执行与审核会话。") : tr("消息发送给当前选择的会话。")}{currentSession?.permissionPreset==='danger-full-access'||currentSession?.modeId==='full-access' ? tr(" 项目范围内自主执行。") : ''}</p>
    {panel==='activity' ? <section className="wb-activity-feed" aria-label={tr("当前会话动态")}><h3>{tr("最近在做什么")}</h3>{(state.data?.activity??[]).length ? <ol>{[...(state.data?.activity??[])].reverse().map(item=><li key={item.id}><div><strong>{tr(activityLabel(item))}</strong><span>{item.status==='completed'?tr("操作已结束"):item.status==='failed'?tr("操作失败"):['running','in_progress','pending'].includes(item.status||'')?tr("正在执行"):tr("已记录")}</span></div>{item.at ? <time>{new Date(item.at).toLocaleTimeString(locale)}</time> : null}<p className="wb-activity-target">{activityDetail(item).text}</p>{item.error ? <p className="wb-error">{item.error}</p> : null}{item.description && item.description!==item.summary ? <details><summary>{tr("执行者的原始说明")}</summary><p>{item.description}</p></details> : null}</li>)}</ol> : <p className="wb-muted">{state.loading?tr("正在读取最近活动…"):currentSession?.status==='idle'?tr("此会话当前没有正在执行的操作。"):tr("会话运行中，执行端尚未提供工具活动。")}</p>}{lastAssistant ? <details><summary>{tr("最近一次文字汇报")}</summary><ChatMessage message={lastAssistant}/></details> : null}</section> : null}
    {panel==='chat' ? <div className="wb-chat-messages" aria-label={tr("会话消息")}>{messages.filter(message=>message.text.trim()).map(message=>{const automatic=collaboration?.actions.find(action=>action.prompt&&message.text.endsWith(action.prompt));return <ChatMessage key={message.id} message={message} automatic={automatic ? automatic.kind==='plan'?tr("Codex 审计规划任务"):automatic.kind==='sync'?tr("同步项目调整"):automatic.kind==='review'?tr("发起独立审核"):tr("派发执行任务"):undefined}/>;})}{!messages.some(message=>message.text.trim()) ? <p className="wb-muted">{tr("尚无文字消息，可以在下方发送任务。")}</p> : null}<div ref={end}/></div> : null}
    {panel==='requests' ? <section className="wb-inline-requests" aria-label={tr("项目待处理请求")}><ProjectAttention projectId={projectId} sessions={sessions} questions={questions} runId={focus?.pipeline_run_id??null} answeredQuestions={focus?.answeredQuestions} state={attention} onOpenSession={id=>{onOpenSession(id);setPanel('chat');}} onRefresh={()=>{setRevision(n=>n+1);onCollaborationChanged?.();}}/></section> : null}
    {currentSession ? <details className="wb-model-panel" open={configOpen} onToggle={(event) => setConfigOpen(event.currentTarget.open)}><summary onClick={(event) => { if (configBusy) event.preventDefault(); }}>{tr("模型与思考")}</summary>{configOpen ? <SessionConfiguration key={`${projectId}:${sessionId}`} projectId={projectId} session={currentSession} editable={canConfigure} blockedReason={configBlockedReason} onBusyChange={setConfigBusy} onSaved={() => setRevision((n) => n + 1)} /> : null}</details> : null}
    <details className="wb-chat-more"><summary>{tr("更多操作")}</summary><button type="button" className="wb-text-button" disabled={bound || pending || !!action} onClick={()=>void runAction('interrupt',()=>interruptWorkbenchSession(projectId,sessionId),'已请求停止当前回合。')}>{tr("停止当前会话")}</button><button type="button" className="wb-text-button" disabled={bound || !lastAssistant || pending} onClick={()=>{if(lastAssistant){setHandoff({id:lastAssistant.id,text:lastAssistant.text});setTargetId('');setHandoffInstruction('');}}}>{tr("手动交接给其他会话")}</button>{bound ? <p>{tr("自动协作会统一处理暂停和交接。")}</p> : null}<button className="wb-text-button" type="button" onClick={onNewSession}>{tr("新建工作会话")}</button></details>
    {error ? <p className="wb-error" role="alert">{error}</p> : null}{notice ? <p className="wb-notice" role="status">{tr(notice)}</p> : null}
    </div>
    {unread&&panel==='chat'?<button type="button" className="wb-new-message" onClick={()=>{follow.current=true;setUnread(false);if(body.current)body.current.scrollTop=body.current.scrollHeight;}}>{tr('有新消息 · 回到底部 ↓')}</button>:null}
    {reviewerMissing?<section className="wb-reviewer-repair" role="alert"><p>{tr('阶段重做需要独立审核会话，请先修复审核连接。')}</p><p className="wb-muted">{tr('已保留所选阶段与草稿。创建空闲审核会话不会启动模型；完成后再发送本轮要求。')}</p><button type="button" className="wb-button" disabled={repairBusy||pending} onClick={()=>{
      if(repairBusy)return;setRepairBusy(true);setError('');
      createWorkbenchSession(projectId,{provider:'codex',role:'reviewer',workflow:'free',idle:true}).then(result=>{
        if(!active.current)return;
        if(!result.session)throw new Error(result.error||tr('服务未返回新会话。'));
        onReviewerCreated(result.session);onOpenSession(sessionId);setNotice('空闲审核会话已连接，可继续发送。');
      }).catch(err=>{if(active.current)setError(err instanceof Error?err.message:String(err));}).finally(()=>{if(active.current)setRepairBusy(false);});
    }}>{repairBusy?tr('正在连接审核会话…'):tr('创建空闲 Codex 审核会话')}</button></section>:null}
    {panel==='requests' ? <p className="wb-request-footer">{requestCount ? tr("请填写对应问题并使用它的提交按钮。普通消息请切换到「对话」。") : tr("没有待处理事项。可切换到「动态」看进展，或到「对话」补充要求。")}</p> : handoff && !bound ? <form className="wb-chat-compose wb-handoff" onSubmit={(event) => void submitHandoff(event)}><div className="wb-section-heading"><strong>{tr("交给另一个会话")}</strong><button type="button" className="wb-icon-button" aria-label={tr("取消交接")} onClick={() => setHandoff(null)} disabled={pending || configBusy}>×</button></div><details><summary>{tr("查看将引用的最后一条 Agent 回复")}</summary><blockquote>{handoff.text}</blockquote></details>{targets.length ? <><label htmlFor="handoff-target">{tr("接收会话")}<select id="handoff-target" value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={pending || configBusy} required><option value="">{tr("选择本项目的另一个会话")}</option>{targets.map((session) => <option key={session.id} value={session.id}>{session.title || session.id} · {session.provider} · {sessionStatus(session.status)}</option>)}</select></label><label htmlFor="handoff-instruction">{tr("交接说明")}<textarea id="handoff-instruction" rows={3} value={handoffInstruction} onChange={(event) => setHandoffInstruction(event.target.value)} onKeyDown={(event) => submitOnEnter(event, canHandoff)} aria-describedby="handoff-keyboard-hint" disabled={pending || configBusy} required placeholder={tr("希望对方如何处理这些成果？例如：审核实现，补充测试，或继续绘图。")} /></label><div><span className="wb-muted" id="handoff-keyboard-hint">{tr("Enter 发送 · Shift+Enter 换行")}</span><button type="submit" className="wb-button primary" disabled={!canHandoff}>{pending ? tr("发送中…") : tr("发送交接")}</button></div></> : <p className="wb-muted">{tr("本项目还没有其他可接收的会话。")}<button type="button" className="wb-text-button" onClick={onNewSession}>{tr("先新建一个会话")}</button></p>}</form> : <form className="wb-chat-compose" onSubmit={(event) => void submit(event)}>{canIterate ? <label className="wb-iteration-choice" htmlFor="iteration-scope">{tr("本轮修改范围")}<select id="iteration-scope" value={iteration} disabled={pending || configBusy} onChange={event=>{setIteration(event.target.value);if(event.target.value)setAuditFirst(true);}}><option value="">{tr("按消息内容继续")}</option><option value="all">{tr("从头重做已启用的流程")}</option><optgroup label={tr("从某一步往后重做")}>{iterationStages.map(stage=><option key={stage.id} value={`from:${stage.id}`}>{tr("从「")}{tr(stage.name)}{tr("」继续")}</option>)}</optgroup><optgroup label={tr("只重做某一步")}>{iterationStages.map(stage=><option key={stage.id} value={`only:${stage.id}`}>{tr("只重做「")}{tr(stage.name)}」</option>)}</optgroup></select>{iteration ? <small>{tr("可以补充改进要求，也可以直接发送，交给 Codex 提出建议。旧轮次保留。")}</small> : null}</label> : null}{canPlan ? <label className="wb-audit-choice"><input type="checkbox" checked={auditFirst} disabled={pending || configBusy} onChange={event=>setAuditFirst(event.target.checked)}/><span>{tr("Codex 先审计并提出计划")}<small>{auditFirst ? tr("范围内自动执行；范围、费用或方向需要选择时再请你决定。") : tr("按下方指定任务直接执行，完成后仍由 Codex 审核。")}</small></span></label> : null}<label className="wb-sr-only" htmlFor="chat-message">{bound ? tr("调整项目方向，同步执行与审核") : tr("发消息给当前 agent")}</label><textarea id="chat-message" rows={3} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => submitOnEnter(event, canSend)} aria-describedby="chat-keyboard-hint" disabled={pending || configBusy} placeholder={auditFirst && canPlan ? tr("可以只说继续迭代，也可以补充改进要求…") : iteration ? tr("哪里不满意？希望重新考虑什么？") : tr("补充要求、调整方向，或说明哪里需要重做…")} /><div><span className="wb-muted" id="chat-keyboard-hint">{tr("Enter 发送 · Shift+Enter 换行")}</span><button type="submit" className="wb-button primary" disabled={!canSend}>{pending ? tr("发送中…") : tr("发送")}</button></div></form>}
  </>;
}

export function StartSessionForm({ projectId, workflow = 'free', onStarted, onCancel }: { projectId: string; workflow?: string; onStarted: (session: WorkbenchSession, error?: string) => void; onCancel: () => void }): JSX.Element {
  const { t: tr } = useI18n();
  const formId = useId();
  const [agent, setAgent] = useState<AgentSelection>({ provider: '', model: '', thinkingOptionId: '', ready: false });
  const [role, setRole] = useState<'executor' | 'reviewer'>('executor');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return <form className="wb-form wb-session-form" onSubmit={(event) => {
    event.preventDefault();
    if (!agent.ready || submitting.current || (workflow === 'free' && !prompt.trim())) return;
    submitting.current = true; setBusy(true); setError('');
    createWorkbenchSession(projectId, { provider: agent.provider, model: agent.model || undefined, thinkingOptionId: agent.thinkingOptionId || undefined, workflow, role, prompt: prompt.trim() || undefined }).then((result) => {
      if (!active.current) return;
      if (!result.session) setError(result.error || '服务未返回新会话。');
      else onStarted(result.session, result.error);
    }).catch((err: unknown) => { if (active.current) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { submitting.current = false; if (active.current) setBusy(false); });
  }}>
    <AgentFields idPrefix={`${formId}-session`} value={agent} onChange={setAgent} disabled={busy} />
    <label htmlFor={`${formId}-role`}>{tr("会话角色")}<select id={`${formId}-role`} value={role} onChange={(event) => setRole(event.target.value as 'executor' | 'reviewer')} disabled={busy}><option value="executor">{tr("执行任务")}</option><option value="reviewer">{tr("独立审核")}</option></select></label>
    <label htmlFor={`${formId}-prompt`}>{tr("本次任务 / 首条指令")}<textarea id={`${formId}-prompt`} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy} required={workflow === 'free'} placeholder={tr("补充这次会话需要完成的任务")} /></label>
    {error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}
    <div className="wb-form-footer"><button type="button" className="wb-button" onClick={onCancel} disabled={busy}>{tr("取消")}</button><button type="submit" className="wb-button primary" disabled={busy || !agent.ready || (workflow === 'free' && !prompt.trim())}>{busy ? tr("正在启动…") : tr("启动新会话")}</button></div>
  </form>;
}

export function ChatPanel({ projectId, sessions, selectedId, onSelect, onStarted, onCollapse, collaboration, onCollaborationChanged, questions, loading, attention, focus, requestOpen, onOpenSession, iterationStages=[], iterationRequest, defaultAuditFirst=false }: {
  projectId: string; sessions: WorkbenchSession[]; selectedId: string; onSelect: (id: string) => void; onStarted: (session: WorkbenchSession, error?: string) => void; onCollapse: () => void; loading?: boolean; collaboration?: WorkbenchCollaborationRun | null; questions: NonNullable<Overview['focus']>['questions']; onCollaborationChanged?: () => void;
} & AttentionProps): JSX.Element {
  const { t: tr } = useI18n();
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (iterationRequest?.key) setCreating(false); }, [iterationRequest?.key]);
  return <aside className="wb-chat" id="wb-chat-panel" aria-label={tr("项目对话")}>
    <div className="wb-chat-heading"><div><span className="wb-eyebrow">{tr("随时协作")}</span><h2>{tr("项目对话")}</h2></div><button type="button" className="wb-icon-button" onClick={onCollapse} aria-label={tr("收起对话区")}>→</button></div>
    <div className="wb-session-picker"><label className="wb-sr-only" htmlFor="chat-session">{tr("当前会话")}</label><select id="chat-session" value={selectedId} onChange={(event) => onSelect(event.target.value)} disabled={!sessions.length}><option value="">{tr("选择会话")}</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.delegation?.parentSessionId?'↳ ':''}{session.title || session.id} · {session.provider==='dsh-pi'?'DSH':session.provider==='codex'?'Codex':session.provider} · {session.role==='reviewer'?tr('审核'):tr("执行")} · {sessionStatus(session.status)}</option>)}</select><button type="button" className="wb-button" onClick={() => setCreating((value) => !value)} aria-expanded={creating}>{tr("＋ 新会话")}</button></div>
    {creating ? <StartSessionForm projectId={projectId} onCancel={() => setCreating(false)} onStarted={(session, error) => { setCreating(false); onStarted(session, error); }} /> : selectedId ? <ChatConversation defaultAuditFirst={defaultAuditFirst} iterationStages={iterationStages} iterationRequest={iterationRequest} key={`${projectId}:${selectedId}`} projectId={projectId} sessionId={selectedId} sessions={sessions} onNewSession={() => setCreating(true)} onReviewerCreated={onStarted} questions={questions} attention={attention} focus={focus} requestOpen={requestOpen} onOpenSession={onOpenSession} collaboration={collaboration} onCollaborationChanged={onCollaborationChanged} /> : <div className="wb-empty">{loading ? tr("正在读取项目会话与当前状态…") : tr("选择一个已有会话，或新建会话开始协作。")}</div>}
  </aside>;
}
