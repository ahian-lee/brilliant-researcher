import { useI18n } from '../i18n';
import { sessionSignal } from '../sessionSignal';
import type { WorkbenchSession, WorkbenchSessionDetail } from '../workbenchTypes';

export function elapsedLabel(milliseconds: number): { key: string; value: number } {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? { key: '{0} 秒前', value: seconds } : seconds < 3600 ? { key: '{0} 分钟前', value: Math.floor(seconds / 60) } : seconds < 86400 ? { key: '{0} 小时前', value: Math.floor(seconds / 3600) } : { key: '{0} 天前', value: Math.floor(seconds / 86400) };
}

export function SessionPulse({ session, detail, now, observedAt, readError, refreshing, onRefresh, onRequests, onConversation, onConfigure }: {
  session: WorkbenchSession; detail?: WorkbenchSessionDetail; now: number; observedAt?: string | null;
  readError?: string; refreshing?: boolean; onRefresh: () => void; onRequests?: () => void; onConversation?: () => void; onConfigure?: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const signal = sessionSignal(session, readError ? { ...detail, messages: detail?.messages ?? [], error: readError } : detail, now);
  const observationError = readError || detail?.error;
  const observed = Date.parse(observedAt || '') || 0;
  const stale = observed > 0 && now - observed > 30_000;
  const age = signal.age === null ? null : elapsedLabel(signal.age);
  const current = signal.active ?? signal.recent;
  const canRespond = signal.kind === 'human';
  return <section className={`wb-pulse is-${signal.kind}${signal.quiet ? ' is-quiet' : ''}`} aria-label={t('会话实时反馈')} data-signal={signal.kind} data-quiet={signal.quiet}>
    <div className="wb-pulse-heading"><span className="wb-pulse-dot" aria-hidden="true"/><strong>{t(signal.label)}</strong><span className="wb-pulse-age">{age ? <time dateTime={new Date(signal.latestAt).toISOString()} title={new Date(signal.latestAt).toLocaleString(locale)}>{t('最近反馈 · {0}', { 0: t(age.key, { 0: age.value }) })}</time> : t('暂无活动时间')}</span></div>
    <p className="wb-pulse-hint">{t(signal.hint)}</p>
    {current ? <div className="wb-pulse-operation"><small>{signal.active ? t('当前操作') : t('最后记录的操作')}</small><code>{current.target || current.summary}</code>{signal.active?.at ? <small>{t('开始于 {0}', { 0: new Date(signal.active.at).toLocaleTimeString(locale) })}</small> : null}</div> : null}
    {signal.note && !['error', 'unavailable'].includes(signal.kind) ? <p className="wb-pulse-note"><span>{t('最近文字反馈')}</span>{signal.note.length > 220 ? `${signal.note.slice(0, 220)}…` : signal.note}</p> : null}
    {signal.quiet ? <p className="wb-pulse-warning" role="status">{t('有一段时间没有新输出；这不代表进程停止。可先刷新状态，仍无进展时再暂停协作并说明如何继续。')}</p> : null}
    {signal.error ? <details className="wb-pulse-error" open><summary>{t('具体错误')}</summary><pre>{signal.error}</pre></details> : null}
    <div className="wb-pulse-footer"><span className={observationError || stale ? 'wb-observation-warning' : 'wb-observation-ok'}>{observationError ? t('连接读取失败') : stale ? t('状态更新延迟') : observed ? t('已收到后台状态') : t('正在读取后台状态')}{observed ? <> · <time dateTime={new Date(observed).toISOString()}>{new Date(observed).toLocaleTimeString(locale)}</time></> : null}</span><button className="wb-text-button" type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? t('正在刷新…') : t('刷新状态')}</button></div>
    {canRespond && onRequests ? <button type="button" className="wb-button primary" onClick={onRequests}>{t('查看问题并答复')}</button> : ['error', 'interrupted'].includes(signal.kind) && onConversation ? <button type="button" className="wb-button" onClick={onConversation}>{t('打开对话继续处理')}</button> : null}
    {onConfigure && ['模型服务额度不足','模型鉴权需要处理'].includes(signal.label) ? <button type="button" className="wb-text-button" onClick={onConfigure}>{t('检查模型设置')}</button> : null}
  </section>;
}
