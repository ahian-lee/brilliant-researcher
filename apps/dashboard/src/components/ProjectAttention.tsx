import { summarizeAttention } from '../attention';
import { useI18n } from '../i18n';
import { useRef, useState } from 'react';
import type { Async } from '../hooks/useAsync';
import { fetchWorkbenchAttention, answerRecordedQuestion } from '../workbenchApi';
import type { WorkbenchSession } from '../workbenchTypes';
import type { Overview } from '../types';
import { ApprovalCard, reviewLabels } from './ApprovalCard';

export function RecordedQuestion({ projectId, item, sessions, onOpenSession, runId, onHandled }: {
  runId:string|null; onHandled:()=>void; projectId: string; item: NonNullable<Overview['focus']>['questions'][number]; sessions: WorkbenchSession[]; onOpenSession: (id: string) => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const targets = sessions.filter(session => session.role !== 'reviewer' && session.status !== 'archived');
  const [target, setTarget] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const sending = useRef(false);
  const selected = targets.some(session => session.id === target) ? target : targets.length === 1 ? targets[0].id : '';
  return <article className="wb-recorded-question"><h3>{item.title}</h3><p>{item.detail}</p><small className="wb-muted">{tr("项目记录 ·")} {item.source}</small>{!notice ? <form onSubmit={event => {
    event.preventDefault(); if (!selected || !answer.trim() || sending.current) return;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    answerRecordedQuestion(projectId, {questionId:item.id,runId,sessionId:selected,answer:answer.trim()}).then(result => {
      if (!result.accepted) throw new Error(result.error || '答复未被接收');
      setAnswer(''); setNotice('已回答，已移入处理记录。执行者接收了答复，研究落实情况请查看动态。'); onHandled();
    }).catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => { sending.current = false; setBusy(false); });
  }}>
    {targets.length===1 ? <p className="wb-muted">{tr("答复给")} {targets[0].provider==='dsh-pi'?'DSH':targets[0].provider==='codex'?'Codex':targets[0].provider}  {tr("执行会话")}</p> : <label>{tr("答复给")}<select value={selected} disabled={busy} onChange={event => setTarget(event.target.value)}><option value="">{tr("选择执行会话")}</option>{targets.map(session => <option key={session.id} value={session.id}>{session.title} · {session.provider}</option>)}</select></label>}
    <label>{tr("你的决定")}<textarea rows={2} value={answer} disabled={busy} onChange={event => setAnswer(event.target.value)} placeholder={tr("说明同意的具体范围，或写下新的方向…")} /></label>
    <div className="wb-request-buttons"><button type="submit" className="wb-button primary" disabled={busy || !selected || !answer.trim()}>{busy ? tr("发送中…") : tr("发送决定")}</button><button type="button" className="wb-text-button" disabled={!selected} onClick={() => onOpenSession(selected)}>{tr("查看所选对话 ↗")}</button></div>
  </form> : null}{notice ? <p className="wb-notice" role="status">{tr(notice)}</p> : null}{error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}</article>;
}

export function ProjectAttention({ projectId, sessions, questions, onOpenSession, state, onRefresh, runId, answeredQuestions = [] }: {
  runId:string|null; answeredQuestions?:NonNullable<Overview['focus']>['answeredQuestions']; projectId: string; sessions: WorkbenchSession[]; questions: NonNullable<Overview['focus']>['questions']; onOpenSession: (id: string) => void; state: Async<Awaited<ReturnType<typeof fetchWorkbenchAttention>>>; onRefresh:()=>void;
}): JSX.Element | null {
  const { t: tr, locale } = useI18n();
  const pending = state.data?.pending ?? [];
  const history = [...(state.data?.recent ?? [])].filter(item => !pending.some(detail => detail.session?.id === item.session.id && detail.approvals?.some(approval => approval.id === item.review.approvalId))).sort((a, b) => (b.review.updatedAt ?? 0) - (a.review.updatedAt ?? 0));
  const {humanDetails,automaticDetails,humanCount,automaticCount}=summarizeAttention(pending,questions.length);
  const count=humanCount+automaticCount;
  if (!state.data && state.loading) return <p className="wb-muted" role="status">{tr("正在读取实时待办…")}</p>;
  if (!count && !history.length && !answeredQuestions.length && !state.error) return <p className="wb-muted">{tr("当前没有等待你回答或批准的请求。执行进度请看概览。")}</p>;
  return <section className="wb-attention" aria-label={tr("需要你处理")}><div className="wb-section-heading"><h2>{humanCount ? tr("需要你处理 · {0}", { 0: humanCount }) : count ? tr("自动审核中 · {0}", { 0: count }) : tr("最近处理记录")}</h2><span className="wb-muted">{tr("操作权限 · Agent 提问 · 项目决定")}</span></div>
    {!count ? <p className="wb-muted">{tr("当前无需你批准或回答。下面保留最近处理结果。")}</p> : null}
    {state.error ? <p className="wb-error" role="alert">{tr("待办读取失败：")}{state.error.message}{tr("。当前列表可能不完整。")}</p> : null}
    {humanDetails.map(detail => detail.session ? <div key={detail.session.id} className="wb-attention-session"><div className="wb-section-heading"><strong>{detail.session.title}</strong><button type="button" className="wb-text-button" onClick={() => onOpenSession(detail.session!.id)}>{tr("打开来源对话 ↗")}</button></div><p className="wb-muted">{detail.session.provider}</p>
      {detail.error ? <p className="wb-error">{tr("此会话正在等你处理，但具体请求读取失败：")}{detail.error}</p> : null}
      {detail.approvals?.map(approval => <ApprovalCard key={approval.id} projectId={projectId} sessionId={detail.session!.id} approval={approval} review={detail.approvalReviews?.find(review => review.approvalId === approval.id)} onHandled={onRefresh} />)}
      {!detail.error && !detail.approvals?.length ? <p className="wb-muted">{tr("会话状态已变化，正在刷新原请求。")}</p> : null}
    </div> : null)}
    {automaticCount ? <details className="wb-automatic-requests"><summary>{tr('自动审核进行中 · {0}',{0:automaticCount})}</summary><p className="wb-muted">{tr('这些操作由审核链处理，当前无需你批准。')}</p>{automaticDetails.map(detail=><article key={detail.session?.id}><strong>{detail.session?.title}</strong>{detail.approvals.map(approval=><p key={approval.id}>{approval.title}</p>)}</article>)}</details> : null}
    {questions.map(item => <RecordedQuestion key={item.id} projectId={projectId} item={item} sessions={sessions} onOpenSession={onOpenSession} runId={runId} onHandled={onRefresh} />)}
    {answeredQuestions.length ? <details className="wb-decisions-history" open><summary>{tr("已回答 ·")} {answeredQuestions.length}</summary>{[...answeredQuestions].reverse().map(item=><article key={`${item.runId}:${item.questionId}`}><strong>{item.title}</strong><p>{item.answer}</p><small className="wb-muted">{new Date(item.at).toLocaleString(locale)} · {item.state==='acknowledged'?tr("执行者已确认"):tr("答复已送达，等待执行者落实")}{tr("；无需重复回答")}</small><button className="wb-text-button" type="button" onClick={()=>onOpenSession(item.sessionId)}>{tr("查看执行对话 ↗")}</button></article>)}</details> : null}
    {history.length ? <details className="wb-attention-history"><summary>{tr("最近处理记录 ·")} {history.length}</summary>{history.slice(0, 6).map(({session, review}) => <article key={`${session.id}:${review.approvalId}`}><strong>{['human_required', 'reviewing_dsh', 'reviewing_codex', 'allowing', 'unknown'].includes(review.state) ? tr("暂未发现可操作的原请求") : tr(reviewLabels[review.state] || review.state)} · {review.request?.title === 'Unsupported question' ? tr("旧版缺少题干的请求") : review.request?.title === 'DeepSeek Harness question' ? tr("DSH 提问") : review.request?.title || tr("操作请求")}</strong><p>{review.reason}</p>{review.request?.description ? <pre className="wb-request-detail">{review.request.description}</pre> : <p className="wb-muted">{tr("这条旧记录未保存具体内容，请查看来源对话。")}</p>}<button type="button" className="wb-text-button" onClick={() => onOpenSession(session.id)}>{tr("查看来源对话 ↗")}</button></article>)}</details> : null}
  </section>;
}
