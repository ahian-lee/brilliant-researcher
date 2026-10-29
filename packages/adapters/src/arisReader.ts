import { parseStdoutLine } from './piEvents.ts';
import { buildResearchFocus } from './researchFocus.ts';
import { readAgentSessions, type AgentSessionSourceConfig } from './agentSessions.ts';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * A project root is an explicit trust boundary.  The reader never accepts a
 * path from an HTTP request; paths below come from this registration or from
 * an ARIS phase artifact, and the latter is checked against this boundary
 * before it is opened.
 */
export interface ArisProjectRegistration {
  id: string;
  root: string;
  name?: string;
  goal?: string;
  constraints?: string;
  supervisor?: string;
  executor?: string;
  reviewer?: string;
  /** User-organized project completion; independent of scientific acceptance. */
  completed_at?: string | null;
  session_source?: AgentSessionSourceConfig;
}

export interface ArisArtifact {
  path: string;
  content: string | null;
  kind: 'phase' | 'report' | 'review' | 'state';
  readable: boolean;
}

export interface ArisPhase {
  phase: string;
  status: string;
  artifact: string | null;
  artifact_path: string | null;
  artifact_content: string | null;
  verdict_id: string | null;
  reviewer: string | null;
  reviewer_family: string | null;
  reviewer_independence: string | null;
  acceptance_status: string | null;
  updated: string | null;
}

export interface ArisRun {
  run_id: string;
  created: string | null;
  updated: string | null;
  executor_model: string | null;
  status: string;
  phases: ArisPhase[];
  artifacts: ArisArtifact[];
  review_state: unknown;
  review_log: string | null;
  /** Run id attached to the project-level review/journal stream, when present. */
  journal_run_id?: string | null;
  state_error: string | null;
}

export interface ArisReaderProject {
  id: string;
  name: string;
  goal: string;
  constraints: string;
  plan_version: number;
  supervisor: string;
  updated_at: string;
  task_count: number;
  active_count: number;
  pending_review_count: number;
  human_question_count: number;
  source: 'aris';
  root: string;
  completed_at: string | null;
}

export interface ArisTaskRow {
  id: string;
  project_id: string;
  title: string;
  brief: string;
  cwd: string;
  depends_on: string;
  status: string;
  backend: string;
  resource_req: string;
  accept_hint: string;
  verdict: 'pending' | 'accepted' | 'revise' | 'rejected';
  stage: string;
  created_at: string;
  updated_at: string;
  run_id: string;
  run_status: string;
  attempt: number;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  source: 'aris';
  phase_status: string;
  phase: string;
  artifacts: ArisArtifact[];
}

export interface ArisDecisionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  action: string;
  reason: string;
  evidence_ref: string;
  author: string;
  plan_version: number;
  created_at: string;
  source: 'aris';
  phase_status?: string;
}

export interface ArisResultRow {
  id: string;
  title: string;
  stage: string;
  verdict: 'pending' | 'accepted' | 'revise' | 'rejected';
  accept_hint: string;
  updated_at: string;
  run_id: string;
  run_status: string;
  attempt: number;
  final_report: string | null;
  tool_calls: number | null;
  source: 'aris';
  phase_status: string;
  phase: string;
  artifacts: ArisArtifact[];
}

/** A Pi journal event shown at project scope, without run attribution. */
export interface ArisProjectJournalEvent {
  run_id: null;
  source_seq: number;
  kind: string;
  at_occurred: string;
  at_received: string;
  summary: string;
  log_ref: string;
}

/**
 * The project-level journal is intentionally separate from runDetail(): a
 * project may contain several ARIS subflows whose historical Pi journal is a
 * shared file.  Events here remain explicitly unassigned to any run.
 */
export interface ArisProjectJournal {
  scope: 'project';
  project_id: string;
  events: ArisProjectJournalEvent[];
  cursor: number;
  files: string[];
  has_more: boolean;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const RUN_ID_RE = /^[A-Za-z0-9_.-]+$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_.:-]+$/;

/** Parse the explicit BRI_ARIS_PROJECTS file. Relative roots are relative to that file. */
export function loadArisProjectRegistrations(file: string | undefined, baseDir: string): ArisProjectRegistration[] {
  if (!file || !file.trim()) return [];
  const configPath = resolve(baseDir, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`BRI_ARIS_PROJECTS 无法读取或解析：${configPath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { projects?: unknown }).projects)
      ? (parsed as { projects: unknown[] }).projects
      : null;
  if (!entries) throw new Error(`BRI_ARIS_PROJECTS 必须是数组，或包含 projects 数组：${configPath}`);

  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`BRI_ARIS_PROJECTS[${index}] 必须是对象`);
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const rootValue = typeof raw.root === 'string' ? raw.root.trim() : '';
    if (!PROJECT_ID_RE.test(id)) throw new Error(`BRI_ARIS_PROJECTS[${index}].id 无效`);
    if (!rootValue) throw new Error(`BRI_ARIS_PROJECTS[${index}].root 必填`);
    if (seen.has(id)) throw new Error(`BRI_ARIS_PROJECTS 出现重复项目 id：${id}`);
    seen.add(id);
    return {
      id,
      root: resolve(dirname(configPath), rootValue),
      name: optionalText(raw.name),
      goal: optionalText(raw.goal),
      constraints: optionalText(raw.constraints),
      supervisor: optionalText(raw.supervisor),
      executor: optionalText(raw.executor),
      reviewer: optionalText(raw.reviewer),
      completed_at: typeof raw.completed_at === 'string' && Number.isFinite(Date.parse(raw.completed_at)) ? raw.completed_at : null,
      session_source: sessionSource(raw.session_source),
    };
  });
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sessionSource(value: unknown): AgentSessionSourceConfig | undefined {
  if (value === undefined) return undefined;
  const source = asRecord(value);
  if (source.kind === 'dsh-local' && optionalText(source.home)) {
    return { kind: 'dsh-local', home: optionalText(source.home)! };
  }
  if (source.kind === 'project-export' && (source.path === undefined || optionalText(source.path))) {
    return { kind: 'project-export', path: optionalText(source.path) };
  }
  throw new Error('session_source 必须是 dsh-local（含 home）或 project-export（可选 path）');
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function stageForPhase(phase: string): string {
  const value = phase.toLowerCase().trim().replaceAll('_', '-').replaceAll(' ', '-');
  // Keep the native research-pipeline stages visible as five distinct stages.
  // The legacy aliases below remain for older ARIS/BRI records.
  if (value === 'idea-discovery' || value === 'idea') return 'idea';
  // `/idea-discovery` is itself a small native workflow. Its literature,
  // creator, novelty, review and refine sub-phases all belong to the first
  // top-level Idea stage in the Dashboard.
  if (value === 'research-lit' || value === 'idea-creator' || value === 'novelty-check' || value === 'research-review' || value === 'research-refine-pipeline') return 'idea';
  if (value === 'experiment-bridge' || value === 'experiments') return 'experiments';
  if (value === 'auto-review-loop') return 'review';
  if (value === 'summary') return 'summary';
  if (value === 'paper-writing' || value === 'paper') return 'paper';
  if (value.includes('literature') || value.includes('idea')) return 'literature';
  if (value.includes('plan')) return 'plan';
  if (value.includes('experiment') || value.includes('pilot')) return 'experiment';
  if (value.includes('review') || value.includes('audit')) return 'review';
  if (value.includes('write') || value.includes('paper') || value.includes('report')) return 'writing';
  return 'unknown';
}

function phaseStatus(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'unknown';
}

function runStatus(phases: ArisPhase[]): string {
  if (phases.length === 0) return 'unknown';
  const statuses = phases.map((phase) => phase.status.toLowerCase());
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('pending')) return 'queued';
  // Executor completion is separate from acceptance. It is neither success
  // nor a live process waiting for user input.
  if (statuses.every((status) => ['done', 'provisional', 'accepted', 'skipped'].includes(status)) &&
      statuses.some((status) => status === 'done' || status === 'provisional')) return 'completed';
  if (statuses.every((status) => status === 'accepted' || status === 'skipped')) return 'succeeded';
  return 'unknown';
}

function verdictForPhase(status: string): 'pending' | 'accepted' | 'revise' | 'rejected' {
  // ARIS `done` is executor completion. It is intentionally not accepted.
  return status.toLowerCase() === 'accepted' ? 'accepted' : 'pending';
}

function runHasEnded(status: string): boolean {
  return ['succeeded', 'failed', 'completed'].includes(status);
}

function phaseTaskId(projectId: string, runId: string, phase: string): string {
  return `aris:${projectId}:${runId}:${phase}`;
}

function normalizeArtifactPath(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * Native ARIS locators may carry a Markdown-style fragment, for example
 * `idea-stage/IDEA_REPORT.md#literature-landscape`.  The fragment is useful
 * to the Dashboard as a locator, but it is not part of the filesystem path.
 * Keep the original locator in the phase payload and strip only the fragment
 * when enforcing the project-root boundary or reading the file.
 */
function filesystemPathFromLocator(value: string): string {
  const normalized = normalizeArtifactPath(value);
  const fragmentAt = normalized.indexOf('#');
  return fragmentAt >= 0 ? normalized.slice(0, fragmentAt) : normalized;
}

type InternalRun = ArisRun & { state: Record<string, unknown> };

const KNOWN_FILES: Array<{ path: string; kind: ArisArtifact['kind'] }> = [
  { path: 'REPORT.md', kind: 'report' },
  { path: 'PIPELINE_SUMMARY.md', kind: 'report' },
  { path: 'NARRATIVE_REPORT.md', kind: 'report' },
  { path: 'SUMMARY.md', kind: 'report' },
  { path: 'SCOPE.md', kind: 'report' },
  { path: 'DEBUG_REPORT.md', kind: 'report' },
  { path: 'outputs/final_summary.md', kind: 'report' },
  { path: 'idea-stage/IDEA_REPORT.md', kind: 'report' },
  { path: 'idea-stage/IDEA_CANDIDATES.md', kind: 'report' },
  { path: 'refine-logs/EXPERIMENT_PLAN.md', kind: 'report' },
  { path: 'refine-logs/EXPERIMENT_TRACKER.md', kind: 'report' },
  { path: 'refine-logs/EXPERIMENT_RESULTS.md', kind: 'report' },
  { path: 'EXPERIMENT_LOG.md', kind: 'report' },
  { path: 'review-stage/AUTO_REVIEW.md', kind: 'review' },
  { path: 'review-stage/REVIEW_STATE.json', kind: 'state' },
  { path: 'review-stage/REVIEWER_MEMORY.md', kind: 'review' },
  { path: 'pi-events.jsonl', kind: 'state' },
];

const REPORT_DIRECTORIES = ['outputs', 'idea-stage', 'refine-logs', 'review-stage', 'summary-stage', 'paper', 'paper-stage'];
const REPORT_EXTENSIONS = new Set(['.csv', '.json', '.jsonl', '.log', '.markdown', '.md', '.tex', '.tsv', '.txt', '.yaml', '.yml']);
const MAX_DISCOVERED_ARTIFACTS = 400;
const MAX_REPORT_DEPTH = 4;

function artifactKind(path: string): ArisArtifact['kind'] {
  const normalized = normalizeArtifactPath(path);
  if (normalized.startsWith('review-stage/')) {
    return normalized.endsWith('REVIEW_STATE.json') ? 'state' : 'review';
  }
  if (normalized.endsWith('.jsonl') || normalized.endsWith('.log')) return 'state';
  return 'report';
}

function isTextArtifact(path: string): boolean {
  return REPORT_EXTENSIONS.has(extname(path).toLowerCase());
}

function isRootReportName(name: string): boolean {
  return isTextArtifact(name) && !name.startsWith('.') && !name.includes('/') && !name.includes('\\');
}

function isJournalName(name: string): boolean {
  return /^pi(?:-[A-Za-z0-9_.-]+)?-events\.jsonl$/.test(name);
}

function isStderrName(name: string): boolean {
  // Older launchers used `pi.stderr.log`; native recovery writers use the
  // hyphenated `pi-recovery-stderr.log` form.
  return /^(?:pi(?:-[A-Za-z0-9_.-]+)?-stderr|pi\.stderr)\.log$/.test(name);
}

function eventRunId(line: string): string | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const nested = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? value.metadata as Record<string, unknown>
      : {};
    for (const candidate of [value.run_id, value.runId, nested.run_id, nested.runId]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // parseStdoutLine owns the user-visible noise handling; this helper only
    // checks optional run scoping when the line itself is JSON.
  }
  return null;
}

export class ArisReader {
  private readonly projectsById: Map<string, ArisProjectRegistration>;

  constructor(registrations: readonly ArisProjectRegistration[]) {
    this.projectsById = new Map(registrations.map((entry) => [entry.id, { ...entry, root: resolve(entry.root) }]));
  }

  hasProject(projectId: string): boolean {
    return this.projectsById.has(projectId);
  }

  findRunProject(runId: string): string | null {
    if (!RUN_ID_RE.test(runId)) return null;
    for (const projectId of this.projectsById.keys()) {
      if (this.readRuns(projectId).some((run) => run.run_id === runId)) return projectId;
    }
    return null;
  }

  listProjects(): ArisReaderProject[] {
    return [...this.projectsById.keys()].map((projectId) => this.project(projectId));
  }

  overview(projectId: string, options: { summary?: boolean } = {}): {
    project: ArisReaderProject;
    tasks: ArisTaskRow[];
    host: null;
    inbox: never[];
    counts: Array<{ status: string; n: number }>;
    supervisorUpdates: never[];
    decisions: ArisDecisionRow[];
    lastChangeSeq: number;
    source: 'aris';
    nativeReport: string | null;
    focus: ReturnType<typeof buildResearchFocus>;
  } {
    const runs = this.readRuns(projectId);
    // Polling progress must not serialize the same full reports for every
    // historical phase. Detailed records remain available through explicit reads.
    const tasks = options.summary ? [] : runs.flatMap((run) => run.phases.map((phase) => this.task(projectId, run, phase)));
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    const latestRun = [...runs].sort((a,b)=>(b.updated ?? '').localeCompare(a.updated ?? '')).at(0);
    const registration = this.registration(projectId);
    const focus = buildResearchFocus(runs, this.safeJson(registration, '.aris/progress.json'), registration, Date.now(), this.recordedDecisions(registration));
    const sessionSnapshot = readAgentSessions(registration);
    focus.sessions = sessionSnapshot.sessions;
    focus.session_note = sessionSnapshot.source.message;
    return {
      project: this.project(projectId, runs, focus),
      tasks,
      host: null,
      inbox: [],
      counts: [...counts.entries()].map(([status, n]) => ({ status, n })),
      supervisorUpdates: [],
      decisions: options.summary ? [] : this.decisions(projectId, runs),
      lastChangeSeq: 0,
      source: 'aris',
      nativeReport: options.summary ? null : latestRun?.artifacts.find(a=>a.path === 'REPORT.md')?.content ?? latestRun?.artifacts.find(a=>a.kind === 'report')?.content ?? latestRun?.review_log ?? null,
      focus,
    };
  }

  results(projectId: string): { results: ArisResultRow[]; decisions: ArisDecisionRow[]; source: 'aris' } {
    const runs = this.readRuns(projectId);
    return {
      results: runs.flatMap((run) => run.phases.map((phase) => this.result(projectId, run, phase))),
      decisions: this.decisions(projectId, runs),
      source: 'aris',
    };
  }

  runs(projectId: string): Array<Record<string, unknown>> {
    return this.readRuns(projectId).map((run) => ({
      id: run.run_id,
      task_id: phaseTaskId(projectId, run.run_id, run.phases[0]?.phase ?? 'run'),
      attempt: 1,
      host: 'aris',
      runtime_session_id: run.run_id,
      workdir: this.registration(projectId).root,
      out_path: '',
      err_path: '',
      pid: null,
      status: run.status,
      exit_reason: run.state_error ?? `ARIS phases: ${run.phases.map((phase) => `${phase.phase}=${phase.status}`).join(', ') || 'unknown'}`,
      exit_code: null,
      started_at: run.created,
      ended_at: runHasEnded(run.status) ? run.updated : null,
      created_at: run.created ?? run.updated ?? new Date(0).toISOString(),
      source: 'aris' as const,
      phase_statuses: run.phases.map((phase) => ({ phase: phase.phase, status: phase.status })),
      artifacts: run.artifacts,
    }));
  }

  runDetail(projectId: string, runId: string, after = 0, limit = 200): Record<string, unknown> | undefined {
    const run = this.readRuns(projectId).find((candidate) => candidate.run_id === runId);
    if (!run) return undefined;
    const task = run.phases[0] ? this.task(projectId, run, run.phases[0]) : null;
    const journals = this.journalPaths(projectId);
    const stderr = this.stderrPaths(projectId);
    return {
      run: this.runs(projectId).find((candidate) => candidate.id === runId) ?? null,
      task,
      events: this.piEvents(projectId, run, after, limit),
      decisions: this.decisions(projectId, [run]),
      // Keep the legacy out/err fields and expose every retained Pi journal so
      // recovery evidence is discoverable without making a second write path.
      logPaths: {
        out: journals[0] ?? '',
        err: stderr[0] ?? '',
        journals,
        stderr,
      },
      source: 'aris',
      phases: run.phases,
      artifacts: run.artifacts,
      reviewState: run.review_state,
      reviewLog: run.review_log,
    };
  }

  /**
   * Read the retained Pi journal at project scope.  This is the safe view for
   * projects with multiple ARIS subflows: events are deliberately returned
   * with `run_id: null` instead of being guessed into a particular run.
   */
  projectJournal(projectId: string, after = 0, limit = 200): ArisProjectJournal {
    const files = this.journalFiles(projectId);
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
    const events: ArisProjectJournalEvent[] = [];
    let sourceSeq = 0;
    let hasMore = false;

    for (const file of files) {
      let lines: string[];
      try {
        if (statSync(file).size > 32 * 1024 * 1024) continue;
        lines = readFileSync(file, 'utf8').split('\n');
      } catch {
        continue;
      }
      // Ignore a live writer's unterminated final line.  A trailing newline
      // contributes an empty split item, which is harmless after this pop.
      lines.pop();
      const logName = basename(file);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        sourceSeq += 1;
        if (sourceSeq <= cursor) continue;
        const parsed = parseStdoutLine(line);
        if (parsed.kind !== 'event' || !parsed.summary) continue;
        if (events.length >= count) {
          hasMore = true;
          continue;
        }
        events.push({
          run_id: null,
          source_seq: sourceSeq,
          kind: parsed.eventType,
          at_occurred: '',
          at_received: '',
          summary: parsed.summary,
          log_ref: `${logName}#L${lineIndex + 1}`,
        });
      }
    }

    const nextCursor = hasMore ? events.at(-1)?.source_seq ?? cursor : Math.max(cursor, sourceSeq);
    return {
      scope: 'project',
      project_id: projectId,
      events,
      cursor: nextCursor,
      files,
      has_more: hasMore,
    };
  }

  private piEvents(projectId: string, run: ArisRun, after: number, limit: number): Array<Record<string, unknown>> {
    // Reuse BRI's Pi event parser; never expose streaming deltas or the entire log in the overview.
    const state = asRecord(run.review_state);
    if ((run.journal_run_id && run.journal_run_id !== run.run_id) || (state.run_id && state.run_id !== run.run_id)) return [];
    const files = this.journalFiles(projectId);
    if (files.length === 0) return [];
    // Project-level Pi journals are historically shared by all runs and often
    // have no run id on individual lines.  Once a project has more than one
    // run, attaching those unscoped lines to every run would fabricate a run
    // timeline.  Explicit line run ids remain usable; otherwise the journal
    // is still exposed through artifacts/logPaths without being attributed.
    const journalIsAmbiguous = !run.journal_run_id
      && this.readRuns(projectId).some((candidate) => candidate.run_id !== run.run_id);
    const rows: Array<Record<string, unknown>> = [];
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit,500) : 200;
    let sourceSeq = 0;
    for (const file of files) {
      let lines: string[];
      try {
        if (statSync(file).size > 32 * 1024 * 1024) continue;
        lines = readFileSync(file, 'utf8').split('\n');
      } catch {
        continue;
      }
      // A live writer may leave its final JSON line unterminated. Ignore that
      // line just as the historical single-file reader did.
      lines.pop();
      const logName = basename(file);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        sourceSeq += 1;
        if (sourceSeq <= cursor || rows.length >= count) continue;
        const lineRunId = eventRunId(line);
        if (lineRunId && lineRunId !== run.run_id) continue;
        if (!lineRunId && journalIsAmbiguous) continue;
        const parsed = parseStdoutLine(line);
        if (parsed.kind !== 'event' || !parsed.summary) continue;
        rows.push({run_id:run.run_id, source_seq:sourceSeq, kind:parsed.eventType, at_occurred:'', at_received:'', summary:parsed.summary, log_ref:`${logName}#L${lineIndex + 1}`});
      }
      if (rows.length >= count) break;
    }
    return rows;
  }

  private journalFiles(projectId: string): string[] {
    const root = this.safePath(this.registration(projectId), '.');
    if (!root) return [];
    try {
      return readdirSync(root)
        .filter(isJournalName)
        .sort((a, b) => {
          // The primary journal is the stable first cursor segment; recovery
          // journals follow in lexical order and remain separately referenced.
          if (a === 'pi-events.jsonl') return -1;
          if (b === 'pi-events.jsonl') return 1;
          return a.localeCompare(b);
        })
        .map((name) => this.safePath(this.registration(projectId), name))
        .filter((path): path is string => Boolean(path));
    } catch {
      return [];
    }
  }

  private journalPaths(projectId: string): string[] {
    return this.journalFiles(projectId);
  }

  private stderrPaths(projectId: string): string[] {
    const root = this.safePath(this.registration(projectId), '.');
    if (!root) return [];
    try {
      return readdirSync(root)
        .filter(isStderrName)
        .sort()
        .map((name) => this.safePath(this.registration(projectId), name))
        .filter((path): path is string => Boolean(path));
    } catch {
      return [];
    }
  }

  private registration(projectId: string): ArisProjectRegistration {
    const registration = this.projectsById.get(projectId);
    if (!registration) throw new Error(`ARIS project not registered: ${projectId}`);
    return registration;
  }

  private recordedDecisions(registration: ArisProjectRegistration) {
    const control = this.safeJson(registration, '.bri/workbench.json') as { recordedDecisions?: import('./researchFocus.ts').RecordedDecision[] } | null;
    return Array.isArray(control?.recordedDecisions) ? control.recordedDecisions : [];
  }

  private managedActiveCount(registration: ArisProjectRegistration): number | undefined {
    const store = asRecord(this.safeJson(registration, '.bri/collaboration.json'));
    if (store.version !== 1 || !Array.isArray(store.runs)) return undefined;
    // The collaboration store is append ordered, just as CollaborationLoop.status().
    // Native phase records remain historical evidence, not live process counts.
    const current = asRecord(store.runs.at(-1));
    if (!textOrNull(current.id)) return undefined;
    if (current.state === 'accepted' && current.acceptanceRecordPending === true) return 1;
    if (['paused', 'budget_exhausted', 'needs_attention', 'accepted', 'audited'].includes(String(current.state))) return 0;
    if (['ready', 'planning', 'executing', 'reviewing', 'stopping', 'synchronizing'].includes(String(current.state))) return 1;
    return undefined;
  }

  private project(projectId: string, runs: InternalRun[] = this.readRuns(projectId), preparedFocus?: ReturnType<typeof buildResearchFocus>): ArisReaderProject {
    const registration = this.registration(projectId);
    const phases = runs.flatMap((run) => run.phases);
    const focus = preparedFocus ?? buildResearchFocus(runs, this.safeJson(registration, '.aris/progress.json'), registration, Date.now(), this.recordedDecisions(registration));
    const latest = runs.map((run) => run.updated ?? run.created).filter((value): value is string => Boolean(value)).sort().at(-1) ?? '';
    return {
      id: registration.id,
      name: registration.name ?? registration.id,
      goal: registration.goal ?? 'ARIS 项目目标未记录',
      constraints: registration.constraints ?? '',
      plan_version: 0,
      supervisor: registration.supervisor ?? 'Pi / ARIS',
      updated_at: latest,
      task_count: phases.length,
      active_count: this.managedActiveCount(registration) ?? phases.filter((phase) => phase.status === 'running' && Boolean(phase.updated)
        && Date.now() - Date.parse(phase.updated!) < 15 * 60_000).length,
      // These Idea helper steps produce artifacts; their workflow owns the
      // review. Do not invent a separate review requirement for each helper.
      human_question_count: focus.questions.length,
      pending_review_count: focus.stages.filter((phase) =>
        ['done', 'provisional'].includes(phase.status) &&
        !['research-lit', 'idea-creator', 'research-refine-pipeline'].includes(phase.id)
      ).length,
      source: 'aris',
      root: registration.root,
      completed_at: registration.completed_at ?? null,
    };
  }

  private readRuns(projectId: string): InternalRun[] {
    const registration = this.registration(projectId);
    const directory = this.safePath(registration, '.aris/runs');
    if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) return [];
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith('.json') && RUN_ID_RE.test(name.slice(0, -5))).sort();
    } catch {
      return [];
    }
    if (!names.length) return [];
    // One synchronous projection reads shared reports once. Nothing survives
    // this call, so the next poll observes changed files and human questions.
    const texts = new Map<string, string | null>();
    const readText = (child: string): string | null => {
      const key = filesystemPathFromLocator(child);
      if (!texts.has(key)) texts.set(key, this.safeText(registration, child));
      return texts.get(key)!;
    };
    const reviewState = asRecord(this.safeJson(registration, 'review-stage/REVIEW_STATE.json'));
    const reportArtifacts = this.discoverArtifacts(registration, true).flatMap(({ path, kind }) => {
      const content = readText(path);
      return content === null ? [] : [{ path, content, kind, readable: true } satisfies ArisArtifact];
    });
    return names.map((name) => this.readRun(registration, name.slice(0, -5), { readText, reviewState, reportArtifacts })).filter((run): run is InternalRun => Boolean(run));
  }

  private readRun(registration: ArisProjectRegistration, runId: string, shared: {
    readText: (child: string) => string | null;
    reviewState: Record<string, unknown>;
    reportArtifacts: ArisArtifact[];
  }): InternalRun | null {
    const statePath = this.safePath(registration, `.aris/runs/${runId}.json`);
    if (!statePath) return null;
    let state: Record<string, unknown> = {};
    let stateError: string | null = null;
    try {
      const raw = readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = asRecord(parsed);
      if (!Object.keys(state).length) stateError = 'ARIS 状态文件不是对象';
    } catch (error) {
      stateError = `ARIS 状态文件无法读取：${error instanceof Error ? error.message : String(error)}`;
    }

    const rawPhases = Array.isArray(state.phases) ? state.phases : [];
    const phases = rawPhases.map((raw) => {
      const value = asRecord(raw);
      const artifact = textOrNull(value.artifact);
      const artifactPath = artifact ? normalizeArtifactPath(artifact) : null;
      const artifactContent = artifactPath ? shared.readText(artifactPath) : null;
      return {
        phase: textOrNull(value.phase) ?? 'unknown',
        status: phaseStatus(value.status),
        artifact,
        artifact_path: artifactPath,
        artifact_content: artifactContent,
        verdict_id: textOrNull(value.verdict_id),
        reviewer: textOrNull(value.reviewer),
        reviewer_family: textOrNull(value.reviewer_family),
        reviewer_independence: textOrNull(value.reviewer_independence) ?? textOrNull(value.review_independence),
        acceptance_status: textOrNull(value.acceptance_status),
        updated: textOrNull(value.updated),
      } satisfies ArisPhase;
    });
    const projectReviewState = shared.reviewState;
    const reviewMatches = !projectReviewState.run_id || projectReviewState.run_id === runId;
    const reportArtifacts = reviewMatches ? shared.reportArtifacts : shared.reportArtifacts.filter(artifact => !artifact.path.startsWith('review-stage/'));
    const phaseArtifacts = phases.flatMap((phase) =>
      phase.artifact_path
        ? [{ path: phase.artifact_path, content: phase.artifact_content, kind: 'phase' as const, readable: phase.artifact_content !== null }]
        : [],
    );
    const artifacts = [
      ...new Map<string, ArisArtifact>(
        [...reportArtifacts, ...phaseArtifacts].map((artifact) => [artifact.path, artifact] as [string, ArisArtifact]),
      ).values(),
    ];
    const reviewState = reviewMatches ? projectReviewState : null;
    return {
      state,
      run_id: textOrNull(state.run_id) ?? runId,
      created: textOrNull(state.created),
      updated: textOrNull(state.updated),
      executor_model: textOrNull(state.executor_model),
      status: runStatus(phases),
      phases,
      artifacts,
      review_state: reviewState,
      review_log: reviewMatches ? shared.readText('review-stage/AUTO_REVIEW.md') : null,
      journal_run_id: textOrNull(projectReviewState.run_id),
      state_error: stateError,
    };
  }

  /**
   * Discover the report-shaped files produced by the native workflows. The
   * project registration remains the only root; directory enumeration is
   * restricted to report directories and text-like extensions, and every
   * candidate still goes through safeText (including realpath checks).
   */
  private discoverArtifacts(
    registration: ArisProjectRegistration,
    reviewMatches: boolean,
  ): Array<{ path: string; kind: ArisArtifact['kind'] }> {
    const paths = new Map<string, ArisArtifact['kind']>();
    const add = (path: string, kind = artifactKind(path)): void => {
      const normalized = normalizeArtifactPath(path);
      if (!paths.has(normalized) && paths.size < MAX_DISCOVERED_ARTIFACTS) paths.set(normalized, kind);
    };

    for (const entry of KNOWN_FILES) add(entry.path, entry.kind);

    const root = this.safePath(registration, '.');
    if (!root) return [];
    try {
      for (const name of readdirSync(root)) {
        if (isRootReportName(name) || isJournalName(name) || isStderrName(name)) add(name);
      }
    } catch {
      // The fixed entries below still get a chance to be read.
    }

    for (const directory of REPORT_DIRECTORIES) {
      this.discoverDirectory(registration, directory, add, 0);
    }

    return [...paths.entries()]
      .filter(([path]) => reviewMatches || !path.startsWith('review-stage/'))
      .map(([path, kind]) => ({ path, kind }));
  }

  private discoverDirectory(
    registration: ArisProjectRegistration,
    directory: string,
    add: (path: string, kind?: ArisArtifact['kind']) => void,
    depth: number,
  ): void {
    if (depth > MAX_REPORT_DEPTH) return;
    const directoryPath = this.safePath(registration, directory || '.');
    if (!directoryPath) return;
    try {
      for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
        const child = directory ? join(directory, entry.name) : entry.name;
        if (entry.isDirectory()) {
          this.discoverDirectory(registration, child, add, depth + 1);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          if (isTextArtifact(entry.name)) add(child);
        }
      }
    } catch {
      return;
    }
  }

  private safePath(registration: ArisProjectRegistration, child: string): string | null {
    const lexicalRoot = resolve(registration.root);
    const lexical = resolve(lexicalRoot, filesystemPathFromLocator(child));
    if (!inside(lexicalRoot, lexical) || !existsSync(lexical)) return null;
    let rootReal: string;
    let candidateReal: string;
    try {
      rootReal = realpathSync(lexicalRoot);
      candidateReal = realpathSync(lexical);
    } catch {
      return null;
    }
    if (!inside(rootReal, candidateReal)) return null;
    try {
      if (!lstatSync(candidateReal).isFile() && !lstatSync(candidateReal).isDirectory()) return null;
    } catch {
      return null;
    }
    return candidateReal;
  }

  private safeText(registration: ArisProjectRegistration, child: string): string | null {
    const path = this.safePath(registration, child);
    if (!path) return null;
    try {
      if (!statSync(path).isFile() || statSync(path).size > MAX_TEXT_BYTES) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  private safeJson(registration: ArisProjectRegistration, child: string): unknown {
    const text = this.safeText(registration, child);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { status: 'unknown', error: 'invalid_json' };
    }
  }

  private task(projectId: string, run: ArisRun, phase: ArisPhase): ArisTaskRow {
    const created = run.created ?? phase.updated ?? '';
    const updated = phase.updated ?? run.updated ?? created;
    return {
      id: phaseTaskId(projectId, run.run_id, phase.phase),
      project_id: projectId,
      title: phase.phase,
      brief: phase.artifact_path ? `ARIS 原生产物：${phase.artifact_path}` : 'ARIS 阶段产物未记录',
      cwd: this.registration(projectId).root,
      depends_on: '',
      status: phase.status,
      backend: 'aris',
      resource_req: 'ARIS 原生记录',
      accept_hint: 'accepted 只在 ARIS 原生记录明确写入时展示；done 仍为未验收',
      verdict: verdictForPhase(phase.status),
      stage: stageForPhase(phase.phase),
      created_at: created,
      updated_at: updated,
      run_id: run.run_id,
      run_status: run.status,
      attempt: 1,
      started_at: created || null,
      ended_at: runHasEnded(run.status) ? updated || null : null,
      event_count: 0,
      source: 'aris',
      phase_status: phase.status,
      phase: phase.phase,
      artifacts: run.artifacts,
    };
  }

  private result(projectId: string, run: ArisRun, phase: ArisPhase): ArisResultRow {
    const task = this.task(projectId, run, phase);
    return {
      id: task.id,
      title: task.title,
      stage: task.stage,
      verdict: task.verdict,
      accept_hint: task.accept_hint,
      updated_at: task.updated_at,
      run_id: run.run_id,
      run_status: run.status,
      attempt: 1,
      final_report: phase.artifact_content ?? this.fallbackReport(run, phase),
      tool_calls: null,
      source: 'aris',
      phase_status: phase.status,
      phase: phase.phase,
      artifacts: run.artifacts,
    };
  }

  private fallbackReport(run: ArisRun, phase: ArisPhase): string | null {
    if (phase.status.toLowerCase() === 'skipped') return null;
    const preferred = phase.phase.toLowerCase().includes('review')
      ? run.artifacts.find((artifact) => artifact.path === 'review-stage/AUTO_REVIEW.md')
      : run.artifacts.find((artifact) => artifact.kind === 'report');
    return preferred?.content ?? null;
  }

  private latestNativeReview(projectId: string, run: ArisRun): ArisDecisionRow[] {
    const state = asRecord(run.review_state);
    const verdict = textOrNull(state.last_verdict);
    // Transport errors and missing assessment are not reviewer verdicts.
    if (!verdict || !['ready','almost','not ready'].includes(verdict)) return [];
    const phase = run.phases.find(p=>p.phase.toLowerCase().includes('review'));
    return [{
      id: `aris-review:${projectId}:${run.run_id}:${String(state.round ?? 'unknown')}`,
      project_id:projectId, task_id:phase ? phaseTaskId(projectId,run.run_id,phase.phase) : null,
      action: verdict === 'not ready' ? 'revise' : 'review_positive',
      reason: `ARIS 原始评审：round=${String(state.round ?? '未记录')}，verdict=${verdict}，score=${String(state.last_score ?? '未记录')}；阶段验收仍以原生 phase 状态为准`,
      evidence_ref: 'review-stage/AUTO_REVIEW.md', author: textOrNull(state.reviewer_backend) ?? 'ARIS reviewer',
      plan_version:0, created_at:textOrNull(state.timestamp) ?? run.updated ?? '', source:'aris', phase_status:phase?.status,
    }];
  }

  private decisions(projectId: string, runs: ArisRun[]): ArisDecisionRow[] {
    return runs.flatMap((run) => [
      ...this.latestNativeReview(projectId, run),
      ...run.phases
        .filter((phase) => phase.status === 'accepted' || phase.status === 'provisional')
        .map((phase) => ({
          id: `aris-decision:${projectId}:${run.run_id}:${phase.phase}`,
          project_id: projectId,
          task_id: phaseTaskId(projectId, run.run_id, phase.phase),
          action: phase.status,
          reason: phase.reviewer
            ? `ARIS 原生阶段 ${phase.phase} 由 ${phase.reviewer} 记录为 ${phase.status}`
            : `ARIS 原生阶段 ${phase.phase} 状态为 ${phase.status}`,
          evidence_ref: phase.verdict_id ?? phase.artifact_path ?? '',
          author: phase.reviewer ?? 'ARIS',
          plan_version: 0,
          created_at: phase.updated ?? run.updated ?? run.created ?? '',
          source: 'aris' as const,
          phase_status: phase.status,
        })),
    ]);
  }
}
