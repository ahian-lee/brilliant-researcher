import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface SkillStep { id: string; name: string; source?: string }
export interface ArisSkill {
  id: string; name: string; title: string; description: string; group: string;
  workflow: boolean; steps: SkillStep[]; source: string;
}
export interface WorkspaceStep {
  id: string; name: string; status: string; artifact?: string; updatedAt?: string;
  acceptanceStatus?: string; readable?: boolean;
}
export interface WorkspaceWorkflow {
  id: string; name: string; status: string; runId: string; skillId?: string;
  updatedAt?: string; steps: WorkspaceStep[]; summary?: string;
}
export interface WorkspaceFigure {
  path: string; title: string; stage?: string; role: 'main' | 'supplementary' | 'unclassified';
  updatedAt: string; source: 'manifest' | 'phase-artifact' | 'discovery'; runId?: string;
}
export interface ProjectArtifact {
  path: string; mime: string; bytes: Buffer; text?: string;
  disposition: 'inline' | 'attachment'; contentSecurityPolicy?: string;
}

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 25 * 1024 * 1024;
const PDF_LIMIT = 50 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.-]+$/;
const FIGURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf']);
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.log', '.tex', '.bib', '.yaml', '.yml', '.py', '.js', '.mjs', '.ts', '.html', '.htm', '.css', '.xml']);
const LABELS: Record<string, string> = {
  implementation: '实现与验证',
  'research-pipeline': '完整研究流程', 'idea-discovery': '研究方向与想法发现',
  'idea-discovery-robot': '机器人研究想法发现', 'experiment-bridge': '实验实现与运行',
  'auto-review-loop': '独立评审与修订', 'paper-writing': '论文写作与绘图', summary: '研究总结',
  'research-lit': '文献调研', 'idea-creator': '生成研究想法', 'novelty-check': '新颖性核验',
  'research-review': '研究方案评审', 'research-refine-pipeline': '方案细化与实验规划',
  'paper-plan': '论文结构规划', 'paper-figure': '绘制论文图表', 'paper-write': '撰写论文',
  'paper-compile': '编译论文', 'auto-paper-improvement-loop': '论文评审与改进',
  rebuttal: '审稿意见回复', 'paper-talk': '论文汇报', 'patent-pipeline': '专利撰写流程',
};
// These native phase sequences are explicitly declared in the corresponding
// upstream SKILL.md run_state instructions. They are definitions, never results.
const NATIVE_PHASES: Record<string, string[]> = {
  'research-pipeline': ['idea-discovery', 'experiment-bridge', 'auto-review-loop', 'summary', 'paper-writing'],
  'idea-discovery': ['research-lit', 'idea-creator', 'novelty-check', 'research-review', 'research-refine-pipeline'],
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const clean = (value: string): string => value.replace(/\*\*|`/g, '').trim();
const label = (id: string): string => LABELS[id] ?? id;

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
/** Check both lexical and resolved paths; links cannot escape a registered root. */
function safePath(root: string, path: string): string | null {
  if (!path || path.includes('\0')) return null;
  try {
    const realRoot = realpathSync(root);
    const candidate = resolve(realRoot, path);
    if (!within(realRoot, candidate)) return null;
    const real = realpathSync(candidate);
    return within(realRoot, real) ? real : null;
  } catch { return null; }
}
function textFile(root: string, path: string): string | null {
  const safe = safePath(root, path);
  try { return safe && statSync(safe).isFile() && statSync(safe).size <= TEXT_LIMIT ? readFileSync(safe, 'utf8') : null; }
  catch { return null; }
}
function jsonFile(root: string, path: string): unknown {
  try { const text = textFile(root, path); return text === null ? null : JSON.parse(text); } catch { return null; }
}
function directories(root: string, path: string): string[] {
  const safe = safePath(root, path);
  try { return safe ? readdirSync(safe).sort() : []; } catch { return []; }
}
function portable(path: string): string { return path.split(sep).join('/'); }
function artifactPath(value: string): string { return value.split('#', 1)[0]; }
function readableArtifact(root: string, path: string): boolean {
  const safe = safePath(root, artifactPath(path));
  if (!safe) return false;
  const extension = extname(safe).toLowerCase();
  if (!MIME[extension] && !TEXT_EXTENSIONS.has(extension)) return false;
  try {
    const stat = statSync(safe);
    const limit = extension === '.pdf' ? PDF_LIMIT : MIME[extension] ? IMAGE_LIMIT : TEXT_LIMIT;
    return stat.isFile() && stat.size <= limit;
  } catch { return false; }
}

/** Read YAML string fields, including quoted multiline and folded/literal descriptions. */
function frontmatter(body: string): Record<string, string> {
  const match = body.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const field = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!field) continue;
    const key = field[1]; let value = field[2];
    const continuation: string[] = [];
    while (i + 1 < lines.length && !/^[\w-]+:/.test(lines[i + 1])) continuation.push(lines[++i]);
    if (/^[|>][-+]?\s*$/.test(value)) {
      const indent = Math.min(...continuation.filter(line => line.trim()).map(line => line.match(/^\s*/)?.[0].length ?? 0));
      const chunks = continuation.map(line => line.slice(Number.isFinite(indent) ? indent : 0));
      value = value.startsWith('>') ? chunks.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : chunks.join('\n');
    } else {
      value = [value, ...continuation.map(line => line.trim())].join(' ').trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value); } catch { value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n'); }
      } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    }
    result[key] = value.trim();
  }
  return result;
}
function catalogMetadata(arisRoot: string): Map<string, { group: string; description: string }> {
  const metadata = new Map<string, { group: string; description: string }>();
  let group = '其他技能';
  for (const line of (textFile(arisRoot, 'docs/SKILLS_CATALOG.md') ?? '').split(/\r?\n/)) {
    if (line.startsWith('## ')) group = clean(line.slice(3)).replace(/^[^\p{L}\p{N}]+/u, '');
    const row = line.match(/^\|\s*\[.*?\/([\w.-]+).*?\]\([^)]*SKILL\.md\)\s*\|\s*(.*?)\s*\|/);
    if (row) metadata.set(row[1], { group, description: clean(row[2]) });
  }
  return metadata;
}
function definedSteps(body: string, id: string): SkillStep[] {
  if (NATIVE_PHASES[id]) return NATIVE_PHASES[id].map(phase => ({ id: phase, name: label(phase), source: `skills/${id}/SKILL.md` }));
  const prose = body.replace(/^(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^\1\s*$/gm, '');
  const headings = [...prose.matchAll(/^(#{2,4})\s+((?:Phase|Stage|Step)\s+((?:\d+|[A-Z])(?:\.\d+)*[a-z]?)\s*[:：—.-]\s*[^\r\n]+)$/gim)];
  if (!headings.length) {
    const workflowSection = prose.match(/^## Workflow\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '';
    return [...workflowSection.matchAll(/^(\d+)\.\s+(.+)$/gm)].map(step => ({ id: `step-${step[1]}`, name: clean(step[2]), source: `skills/${id}/SKILL.md` }));
  }
  const depth = Math.min(...headings.map(heading => heading[1].length));
  const seen = new Set<string>();
  return headings.filter(heading => heading[1].length === depth).flatMap(heading => {
    const phase = `${heading[2].split(/\s/)[0].toLowerCase()}-${heading[3]}`;
    if (seen.has(phase)) return [];
    seen.add(phase);
    return [{ id: phase, name: clean(heading[2]), source: `skills/${id}/SKILL.md` }];
  });
}

export function readSkillCatalog(arisRoot: string): ArisSkill[] {
  const metadata = catalogMetadata(arisRoot);
  return directories(arisRoot, 'skills').filter(id => ID.test(id)).flatMap(id => {
    const source = `skills/${id}/SKILL.md`;
    const body = textFile(arisRoot, source);
    if (body === null) return [];
    const fields = frontmatter(body); const meta = metadata.get(id);
    return [{ id, name: fields.name || id, title: LABELS[id] ?? clean(body.match(/^#\s+(.+)$/m)?.[1] ?? fields.name ?? id),
      description: fields.description || meta?.description || '', group: meta?.group ?? '其他技能',
      workflow: meta?.group === 'Workflow Orchestrators' || id === 'proof-orchestrator',
      steps: definedSteps(body, id), source }];
  });
}
export function readSkillDetail(arisRoot: string, id: string): (ArisSkill & { body: string; frontmatter: Record<string, string> }) | null {
  if (!ID.test(id)) return null;
  const skill = readSkillCatalog(arisRoot).find(candidate => candidate.id === id);
  if (!skill) return null;
  const body = textFile(arisRoot, skill.source);
  return body === null ? null : { ...skill, body, frontmatter: frontmatter(body) };
}

function aggregateStatus(steps: WorkspaceStep[]): string {
  const statuses = steps.map(step => step.status.toLowerCase());
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('pending') || statuses.includes('queued')) return 'queued';
  if (statuses.length && statuses.every(status => ['accepted', 'skipped'].includes(status))) return statuses.every(status => status === 'skipped') ? 'skipped' : 'succeeded';
  if (statuses.length && statuses.every(status => ['accepted', 'skipped', 'done', 'provisional'].includes(status))) return 'completed';
  return 'unknown';
}
function inferSkill(state: Record<string, unknown>, steps: WorkspaceStep[], skills: ArisSkill[]): string | undefined {
  const explicit = string(state.skill_id) ?? string(state.workflow) ?? string(state.skill);
  if (explicit && skills.some(skill => skill.id === explicit.replace(/^\//, ''))) return explicit.replace(/^\//, '');
  const phases = steps.map(step => step.id);
  for (const [skill, known] of Object.entries(NATIVE_PHASES)) {
    if (phases.length >= 2 && phases.every(phase => known.includes(phase))) return skill;
  }
  if (phases.length === 1 && skills.some(skill => skill.id === phases[0])) return phases[0];
  return undefined;
}

export function readProjectWorkspace(project: { id: string; root: string }, arisRoot: string): { workflows: WorkspaceWorkflow[]; figures: WorkspaceFigure[] } {
  const skills = readSkillCatalog(arisRoot);
  const workflows: WorkspaceWorkflow[] = directories(project.root, '.aris/runs').filter(file => file.endsWith('.json') && ID.test(file.slice(0, -5))).map(file => {
    const state = record(jsonFile(project.root, `.aris/runs/${file}`));
    // The filename is the durable run key. Duplicate/mismatched embedded ids cannot merge runs.
    const runId = file.slice(0, -5);
    const steps: WorkspaceStep[] = (Array.isArray(state.phases) ? state.phases : []).map((raw, index) => {
      const phase = record(raw); const id = string(phase.phase) ?? `unknown-${index + 1}`;
      const artifact = string(phase.artifact);
      return { id, name: label(id), status: string(phase.status) ?? 'unknown',
        ...(artifact ? { artifact, readable: readableArtifact(project.root, artifact) } : {}),
        ...(string(phase.updated) ? { updatedAt: string(phase.updated) } : {}),
        ...(string(phase.acceptance_status) ? { acceptanceStatus: string(phase.acceptance_status) } : {}) };
    });
    const skillId = inferSkill(state, steps, skills);
    return { id: runId, runId, name: skillId ? label(skillId) : (string(state.name) ?? '原生研究流程'),
      ...(skillId ? { skillId } : {}), status: aggregateStatus(steps), steps,
      updatedAt: string(state.updated) ?? string(state.created),
      ...(!Object.keys(state).length ? { summary: '状态文件无法读取或格式无效' } : {}) };
  }).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const figures = new Map<string, WorkspaceFigure>();
  function addFigure(path: string, metadata: Partial<WorkspaceFigure>, source: WorkspaceFigure['source']) {
    const safe = safePath(project.root, path);
    if (!safe || !FIGURE_EXTENSIONS.has(extname(safe).toLowerCase())) return;
    try {
      const stat = statSync(safe);
      if (!stat.isFile() || stat.size > (extname(safe).toLowerCase() === '.pdf' ? PDF_LIMIT : IMAGE_LIMIT)) return;
      const normalized = portable(relative(realpathSync(project.root), safe));
      if (figures.has(normalized)) return;
      figures.set(normalized, { path: normalized, title: metadata.title ?? basename(normalized),
        role: metadata.role ?? 'unclassified', updatedAt: stat.mtime.toISOString(), source,
        ...(metadata.stage ? { stage: metadata.stage } : {}), ...(metadata.runId ? { runId: metadata.runId } : {}) });
    } catch { /* A disappearing artifact does not invalidate other results. */ }
  }
  const manifest = record(jsonFile(project.root, '.aris/figures.json'));
  for (const entry of Array.isArray(manifest.figures) ? manifest.figures : []) {
    const figure = record(entry); const path = string(figure.path);
    if (path) addFigure(path, { title: string(figure.title), stage: string(figure.stage),
      role: figure.role === 'main' || figure.role === 'supplementary' ? figure.role : 'unclassified' }, 'manifest');
  }
  // Only a phase's direct image/PDF artifact gives reliable stage attribution.
  const owners = new Map<string, Array<{ stage: string; runId: string }>>();
  for (const workflow of workflows) for (const step of workflow.steps) if (step.artifact) {
    const path = artifactPath(step.artifact); const safe = safePath(project.root, path);
    if (safe) owners.set(safe, [...(owners.get(safe) ?? []), { stage: step.id, runId: workflow.runId }]);
  }
  for (const [path, references] of owners) {
    const uniqueStage = new Set(references.map(owner => owner.stage)).size === 1;
    addFigure(path, { ...(uniqueStage ? { stage: references[0].stage } : {}),
      ...(references.length === 1 ? { runId: references[0].runId } : {}) }, 'phase-artifact');
  }
  const visited = new Set<string>(); let fileCount = 0;
  function scan(path: string, depth: number) {
    const safe = safePath(project.root, path);
    if (!safe || visited.has(safe) || depth > 5 || fileCount >= 3000) return;
    visited.add(safe);
    for (const name of directories(project.root, path)) {
      if (++fileCount > 3000) break;
      const child = join(path, name); const childSafe = safePath(project.root, child);
      if (!childSafe) continue;
      try { if (statSync(childSafe).isDirectory()) scan(child, depth + 1); else addFigure(child, {}, 'discovery'); } catch { /* skip unreadable */ }
    }
  }
  for (const directory of ['figures', 'figure', 'plots', 'images', 'paper/figures', 'paper/figure', 'paper/plots', 'paper/images', 'results/figures', 'results/plots', 'outputs/figures']) scan(directory, 0);
  return { workflows, figures: [...figures.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** HTTP callers must use this accessor rather than opening a client-supplied path. */
export function readProjectArtifact(input: { root: string; path: string }): ProjectArtifact | null {
  const safe = safePath(input.root, artifactPath(input.path));
  if (!safe) return null;
  const extension = extname(safe).toLowerCase();
  const mime = MIME[extension];
  if (!mime && !TEXT_EXTENSIONS.has(extension)) return null;
  try {
    const stat = statSync(safe);
    const limit = mime === 'application/pdf' ? PDF_LIMIT : mime ? IMAGE_LIMIT : TEXT_LIMIT;
    if (!stat.isFile() || stat.size > limit) return null;
    const bytes = readFileSync(safe);
    if (bytes.length > limit) return null;
    const text = !mime ? bytes.toString('utf8') : undefined;
    if (text?.includes('\0')) return null;
    return { path: portable(relative(realpathSync(input.root), safe)), mime: mime ?? 'text/plain; charset=utf-8', bytes,
      disposition: 'inline', ...(text !== undefined ? { text } : {}),
      ...(extension === '.svg' ? { contentSecurityPolicy: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}) };
  } catch { return null; }
}
