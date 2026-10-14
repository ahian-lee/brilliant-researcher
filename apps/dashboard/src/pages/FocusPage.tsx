import { useI18n, translate as tr } from '../i18n';
import { useState } from 'react';
import { ago, dateTime } from '../format';
import { stageLabel } from '../status';
import type { Async } from '../hooks/useAsync';
import type { FocusConcern, FocusSession, Overview, Project } from '../types';

const STAGE_STATUS: Record<string, { label: string; tone: string }> = {
  accepted: { label: '已验收', tone: 'accepted' },
  done: { label: '已完成 · 待验收', tone: 'done' },
  provisional: { label: '暂定', tone: 'provisional' },
  skipped: { label: '已跳过', tone: 'muted' },
  running: { label: '记录为进行中', tone: 'running' },
  pending: { label: '待开始', tone: 'muted' },
  blocked: { label: '受阻', tone: 'blocked' },
  failed: { label: '失败', tone: 'failed' },
  unknown: { label: '状态未知', tone: 'muted' },
};

const SESSION_STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: '进行中', tone: 'running' },
  starting: { label: '启动中', tone: 'running' },
  queued: { label: '排队中', tone: 'muted' },
  waiting_input: { label: '有请求待处理', tone: 'waiting' },
  waiting: { label: '有请求待处理', tone: 'waiting' },
  blocked: { label: '受阻', tone: 'blocked' },
  historical: { label: '历史会话', tone: 'muted' },
  completed: { label: '已完成', tone: 'accepted' },
  succeeded: { label: '已完成', tone: 'accepted' },
  failed: { label: '失败', tone: 'failed' },
  stale: { label: '状态较旧', tone: 'muted' },
  idle: { label: '空闲', tone: 'muted' },
  unknown: { label: '状态未知', tone: 'muted' },
};

const REVIEW_STATUS: Record<string, { label: string; tone: string }> = {
  accepted: { label: '已通过', tone: 'accepted' },
  completed: { label: '审核完成 · 结论未明', tone: 'muted' },
  done: { label: '待审核', tone: 'waiting' },
  provisional: { label: '暂定', tone: 'waiting' },
  revise: { label: '需要修改', tone: 'waiting' },
  rejected: { label: '未通过', tone: 'failed' },
  failed: { label: '审核失败', tone: 'failed' },
  unavailable: { label: '未提供', tone: 'muted' },
  pending: { label: '等待审核', tone: 'waiting' },
  running: { label: '审核中', tone: 'running' },
  unknown: { label: '暂无审核状态', tone: 'muted' },
};

function statusFor(
  table: Record<string, { label: string; tone: string }>,
  value: string | null | undefined,
): { label: string; tone: string } {
  return table[(value || 'unknown').toLowerCase()] ?? { label: value || tr("状态未知"), tone: 'muted' };
}

function concernStatus(status: string | undefined): string {
  if (!status) return '';
  const normalized: Record<string, string> = {
    open: tr("待处理"),
    pending: tr("待处理"),
    blocked: tr("受阻"),
    waiting: tr("等待处理"),
    waiting_input: tr("等待你输入"),
    resolved: tr("已解决"),
    closed: tr("已解决"),
    done: tr("已完成"),
  };
  return normalized[status.toLowerCase()] ?? status;
}

function projectName(project: Project | null | undefined): string {
  return project?.name?.trim() || project?.id || tr("当前研究项目");
}

function sortedUpdates(data: Overview | null): Overview['supervisorUpdates'] {
  return [...(data?.supervisorUpdates ?? [])].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
  );
}

function fallbackConcerns(data: Overview | null): FocusConcern[] {
  return (data?.tasks ?? [])
    .filter((task) => !['accepted', 'rejected'].includes(task.verdict) && ['blocked', 'failed', 'waiting_input'].includes(task.status.toLowerCase()))
    .slice(0, 5)
    .map((task) => ({
      id: task.id,
      title: task.title || task.id,
      detail: task.brief || tr("任务状态：{0}", { 0: task.status }),
      source: tr("任务记录"),
    }));
}

function fallbackQuestions(data: Overview | null): FocusConcern[] {
  // Legacy needs_decision is a supervisor review flag, not a user decision.
  const latest = sortedUpdates(data)[0];
  return latest?.direction_status === 'needs_decision'
    ? [{ id: latest.id, title: tr("研究方向需要你决定"), detail: latest.direction_reason || latest.summary, source: tr("最新项目汇报") }]
    : [];
}

function focusSummary(data: Overview | null): { headline: string; summary: string; nextStep: string } {
  const updates = sortedUpdates(data);
  const latest = updates[0];
  if (latest) {
    return {
      headline: latest.current_stage ? tr("当前处于{0}阶段", { 0: stageLabel(latest.current_stage) }) : tr("研究进展已更新"),
      summary: latest.summary || tr("暂无进展摘要。"),
      nextStep: latest.next_step || tr("尚未登记下一步。"),
    };
  }

  const active = (data?.tasks ?? []).filter((task) => ['running', 'starting', 'queued'].includes(task.status.toLowerCase()));
  if (active.length > 0) {
    return {
      headline: tr("{0} 项任务正在执行", { 0: active.length }),
      summary: tr("这个旧项目暂未提供统一的研究进展摘要。以下显示已登记的任务状态。"),
      nextStep: tr("查看执行任务的会话活动，并补充本轮预期产出。"),
    };
  }

  return {
    headline: tr("等待研究进展记录"),
    summary: tr("当前项目没有可用的总体进展摘要，不能据此判断研究已经完成。"),
    nextStep: tr("准备下一次执行时，先明确研究目标和可验收的阶段产出。"),
  };
}

function sessionUpdatedLabel(session: FocusSession, now: number): string {
  return session.updated_at
    ? tr("最后更新 {0} · {1}", { 0: ago(session.updated_at, now), 1: dateTime(session.updated_at) })
    : tr("尚无更新时间");
}

function buildHandoff(
  agent: string,
  project: Project | null | undefined,
  data: Overview | null,
  focusHeadline: string,
  nextStep: string,
): string {
  const stages = data?.focus?.stages ?? [];
  const blockers = data?.focus?.blockers ?? fallbackConcerns(data);
  const questions = data?.focus?.questions ?? fallbackQuestions(data);
  const sessions = data?.focus?.sessions ?? [];
  const root = project?.root || '请从项目登记信息确认项目根目录';
  const stageList = stages.length
    ? stages.map((stage) => `- ${stage.label}: ${statusFor(STAGE_STATUS, stage.status).label}`).join('\n')
    : '- 当前项目尚未接入阶段状态，请先读取已有任务和项目记录，不要推断阶段已通过。';
  const sessionList = sessions.length
    ? sessions
        .map((session) => `- ${session.agent} / ${session.title}: ${statusFor(SESSION_STATUS, session.status).label}；${session.activity || '暂无活动摘要'}（${sessionUpdatedLabel(session, Date.now())}）`)
        .join('\n')
    : '- 当前没有可见的执行会话记录；如新建会话，请记录会话标识、执行者、标题、状态、活动摘要、更新时间、阶段和父会话。';

  return [
    `请以 ${agent} 作为本轮执行者，继续推进下列研究项目。`,
    `项目：${projectName(project)}（${project?.id || '未登记 ID'}）`,
    `项目根目录：${root}`,
    '开始前请定位 BRI 源码工作区，阅读其中 upstream/aris/skills/research-pipeline/SKILL.md、docs/aris-agent-workflow.md 和 docs/agent-sessions.md。研究目录与 BRI 源码目录可能不同。按 ARIS research-pipeline 组织阶段、证据与交付；根据项目现有记录继续，不要覆盖已有结果。',
    '总体摘要请更新项目根目录下的 .aris/progress.json，字段包括 summary、next_step、executor、reviewer、blockers、questions、updated_at 和 run_id；blockers/questions 中每项记录 id、title、detail、status。',
    '各阶段状态继续写入 ARIS 原生 .aris/runs 记录，不要将阶段状态复制到 .aris/progress.json。done 表示执行完成，只有 accepted 才表示审核验收通过。',
    `当前总体位置：${focusHeadline}`,
    `下一步目标：${nextStep}`,
    `研究目标：${project?.goal || '先读取项目目标并据此确定本轮任务。'}`,
    `资源与范围：${project?.constraints || '遵守研究目录 RESEARCH_BRIEF.md 中的已授权资源、预算与停止条件。'}。已验收且未受变更影响的工作不要重复执行。`,
    `执行者：${agent}。请在阶段完成后写明产物路径、依据和状态。`,
    '独立审核：交付后由 Codex 单独审核证据与阶段验收。阶段 done 仅表示执行完成，不等于 accepted；只有审核接受后才能标记已验收。',
    '会话进度：DSH 本地记录按研究目录精确匹配，能展示最近活动但不代表实时在线。如需实时状态或使用其他 agent，请按 docs/agent-sessions.md 配置 project-export，在研究目录的 .bri/agent-sessions.json 写入 root、project_id、generated_at 和 sessions 数组；每项包含 id、agent、title、status、activity、updated_at，可附 stage/parent_id。仅在有真实会话观测时更新快照，卡住时记录 waiting_input。',
    `现有阶段：\n${stageList}`,
    `现有执行会话：\n${sessionList}`,
    `当前卡点：\n${blockers.length ? blockers.map((item) => `- ${item.title} [${item.status || '待处理'}]: ${item.detail}`).join('\n') : '- 看板当前没有登记卡点。请遇到问题后记录；不要将空列表解释为研究无阻碍。'}`,
    `需要用户把握的问题：\n${questions.length ? questions.map((item) => `- ${item.title} [${item.status || '待处理'}]: ${item.detail}`).join('\n') : '- 看板当前没有登记待决问题。若决策会影响范围、成本或方向，请暂停并明确询问用户。'}`,
  ].join('\n\n');
}

function PrepNextRun({
  project,
  data,
  headline,
  nextStep,
}: {
  project: Project | null | undefined;
  data: Overview | null;
  headline: string;
  nextStep: string;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [agent, setAgent] = useState('DSH');
  const [customAgent, setCustomAgent] = useState('');
  const [copied, setCopied] = useState(false);
  const selectedAgent = agent === '自定义' ? customAgent.trim() || tr("自定义 coding agent") : agent;

  const copyHandoff = async (): Promise<void> => {
    const text = buildHandoff(selectedAgent, project, data, headline, nextStep);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const copiedToClipboard = document.execCommand('copy');
      document.body.removeChild(input);
      if (!copiedToClipboard) {
        setCopied(false);
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  };

  return (
    <details className="focus-prep">
      <summary>
        <span>
          <strong>{tr("准备下一次执行")}</strong>
          <small>{tr("选择执行者并复制交接说明，不会更换正在运行的会话")}</small>
        </span>
        <span className="focus-prep-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="focus-prep-body">
        <div className="focus-agent-row">
          <label htmlFor="focus-agent">{tr("本轮执行者")}</label>
          <select id="focus-agent" value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option>DSH</option>
            <option>Codex</option>
            <option>Claude Code</option>
            <option>Pi</option>
            <option value="自定义">{tr("自定义")}</option>
          </select>
          {agent === '自定义' ? (
            <input
              aria-label={tr("自定义 coding agent 名称")}
              value={customAgent}
              onChange={(event) => setCustomAgent(event.target.value)}
              placeholder={tr("输入 agent 名称")}
            />
          ) : null}
          <button type="button" className="focus-copy-button" onClick={() => void copyHandoff()}>
            {copied ? tr("已复制") : tr("复制交接说明")}
          </button>
        </div>
        <p className="focus-prep-note">
           {tr("交接内容会包含项目路径、流程文档、.aris/progress.json 摘要要求、Codex 独立审核，以及阶段和会话记录要求。")} </p>
        <span className="focus-copy-status" role="status" aria-live="polite">
          {copied ? tr("交接说明已复制，可以粘贴给所选执行者。") : ''}
        </span>
      </div>
    </details>
  );
}

export function FocusPage({
  project,
  overview,
  now,
  onSelectRun,
  hidePreparation = false,
  hideQuestions = false,
  onOpenSession,
}: {
  project: Project | null;
  overview: Async<Overview | null>;
  now: number;
  onSelectRun: (runId: string) => void;
  hidePreparation?: boolean;
  hideQuestions?: boolean;
  onOpenSession?: (id: string) => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const data = overview.data;
  const focus = data?.focus;
  const fallback = focusSummary(data);
  const headline = focus?.headline || fallback.headline;
  const summary = focus?.summary || fallback.summary;
  const nextStep = focus?.next_step || fallback.nextStep;
  const updatedAt = focus?.updated_at || sortedUpdates(data)[0]?.created_at || null;
  const stages = focus?.stages ?? [];
  const sessions = (focus?.sessions ?? []).filter(session => !session.title?.startsWith('BRI approval review '));
  const blockers = focus?.blockers ?? fallbackConcerns(data);
  const questions = focus?.questions ?? fallbackQuestions(data);
  const completed = focus ? Math.max(0, focus.completed) : 0;
  const total = focus ? Math.max(0, focus.total) : 0;
  const progress = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  const latestTasks = (data?.tasks ?? []).slice(0, 8);
  const decisions = (data?.decisions ?? []).slice(0, 3);

  return (
    <div className="focus-page">
      <div className="focus-page-heading">
        <div>
          <span className="focus-eyebrow">{tr("项目工作台")}</span>
          <h1>{projectName(project)}</h1>
          <p className="focus-project-goal">{project?.goal || tr("项目目标尚未填写。")}</p>
        </div>
        <div className="focus-updated">
          <span>{tr("进展更新时间")}</span>
          <strong>{updatedAt ? dateTime(updatedAt) : tr("暂无记录")}</strong>
          {updatedAt ? <small>{ago(updatedAt, now)}{tr("更新")}</small> : null}
        </div>
      </div>

      {overview.loading && !data ? (
        <section className="focus-loading" aria-live="polite">
          <span className="focus-loading-dot" />
          <div><strong>{tr("正在读取研究进展")}</strong><p>{tr("稍后会显示流程位置、执行会话与待处理问题。")}</p></div>
        </section>
      ) : null}

      {!overview.loading && !data && overview.error ? (
        <section className="focus-empty focus-empty-error">
          <strong>{tr("暂时无法读取项目进展")}</strong>
          <p>{tr("检查连接后，页面会继续尝试同步。当前没有足够数据判断项目状态。")}</p>
        </section>
      ) : null}

      {data ? (
        <>
          <section className="focus-hero" aria-labelledby="focus-overall-title">
            <div className="focus-hero-top">
              <span className="focus-hero-label" id="focus-overall-title">{tr("整体进展")}</span>
              {focus?.pipeline_run_id ? <span className="focus-pipeline-id">{tr("ARIS 流程")}</span> : null}
            </div>
            <h2>{headline}</h2>
            <p>{summary}</p>
            {focus && total > 0 ? (
              <div className="focus-progress" aria-label={tr("已完成 {0} / {1} 个阶段", { 0: completed, 1: total })}>
                <div className="focus-progress-meta"><span>{tr("阶段进度")}</span><strong>{completed} / {total}</strong></div>
                <div className="focus-progress-track"><span style={{ width: `${progress}%` }} /></div>
              </div>
            ) : null}
            <div className="focus-next-step">
              <span className="focus-next-mark" aria-hidden="true">↗</span>
              <div><small>{tr("下一步")}</small><strong>{nextStep}</strong></div>
            </div>
          </section>

          <div className="focus-layout">
            <div className="focus-main-column">
              <section className="focus-panel" aria-labelledby="focus-stages-title">
                <div className="focus-panel-heading">
                  <div><span className="focus-section-kicker">{tr("流程")}</span><h2 id="focus-stages-title">{tr("研究阶段")}</h2></div>
                  {focus?.executor || focus?.reviewer ? (
                    <span className="focus-roles">{tr("执行")} {focus.executor || tr("待定")} <i />  {tr("审核")} {focus.reviewer || 'Codex'}</span>
                  ) : null}
                </div>
                {stages.length > 0 ? (
                  <ol className="focus-stage-list">
                    {stages.map((stage, index) => {
                      const status = statusFor(STAGE_STATUS, stage.status);
                      return (
                        <li key={`${stage.id}-${index}`} className={`focus-stage tone-${status.tone}`}>
                          <span className="focus-stage-index">{index + 1}</span>
                          <div className="focus-stage-copy">
                            <strong>{tr(stage.label)}</strong>
                            {stage.run_id ? (
                              <button type="button" className="focus-inline-link" onClick={() => onSelectRun(stage.run_id as string)}>
                                 {tr("查看执行记录")} </button>
                            ) : null}
                          </div>
                          <span className={`focus-status tone-${status.tone}`}>{tr(status.label)}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div className="focus-inline-empty">
                    <strong>{tr("还没有阶段状态")}</strong>
                    <span>{focus ? tr("流程已接入，但阶段清单暂为空。") : tr("此项目尚未接入 ARIS 流程状态，下面显示已有任务和进展记录。")}</span>
                  </div>
                )}
                {focus?.source_note ? <p className="focus-source-note">{focus.source_note}</p> : null}
              </section>

              <section className="focus-panel" aria-labelledby="focus-sessions-title">
                <div className="focus-panel-heading">
                  <div><span className="focus-section-kicker">{tr("执行现场")}</span><h2 id="focus-sessions-title">{tr("Agent 会话")}</h2></div>
                  {sessions.length > 0 ? <span className="focus-count">{sessions.length}  {tr("个会话")}</span> : null}
                </div>
                {focus?.session_note ? <p className="focus-session-note">{focus.session_note.includes('Paseo') ? tr("会话状态由执行后台提供") : focus.session_note}</p> : null}
                {sessions.length > 0 ? (
                  <ul className="focus-session-list">
                    {sessions.map((session) => {
                      const status = statusFor(SESSION_STATUS, session.status);
                      return (
                        <li className="focus-session" key={session.id}>
                          <span className={`focus-session-indicator tone-${status.tone}`} aria-hidden="true" />
                          <div className="focus-session-body">
                            <div className="focus-session-heading">
                              <div><strong>{session.title || session.id}</strong><span>{session.agent || tr("未知执行者")}{session.stage ? ` · ${session.stage}` : ''}{session.parent_id ? tr(" · 子会话") : ''}</span></div>
                              <span className={`focus-status tone-${status.tone}`}>{tr(status.label)}</span>
                            </div>
                            <p>{session.activity || tr("暂无活动摘要")}</p>
                            <small>{sessionUpdatedLabel(session, now)}</small>
                            {onOpenSession ? <button type="button" className="wb-text-button" onClick={() => onOpenSession(session.id)}>{['waiting_input', 'waiting', 'blocked'].includes(session.status) ? tr("查看并处理请求 →") : tr("查看会话 →")}</button> : null}
                            {session.url && /^(https?:\/\/|codex:\/\/threads\/)/i.test(session.url) ? <a className="focus-session-link" href={session.url} target="_blank" rel="noreferrer">{tr("打开会话 ↗")}</a> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="focus-inline-empty">
                    <strong>{tr("当前没有可见会话")}</strong>
                    <span>{focus ? tr("会话接入后，这里会显示每个执行者的工作内容和最近更新时间。") : tr("旧项目暂未提供会话明细；任务记录可在“更多记录”中查看。")}</span>
                  </div>
                )}
              </section>

              {!focus ? (
                <details className="focus-legacy-records">
                  <summary>{tr("查看旧项目任务记录")} <span>{latestTasks.length}  {tr("项")}</span></summary>
                  {latestTasks.length > 0 ? (
                    <ul>{latestTasks.map((task) => (
                      <li key={task.id}>
                        <div><strong>{task.title || task.id}</strong><small>{task.stage}  {tr("· 更新于")} {dateTime(task.updated_at)}</small></div>
                        <span className={`focus-status tone-${statusFor(SESSION_STATUS, task.status).tone}`}>{tr(statusFor(SESSION_STATUS, task.status).label)}</span>
                      </li>
                    ))}</ul>
                  ) : <p>{tr("当前没有已登记任务。")}</p>}
                </details>
              ) : null}
            </div>

            <aside className="focus-side-column">
              <section className="focus-panel focus-concern-panel" aria-labelledby="focus-blockers-title">
                <div className="focus-panel-heading">
                  <div><span className="focus-section-kicker">{tr("需要跟进")}</span><h2 id="focus-blockers-title">{tr("卡住的地方")}</h2></div>
                  {blockers.length > 0 ? <span className="focus-count focus-count-alert">{blockers.length}</span> : null}
                </div>
                {blockers.length > 0 ? (
                  <ul className="focus-concern-list">{blockers.map((item) => (
                    <li key={item.id}><strong>{item.title}</strong><p>{item.detail}</p><small>{item.source}{item.status ? ` · ${concernStatus(item.status)}` : ''}</small>{item.session_id && onOpenSession ? <button type="button" className="wb-text-button" onClick={()=>onOpenSession(item.session_id!)}>{tr("查看并处理 →")}</button> : null}</li>
                  ))}</ul>
                ) : <div className="focus-concern-empty">{tr("看板当前没有登记卡点。")}</div>}
              </section>

              {!hideQuestions ? <section className="focus-panel focus-question-panel" aria-labelledby="focus-questions-title">
                <div className="focus-panel-heading">
                  <div><span className="focus-section-kicker">{tr("需要你把握")}</span><h2 id="focus-questions-title">{tr("待你决定")}</h2></div>
                  {questions.length > 0 ? <span className="focus-count focus-count-question">{questions.length}</span> : null}
                </div>
                {questions.length > 0 ? (
                  <ul className="focus-concern-list">{questions.map((item) => (
                    <li key={item.id}><strong>{item.title}</strong><p>{item.detail}</p><small>{item.source}{item.status ? ` · ${concernStatus(item.status)}` : ''}</small>{item.session_id && onOpenSession ? <button type="button" className="wb-text-button" onClick={()=>onOpenSession(item.session_id!)}>{tr("查看并处理 →")}</button> : null}</li>
                  ))}</ul>
                ) : <div className="focus-concern-empty">{tr("暂无已记录的待决问题。")}</div>}
              </section> : null}

              <section className="focus-review-card" aria-labelledby="focus-review-title">
                <div><span className="focus-section-kicker">{tr("审核")}</span><h2 id="focus-review-title">{tr("Codex 独立审核")}</h2></div>
                {focus ? (
                  <>
                    <span className={`focus-status tone-${statusFor(REVIEW_STATUS, focus.review?.status).tone}`}>
                      {tr(statusFor(REVIEW_STATUS, focus.review?.status).label)}
                    </span>
                    <p>{focus.review?.summary || tr("暂无审核结论。")}</p>
                    <small>{focus.review?.updated_at ? tr("更新于 {0}", { 0: dateTime(focus.review.updated_at) }) : tr("暂无审核更新时间")}</small>
                  </>
                ) : decisions.length > 0 ? (
                  <>
                    <span className="focus-status tone-muted">{tr("已有历史评审")}</span>
                    <p>{decisions[0].action}：{decisions[0].reason || tr("未填写结论说明")}</p>
                    <small>{tr("更新于")} {dateTime(decisions[0].created_at)}</small>
                  </>
                ) : (
                  <>
                    <span className="focus-status tone-muted">{tr("暂无审核状态")}</span>
                    <p>{tr("旧项目还没有可显示的独立审核结论。")}</p>
                    <small>{tr("执行完成后由 Codex 根据证据审核。")}</small>
                  </>
                )}
              </section>
            </aside>
          </div>

          {data.supervisorUpdates.length > 0 ? (
            <details className="focus-history">
              <summary>{tr("查看历史进展")} <span>{data.supervisorUpdates.length}  {tr("条记录")}</span></summary>
              <ul>{sortedUpdates(data).slice(0, 8).map((update) => (
                <li key={update.id}>
                  <time>{dateTime(update.created_at)}</time>
                  <div><strong>{update.current_stage || tr("进展更新")}</strong><p>{update.summary}</p>{update.next_step ? <small>{tr("下一步：")}{update.next_step}</small> : null}</div>
                </li>
              ))}</ul>
            </details>
          ) : null}

          {!hidePreparation ? <PrepNextRun project={project} data={data} headline={headline} nextStep={nextStep} /> : null}
        </>
      ) : null}
    </div>
  );
}
