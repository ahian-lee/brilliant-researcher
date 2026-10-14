import { useI18n, translate as tr } from '../i18n';
import { useMemo, useState } from 'react';
import { fetchResults } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { ResultRow, Stage, Verdict } from '../types';
import { dateTime } from '../format';
import { Badge, STAGES, submittedMeta, verdictMeta, stageLabel } from '../status';
import { Card, Empty, FetchFailure, Field } from '../components/bits';

const SNIPPET = 200;

function phaseStatusLabel(status: string | undefined): string {
  if (status === 'skipped') return tr("按配置跳过（paper-writing 默认不自动执行）");
  if (status === 'done') return tr("执行已完成；是否需独立验收由所属工作流决定");
  if (status === 'accepted') return tr("原生阶段已验收");
  if (status === 'provisional') return tr("临时通过，仍未独立验收");
  return status ? tr("原生阶段 {0}", { 0: status }) : '';
}

function ResultItem({ r, onOpenRun }: { r: ResultRow; onOpenRun: (id: string) => void }): JSX.Element {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const report = r.final_report ?? '';
  const long = report.length > SNIPPET;
  const shown = open || !long ? report : `${report.slice(0, SNIPPET)}…`;
  return (
    <li className="result-item">
      <div className="result-head">
        <span className="result-title">{r.title || r.id}</span>
        <span className="result-stage">{stageLabel(r.stage)}</span>
        <span className="result-updated">{tr("更新")} {dateTime(r.updated_at)}</span>
      </div>
      <div className="badges">
        <Badge meta={submittedMeta(r.run_status)} />
        <Badge meta={verdictMeta(r.verdict, r.source)} />
        <span className="chip">{tr("工具调用")} {r.tool_calls === null ? tr("未统计") : tr("{0} 次", { 0: r.tool_calls })}</span>
        <span className="chip">{tr("任务")} {r.id.slice(0, 8)}</span>
        {r.source ? <span className="chip">{tr("来源")} {r.source}</span> : null}
        {r.phase_status ? <span className="chip">ARIS · {phaseStatusLabel(r.phase_status)}</span> : null}
      </div>
      <p className="report">
        {shown || tr("尚无 final_report 事件，执行者未提交结论文本")}
        {long ? (
          <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
            {open ? tr("收起") : tr("展开全文")}
          </button>
        ) : null}
      </p>
      <div className="result-foot">
          <span className="hint">
           {tr("来源：")}{r.run_id ? tr("run {0} · 第 {1} 次尝试", { 0: r.run_id, 1: r.attempt }) : tr("无运行记录")}  {tr("· 验收条件")}{' '}
          {r.accept_hint || tr("未声明")}
        </span>
        {r.run_id ? (
          <button type="button" className="link-btn" onClick={() => onOpenRun(String(r.run_id))}>
             {tr("查看该回合时间线与日志")} </button>
        ) : null}
      </div>
      {r.source === 'aris' && r.artifacts && r.artifacts.length > 0 ? (
        <details className="artifact-list">
          <summary>{tr("查看 ARIS 原生产物（")}{r.artifacts.length}）</summary>
          {r.artifacts.map((artifact) => (
            <section key={artifact.path} className="artifact-item">
              <p className="hint"><code>{artifact.path}</code>{artifact.readable === false ? tr(" · 未读取（路径越界或文件不可用）") : ''}</p>
              {artifact.content !== null ? <pre className="report artifact-content">{artifact.content}</pre> : <p className="hint">{tr("产物内容不可用")}</p>}
            </section>
          ))}
        </details>
      ) : null}
    </li>
  );
}

export function ResultsPage({
  projectId,
  revision,
  onOpenRun,
}: {
  projectId: string;
  revision: number;
  onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const state = useAsync(() => fetchResults(projectId), [revision, projectId]);
  const [stage, setStage] = useState<'all' | Stage>('all');
  const [verdict, setVerdict] = useState<'all' | Verdict>('all');
  const [keyword, setKeyword] = useState('');

  const rows = state.data?.results ?? [];
  const native = state.data?.source === 'aris';
  const stageOptions = useMemo(() => {
    const present = new Set(rows.map((row) => row.stage));
    const matching = STAGES.filter((stage) => present.has(stage.key));
    return matching.length > 0 ? matching : STAGES;
  }, [rows]);
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (stage !== 'all' && r.stage !== stage) return false;
      if (verdict !== 'all' && r.verdict !== verdict) return false;
      if (!kw) return true;
      return `${r.title} ${r.id} ${r.final_report ?? ''} ${r.run_id ?? ''}`.toLowerCase().includes(kw);
    });
  }, [rows, stage, verdict, keyword]);

  const decisions = state.data?.decisions ?? [];

  return (
    <div className="page">
      <FetchFailure failure={state.error} stale={rows.length > 0} />
      <Card title={tr("结果")} aside={<span className="aside-note">{tr("匹配")} {filtered.length}  {tr("/ 共")} {rows.length}  {tr("条")}</span>}>
        <div className="filters">
          <label>
             {tr("阶段")} <select value={stage} onChange={(e) => setStage(e.target.value as 'all' | Stage)}>
              <option value="all">{tr("全部阶段")}</option>
              {stageOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {tr(s.label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {native ? tr("ARIS 验收") : tr("Codex 验收")}
            <select value={verdict} onChange={(e) => setVerdict(e.target.value as 'all' | Verdict)}>
              <option value="all">{tr("全部验收状态")}</option>
              <option value="pending">{tr("未验收")}</option>
              <option value="accepted">{tr("已验收")}</option>
              <option value="revise">{tr("要求修订")}</option>
              <option value="rejected">{tr("已退回")}</option>
            </select>
          </label>
          <label>
             {tr("关键词")} <input
              value={keyword}
              placeholder={tr("检索标题、报告与运行编号")}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
        </div>
        <p className="hint">
          {native ? tr("执行结束与验收通过分别显示。辅助步骤保留原生 done，所属工作流负责独立评审；不会把 done 自动改成 accepted。") : tr("「Pi 已提交」取自 run 状态，「Codex 已验收」取自 task.verdict；失败与退回的回合仍在列表中可检索。")}
        </p>
        {state.loading && rows.length === 0 ? (
          <Empty text={tr("正在取数")} />
        ) : filtered.length === 0 ? (
          <Empty text={rows.length === 0 ? tr("尚无结果") : tr("当前筛选条件下无匹配结果")} />
        ) : (
          <ul className="result-list">
            {filtered.map((r) => (
              <ResultItem key={r.id} r={r} onOpenRun={onOpenRun} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={tr("决策记录")} aside={<span className="aside-note">{tr("共")} {decisions.length}  {tr("条")}</span>}>
        {decisions.length === 0 ? (
          <Empty text={tr("尚无决策记录")} />
        ) : (
          <ul className="decision-list">
            {decisions.slice(0, 40).map((d) => (
              <li key={d.id}>
                <span className="decision-action">{d.action}</span>
                <span className="decision-reason">{d.reason || tr("未填原因")}</span>
                <span className="decision-meta">
                  {d.author} · {dateTime(d.created_at)}  {tr("· 计划 v")}{d.plan_version} ·{' '}
                  {d.task_id ? tr("任务 {0}", { 0: d.task_id.slice(0, 8) }) : tr("项目级")}
                  {d.evidence_ref ? tr(" · 证据 {0}", { 0: d.evidence_ref }) : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {decisions.length > 40 ? <p className="hint">{tr("仅显示最近 40 条。")}</p> : null}
        <div className="grid-2">
          <Field label={tr("阅读范围")} value={native ? tr("结果与评审来自 ARIS 原始记录，页面只负责展示") : tr("结果与决策为只读视图，验收动作在 Codex Desktop 完成")} />
          <Field label={tr("比较条件")} value={tr("数据集、配置、单位、种子等由报告文本承载，页面不并排推断提升")} />
        </div>
      </Card>
    </div>
  );
}
