import { useI18n, LanguageSwitcher } from './i18n';
import { fetchAttentionCounts } from './workbenchApi';
import { useMemo, useState } from 'react';
import { fetchOverview, fetchProjects } from './api';
import { useAsync } from './hooks/useAsync';
import { useLive } from './hooks/useLive';
import { useNow } from './hooks/useNow';
import { clock } from './format';
import { FocusPage } from './pages/FocusPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { NewResearchDialog } from './components/NewResearchDialog';
import { ResultsPage } from './pages/ResultsPage';
import { ResourcesPage } from './pages/ResourcesPage';
import { RunsPage } from './pages/RunsPage';
import { RunDetail } from './components/RunDetail';
import type { Overview, Project } from './types';
import './styles/focus.css';

type PageKey = 'focus' | 'results' | 'runs' | 'resources';

const NAV: Array<{ key: PageKey; label: string; hint: string }> = [
  { key: 'focus', label: '项目进展', hint: '流程、会话与待办' },
  { key: 'results', label: '结果与评审', hint: '验收与证据' },
  { key: 'runs', label: '执行记录', hint: '会话与原始日志' },
  { key: 'resources', label: '资源', hint: '主机观测' },
];

function projectLabel(project: Project): string {
  return project.name?.trim() || project.id;
}

function isHistoryProject(project: Project): boolean {
  const label = `${project.name || ''} ${project.id}`;
  return project.source === 'bri' || /debug|调试/i.test(label);
}

function groupProjects(projects: Project[]) {
  return {
    current: projects.filter(project => !project.completed_at && !isHistoryProject(project)),
    history: projects.filter(project => !project.completed_at && isHistoryProject(project)),
    completed: projects.filter(project => project.completed_at).sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')),
  };
}

function mostRecent(projects: Project[]): Project | undefined {
  return [...projects].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at || '') || 0;
    const rightTime = Date.parse(right.updated_at || '') || 0;
    return rightTime - leftTime;
  })[0];
}

function ProjectRow({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  return (
    <button
      type="button"
      className={selected ? 'project-row is-selected' : 'project-row'}
      onClick={onSelect}
      aria-current={selected ? 'page' : undefined}
      title={project.id}
    >
      <span className="project-row-name">{projectLabel(project)}</span>
      <span className="project-row-meta">
        {project.source ? <span className="project-row-source">{project.source === 'aris' ? 'ARIS' : 'BRI'}</span> : null}
        <span>{project.task_count ?? 0}  {tr("个任务")}</span>
        {project.completed_at ? <span>{tr("已完成")}</span> : null}
        {project.active_count ? <span className="project-row-active">{project.active_count}  {tr("进行中")}</span> : null}
        {project.human_attention_count ? <span className="project-row-review">{project.human_attention_count}  {tr("项待你处理")}</span> : null}
        {project.attention_error ? <span title={project.attention_error}>{tr("待办状态未完整读取")}</span> : null}
        {project.pending_review_count ? <span className="project-row-review">{project.pending_review_count}  {tr("阶段待 Agent 评审")}</span> : null}
      </span>
    </button>
  );
}

function Sidebar({
  projects,
  selectedId,
  page,
  liveNote,
  liveMode,
  onSelectProject,
  onSelectPage,
}: {
  projects: Project[];
  selectedId: string | null;
  page: PageKey;
  liveNote: string;
  liveMode: string;
  onSelectProject: (projectId: string) => void;
  onSelectPage: (page: PageKey) => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const groups = groupProjects(projects);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-main">BRI</span>
        <span className="brand-sub">Researcher</span>
      </div>

      <div className="side-section">
        <div className="side-section-head">
          <span>{tr("当前项目")}</span>
          <span className="side-section-count">{groups.current.length}</span>
        </div>
        <div className="project-list">
          {groups.current.length === 0 ? <span className="side-empty">{tr("暂无进行中的项目")}</span> : null}
          {groups.current.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              selected={project.id === selectedId}
              onSelect={() => onSelectProject(project.id)}
            />
          ))}
          {groups.history.length ? (
            <details className="project-history">
              <summary>{tr("历史与调试项目")} <span>{groups.history.length}</span></summary>
              {groups.history.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  selected={project.id === selectedId}
                  onSelect={() => onSelectProject(project.id)}
                />
              ))}
            </details>
          ) : null}
          {groups.completed.length ? <details className="project-history project-completed">
            <summary>{tr("已完成")} <span>{groups.completed.length}</span></summary>
            {groups.completed.map(project => <ProjectRow key={project.id} project={project} selected={project.id === selectedId} onSelect={() => onSelectProject(project.id)} />)}
          </details> : null}
        </div>
      </div>

      <nav className="nav" aria-label={tr("项目视图")}>
        <button
          type="button"
          className={page === 'focus' ? 'nav-item is-current' : 'nav-item'}
          onClick={() => onSelectPage('focus')}
          disabled={!selectedId}
          aria-current={page === 'focus' ? 'page' : undefined}
        >
          <span className="nav-label">{tr("项目进展")}</span>
          <span className="nav-hint">{tr("整体流程与待办")}</span>
        </button>
        <details className="nav-more">
          <summary>{tr("更多记录")}</summary>
          <div className="nav-more-items">
            {NAV.filter((item) => item.key !== 'focus').map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === page ? 'nav-item is-current' : 'nav-item'}
            onClick={() => onSelectPage(item.key)}
            disabled={!selectedId}
            aria-current={item.key === page ? 'page' : undefined}
          >
            <span className="nav-label">{tr(item.label)}</span>
            <span className="nav-hint">{tr(item.hint)}</span>
          </button>
            ))}
          </div>
        </details>
      </nav>

      <div className="side-foot">
        <span className={liveMode === 'sse' ? 'live-flag ok' : 'live-flag warn'}>{tr(liveNote)}</span>
        <span>{tr("自动刷新 · 按项目读取执行与审核记录")}</span>
      </div>
    </aside>
  );
}

function PageFailure({ title, message }: { title: string; message: string }): JSX.Element {
  return (
    <div className="fail page-fail">
      <span className="fail-title">{title}</span>
      <span className="fail-msg">{message}</span>
    </div>
  );
}

export default function App(): JSX.Element {
  const { t: tr } = useI18n();
  const [page, setPage] = useState<PageKey>('focus');
  const [newResearchOpen, setNewResearchOpen] = useState(false);
  const [startupNotice, setStartupNotice] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('project') || window.localStorage.getItem('bri-researcher:last-project');
    } catch {
      return null;
    }
  });
  const [revision, setRevision] = useState(0);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const now = useNow(1_000);
  const live = useLive(() => setRevision((r) => r + 1));
  const projectState = useAsync(() => fetchProjects(), [revision], {pollMs:5000});
  const attentionCounts = useAsync(fetchAttentionCounts, [revision], {pollMs:5000});
  const projects = (projectState.data?.projects ?? []).map(p=>({...p,human_attention_count:attentionCounts.data?.projects[p.id]?.human??p.human_question_count,attention_error:attentionCounts.data?.projects[p.id]?.error}));
  const groups = groupProjects(projects);

  const scopeId = useMemo(() => {
    if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) return selectedProjectId;
    const openProjects = projects.filter(project => !project.completed_at);
    const activeAris = mostRecent(openProjects.filter((project) => project.source === 'aris' && (project.active_count ?? 0) > 0));
    if (activeAris) return activeAris.id;
    const aris = mostRecent(openProjects.filter((project) => project.source === 'aris' && !isHistoryProject(project)));
    if (aris) return aris.id;
    const defaultId = projectState.data?.defaultProjectId;
    if (defaultId && openProjects.some((project) => project.id === defaultId)) return defaultId;
    return mostRecent(openProjects)?.id ?? mostRecent(projects)?.id ?? null;
  }, [projects, projectState.data?.defaultProjectId, selectedProjectId]);

  const overview = useAsync<Overview | null>(
    () => (scopeId ? fetchOverview(scopeId) : Promise.resolve(null)),
    [scopeId, revision],
    { resetKey: scopeId, pollMs: 5000 },
  );
  const scopedOverview = overview.data?.project?.id === scopeId ? overview.data : null;
  const scopedProject = scopedOverview?.project ?? projects.find((project) => project.id === scopeId) ?? null;
  const current = NAV.find((item) => item.key === page) ?? NAV[0];
  const scopeKey = scopeId ?? 'no-project';

  const selectProject = (projectId: string): void => {
    setSelectedProjectId(projectId);
    try {
      window.localStorage.setItem('bri-researcher:last-project', projectId);
      const url=new URL(window.location.href);url.searchParams.set('project',projectId);window.history.replaceState(null,'',url);
    } catch {
      // The selected project still works when local storage is unavailable.
    }
    setOpenRun(null);
    setPage('focus');
  };

  return (
    <div className="app focus-app">
      <Sidebar
        projects={projects}
        selectedId={scopeId}
        page={page}
        liveNote={live.note}
        liveMode={live.mode}
        onSelectProject={selectProject}
        onSelectPage={setPage}
      />

      <div className="main">
        <header className="topbar">
          <div className="topbar-project-picker">
            <label className="mobile-project-label" htmlFor="mobile-project-select">
               {tr("项目")} </label>
            <select
              id="mobile-project-select"
              className="mobile-project-select"
              value={scopeId ?? ''}
              onChange={(event) => selectProject(event.target.value)}
              disabled={projects.length === 0}
            >
              {projects.length === 0 ? <option value="">{tr("尚无可用项目")}</option> : null}
              {groups.current.length > 0 ? (
                <optgroup label={tr("当前项目")}>
                  {groups.current.map((project) => (
                    <option key={project.id} value={project.id}>
                      {projectLabel(project)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {groups.history.length > 0 ? (
                <optgroup label={tr("历史与调试项目")}>
                  {groups.history.map((project) => (
                <option key={project.id} value={project.id}>
                  {projectLabel(project)}
                </option>
                  ))}
                </optgroup>
              ) : null}
              {groups.completed.length > 0 ? <optgroup label={tr("已完成")}>
                {groups.completed.map(project => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
              </optgroup> : null}
            </select>
          </div>
          <div className="project">
            <span className="project-name">{scopedProject ? projectLabel(scopedProject) : tr("尚未选择项目")}</span>
            <span className="project-meta">
              {scopedProject
                ? scopedProject.completed_at ? tr("已完成 · 成果与对话已保留") : scopedProject.source === 'aris' ? tr("Agent 协作空间") : tr("历史研究记录")
                : tr("选择一个项目查看会话与进展")}
            </span>
          </div>
          <button type="button" className="wb-button primary wb-global-new" onClick={() => setNewResearchOpen(true)}>{tr("＋ 新建项目")}</button>
          <LanguageSwitcher />
          <div className="sync">
            <span className="sync-label">{tr(current.label)}</span>
            <span className="sync-value">{overview.lastOkAt ? clock(overview.lastOkAt) : tr("尚未同步")}</span>
            <span className="sync-state">
              {overview.error ? tr("取数失败") : !overview.lastOkAt && overview.loading ? tr("取数中") : tr("最近同步")}
            </span>
          </div>
        </header>

        {projectState.error ? <PageFailure title={tr("项目列表取数失败")} message={projectState.error.message} /> : null}
        {overview.error ? (
          <PageFailure title={tr("项目数据取数失败 · {0}", { 0: clock(overview.error.at) })} message={overview.error.message} />
        ) : null}

        <main className="content">
          {startupNotice ? <p className="wb-startup-notice" role="alert">{tr(startupNotice)}<button type="button" className="wb-icon-button" aria-label={tr("关闭启动提示")} onClick={() => setStartupNotice('')}>×</button></p> : null}
          {page !== 'focus' ? (
            <p className="crumb">
              {scopedProject ? `${projectLabel(scopedProject)} / ` : ''}
              {tr(current.label)}
            </p>
          ) : null}
          {!scopeId && !projectState.loading ? (
            <div className="empty-state">
              <strong>{tr("尚未登记项目")}</strong>
              <span>{tr("项目数据准备好后会显示在这里。")}</span>
            </div>
          ) : null}
          {scopeId && page === 'focus' && scopedProject?.source === 'aris' ? (
            <WorkbenchPage key={`workbench-${scopeKey}`} project={scopedProject} projectId={scopeId} overview={overview} revision={revision} now={now} onSelectRun={setOpenRun} onProjectChanged={() => setRevision(n => n + 1)} />
          ) : null}
          {scopeId && page === 'focus' && scopedProject?.source !== 'aris' ? (
            <FocusPage
              key={`focus-${scopeKey}`}
              project={scopedProject}
              overview={overview}
              now={now}
              onSelectRun={setOpenRun}
            />
          ) : null}
          {scopeId && page === 'results' ? (
            <ResultsPage key={`results-${scopeKey}`} projectId={scopeId} revision={revision} onOpenRun={setOpenRun} />
          ) : null}
          {scopeId && page === 'runs' ? (
            <RunsPage
              key={`runs-${scopeKey}`}
              projectId={scopeId}
              revision={revision}
              tasks={scopedOverview?.tasks ?? []}
              counts={scopedOverview?.counts ?? []}
              now={now}
              onOpenRun={setOpenRun}
              source={scopedProject?.source}
            />
          ) : null}
          {scopeId && page === 'resources' ? (
            <ResourcesPage key={`resources-${scopeKey}`} revision={revision} now={now} />
          ) : null}
        </main>
      </div>

      {newResearchOpen ? <NewResearchDialog onClose={() => setNewResearchOpen(false)} onCreated={(project, error) => {
        setNewResearchOpen(false);
        setRevision((value) => value + 1);
        selectProject(project.id);
        setStartupNotice(error ? tr("项目已创建，但启动未完成：{0}。可以在项目对话中重试新建会话。", {0:error}) : '');
      }} /> : null}

      {openRun && scopeId ? (
        <RunDetail
          key={`${scopeKey}:${openRun}`}
          runId={openRun}
          projectId={scopeId}
          revision={revision}
          now={now}
          onClose={() => setOpenRun(null)}
        />
      ) : null}
    </div>
  );
}
