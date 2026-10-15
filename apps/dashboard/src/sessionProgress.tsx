import { useI18n } from './i18n';
import type { WorkbenchMessage, WorkbenchSession } from './workbenchTypes';

type Activity = { status?: string; at?: string };
export function sessionProgress(session: Pick<WorkbenchSession, 'status' | 'lastMessageAt'>, messages: WorkbenchMessage[] = [], activity: Activity[] = []) {
  const activeTool = ['running', 'starting'].includes(session.status) && activity.some(item => ['running', 'pending', 'in_progress'].includes(item.status || ''));
  const last = messages.at(-1);
  const generating = ['running', 'starting'].includes(session.status) && !activeTool && last?.role === 'assistant' && last.final === false;
  const latestAt = Math.max(0, Date.parse(session.lastMessageAt || '') || 0, ...messages.map(message => Date.parse(message.at || '') || 0), ...activity.map(item => Date.parse(item.at || '') || 0));
  return { generating, latestAt };
}

export function ReplyProgress({ session, messages, activity }: { session: WorkbenchSession; messages: WorkbenchMessage[]; activity?: Activity[] }): JSX.Element | null {
  const { t, locale } = useI18n();
  const progress = sessionProgress(session, messages, activity);
  if (!progress.generating) return null;
  return <p className="wb-muted" role="status"><strong>{t('正在生成回复')}</strong>{progress.latestAt ? <> · <time dateTime={new Date(progress.latestAt).toISOString()}>{new Date(progress.latestAt).toLocaleTimeString(locale)}</time></> : null}</p>;
}
