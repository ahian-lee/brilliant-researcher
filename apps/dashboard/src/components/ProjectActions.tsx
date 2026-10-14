import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { exportWorkbenchProject, setWorkbenchProjectCompleted } from '../workbenchApi';

export function ProjectActions({ projectId, completedAt, hasRunningSessions, onChanged }: {
  projectId: string; completedAt?: string | null; hasRunningSessions: boolean; onChanged: () => void;
}): JSX.Element {
  const { t: tr, locale } = useI18n();
  const [completed, setCompleted] = useState(completedAt ?? null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { setCompleted(completedAt ?? null); }, [completedAt]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (action: 'export' | 'complete'): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true; setBusy(action); setError(''); setNotice('');
    try {
      if (action === 'export') {
        const { blob, filename } = await exportWorkbenchProject(projectId);
        if (!active.current) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = filename;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setNotice('成果包已生成，已开始下载。');
      } else {
        const result = await setWorkbenchProjectCompleted(projectId, !completed);
        if (!active.current) return;
        setCompleted(result.completedAt);
        setNotice(result.completedAt ? "已收进左侧「已完成」。成果和对话仍可查看，随时可以恢复。" : "已恢复到进行中的项目。");
        onChanged();
      }
    } catch (err) { if (active.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { submitting.current = false; if (active.current) setBusy(''); }
  };
  return <section className="wb-project-actions" aria-label={tr("项目成果与收纳")}>
    <div className="wb-project-actions-row">
      <span className={completed ? 'wb-status' : 'wb-muted'}>{completed ? tr("已完成 · {0}", { 0: new Date(completed).toLocaleDateString(locale) }) : tr("成果与收纳")}</span>
      <div className="wb-project-action-buttons">
        <button type="button" className="wb-button" disabled={!!busy} onClick={() => void run('export')} title={tr("打包报告、图表、数据和代码，下载为 ZIP")}>{busy === 'export' ? tr("正在打包…") : tr("导出成果")}</button>
        <button type="button" className="wb-button" disabled={!!busy} onClick={() => void run('complete')}>{busy === 'complete' ? tr("正在保存…") : completed ? tr("恢复进行中") : tr("标记已完成")}</button>
      </div>
    </div>
    {hasRunningSessions ? <p className="wb-muted">{tr("仍有会话正在运行；收纳项目后，它们会继续执行。")}</p> : null}
    {error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}
    {notice ? <p className="wb-notice" role="status">{tr(notice)}</p> : null}
  </section>;
}
