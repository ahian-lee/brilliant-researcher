import { useI18n } from '../i18n';
import { useId, useRef, useState } from 'react';
import { answerWorkbenchApproval, answerWorkbenchQuestion } from '../workbenchApi';
import type { WorkbenchApproval, WorkbenchReview } from '../workbenchTypes';

export const reviewLabels: Record<string, string> = { reviewing_dsh: 'DSH 正在审核操作权限', reviewing_codex: 'Codex 正在复核操作权限', human_required: '需要你审核', allowing: '正在放行本次操作', approved: '已放行本次操作', unknown: '处理结果待核实', resolved: '原请求已结束', answered: '已答复' };
const choiceLabels: Record<string, string> = { 'allow-once': '仅本次允许', accept: '仅本次允许', reject: '拒绝本次', deny: '拒绝本次' };
const choiceLabel = (id: string, label: string): string => choiceLabels[id] || label;

export function ApprovalCard({ projectId, sessionId, approval, review, disabled = false, onHandled }: {
  projectId: string; sessionId: string; approval: WorkbenchApproval; review?: WorkbenchReview; disabled?: boolean; onHandled: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const uid = useId();
  const [answers, setAnswers] = useState<Record<string, {selected: string[]; text?: string}>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const fields = approval.questions ?? [];
  const question = approval.kind === 'question';
  const ready = fields.length > 0 && fields.every(field => field.allowEmpty || answers[field.key]?.selected.length || answers[field.key]?.text?.trim());
  const run = async (operation: () => Promise<{ok: boolean; error?: string}>): Promise<void> => {
    if (disabled || done || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error || tr("执行端未确认接收，请刷新核实。"));
      setDone(true); onHandled();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); onHandled(); }
    finally { submitting.current = false; setBusy(false); }
  };
  const locked = disabled || busy || done;
  return <section className="wb-request-card" aria-label={question ? tr("Agent 提问") : tr("工具操作审批")}>
    <div className="wb-section-heading"><strong>{question ? tr("需要你回答") : review ? tr(reviewLabels[review.state] || review.state) : tr("工具操作待处理")}</strong><span className="wb-muted">{question ? tr("问答") : tr("操作权限")}</span></div>
    {!question || !fields.length ? <><h3>{approval.title}</h3><pre className="wb-request-detail">{approval.description || tr("执行端未提供具体内容，请先在来源对话中核实。")}</pre></> : null}
    {!question && review ? <div className="wb-review-reason"><p>{review.reason}</p>{review.reviewers.filter(item => item.verdict).map(item => <details key={item.level}><summary>{item.level === 'dsh' ? 'DSH' : 'Codex'}：{item.verdict?.decision === 'allow' ? tr("通过") : tr("未通过")}  {tr("· 查看依据")}</summary><p>{item.verdict?.reason}</p></details>)}{review.notification?.status === 'sent' ? <small>{tr("已发送飞书提醒；在此处理原请求。")}</small> : null}</div> : null}
    {question && fields.length ? <form onSubmit={event => {
      event.preventDefault();
      if (ready) void run(() => answerWorkbenchQuestion(projectId, sessionId, approval.id, Object.fromEntries(fields.map(field => [field.key, answers[field.key] ?? {selected: []}]))));
    }}>
      {fields.map((field, index) => <fieldset key={field.key} disabled={locked} className="wb-question-field"><legend>{field.question}</legend>
        {field.options.map(option => <label key={option.label} className="wb-question-option"><input type={field.multiSelect ? 'checkbox' : 'radio'} name={`${uid}-${index}`} checked={answers[field.key]?.selected.includes(option.label) ?? false} onChange={event => setAnswers(previous => {
          const current = previous[field.key] ?? {selected: []};
          return {...previous, [field.key]: {selected: field.multiSelect ? event.target.checked ? [...current.selected, option.label] : current.selected.filter(item => item !== option.label) : [option.label], text: field.multiSelect ? current.text : ''}};
        })} /><span>{option.label}{option.description ? <small>{option.description}</small> : null}</span></label>)}
        {field.allowOther || !field.options.length ? <label className="wb-question-custom">{field.options.length ? tr("其他回答") : tr("你的回答")}<textarea rows={2} value={answers[field.key]?.text ?? ''} onChange={event => setAnswers(previous => ({...previous, [field.key]: {selected: field.multiSelect ? previous[field.key]?.selected ?? [] : [], text: event.target.value}}))} /></label> : null}
      </fieldset>)}
      <div className="wb-request-buttons"><button type="submit" className="wb-button primary" disabled={locked || !ready}>{busy ? tr("正在提交…") : done ? tr("已提交回答") : tr("提交回答")}</button><button type="button" className="wb-button" disabled={locked} onClick={() => void run(() => answerWorkbenchQuestion(projectId, sessionId, approval.id, {}, true))}>{tr("取消本次问答")}</button></div>
    </form> : question ? <p className="wb-muted">{tr("题目格式暂不可用。请打开来源对话核实后回复，不要把它当作工具授权。")}</p> : <div className="wb-request-buttons">{approval.options.map(option => <button type="button" key={option.id} className="wb-button" disabled={locked} onClick={() => void run(() => answerWorkbenchApproval(projectId, sessionId, approval.id, option.id))}>{busy ? tr("正在提交…") : tr(choiceLabel(option.id, option.label))}</button>)}{!approval.options.length ? <p className="wb-muted">{tr("执行端没有返回可用操作，请打开来源对话核实。")}</p> : null}</div>}
    {error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}
    {done ? <p className="wb-notice" role="status">{tr("已提交到原请求，等待执行端更新。")}</p> : null}
  </section>;
}
