import { readFileSync } from 'node:fs';

/** All paths and parsers are supplied by trusted server configuration, never request data. */
export interface DshReadinessOptions {
  profilePatchPath: string;
  credentialStorePath: string;
  parseYaml: (text: string) => unknown;
  /** Use the provider's real launch snapshot; controller process.env is not equivalent. */
  launchEnvironment?: { values: Readonly<Record<string, string | undefined>>; verified: boolean };
  projectEnvPath?: string;
  homeEnvPath?: string;
  /** The vendor parser may be supplied for its complete credential document validation. */
  parseCredentialStore?: (text: string, filename: string) => { refs: ReadonlyMap<string, string> };
}
export interface DshRouteReadiness {
  provider: string;
  credentialRef?: string;
  status: 'present' | 'missing' | 'unknown';
  source?: 'env' | 'file' | 'project-env' | 'user-env';
  reason?: string;
}
export interface DshReadiness { routes: DshRouteReadiness[]; scope: 'credential-presence'; error?: string }

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonempty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

function read(path: string | undefined): { text?: string; unknown: boolean } {
  if (!path) return { unknown: true };
  try { return { text: readFileSync(path, 'utf8'), unknown: false }; }
  catch (error) { return { unknown: (error as { code?: string }).code !== 'ENOENT' }; }
}
function envPresence(path: string | undefined): { names: Set<string>; unknown: boolean } {
  const file = read(path); const names = new Set<string>();
  if (file.text !== undefined) for (const line of file.text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    // Only presence leaves this parser. Complex/multiline dotenv syntax is unknown,
    // so it cannot create a false "missing" result.
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (!value.endsWith(value[0]) || value.length < 2) return { names, unknown: true };
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (value.length) names.add(match[1]);
  }
  return { names, unknown: file.unknown };
}
function patchRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('invalid-profile');
  return value.flatMap(item => {
    const row = object(item);
    return Array.isArray(row.insert) ? patchRows(row.insert) : [row];
  });
}

/** Credential presence only. A configured key is not evidence of a successful inference. */
export function readDshReadiness(options: DshReadinessOptions): DshReadiness {
  let profiles: Record<string, unknown> = {};
  try {
    const profile = read(options.profilePatchPath);
    if (profile.text === undefined) throw new Error('missing-profile');
    const rows = patchRows(options.parseYaml(profile.text));
    for (const row of rows) if (row.id === 'llm-pi-ai') {
      if (row.disabled === true) return { scope: 'credential-presence', routes: [], error: '私有 profile 的多模型服务已禁用' };
      profiles = { ...profiles, ...object(object(row.config).providers) };
    }
  } catch {
    return { scope: 'credential-presence', routes: [], error: '无法核实私有 DSH profile；模型凭据状态未知' };
  }
  const store = read(options.credentialStorePath);
  const refs = new Set<string>(); let storeUnknown = store.unknown;
  if (store.text !== undefined) try {
    if (options.parseCredentialStore) {
      for (const [name, value] of options.parseCredentialStore(store.text, options.credentialStorePath).refs) if (nonempty(value)) refs.add(name);
    } else {
      const doc = object(options.parseYaml(store.text));
      if (Object.keys(doc).length && doc.version !== 1) throw new Error('unknown-credential-version');
      if (Object.keys(doc).some(key => !['version', 'refs', 'records'].includes(key))) throw new Error('unknown-credential-layout');
      const values = object(doc.refs);
      if (doc.refs !== undefined && (!doc.refs || typeof doc.refs !== 'object' || Array.isArray(doc.refs))) throw new Error('invalid-refs');
      for (const [name, value] of Object.entries(values)) {
        if (!REF.test(name) || !nonempty(value)) throw new Error('invalid-ref');
        refs.add(name);
      }
    }
  } catch { refs.clear(); storeUnknown = true; }
  const project = envPresence(options.projectEnvPath);
  const home = envPresence(options.homeEnvPath);
  const environment = options.launchEnvironment;
  const routes: DshRouteReadiness[] = Object.entries(profiles).map(([provider, raw]) => {
    const profile = object(raw); const ref = profile.apiKeyEnv;
    if (typeof ref !== 'string' || !REF.test(ref)) return { provider, status: 'unknown', reason: '此路由没有可核实的 API key 引用，可能使用其他认证方式' };
    // A supplied but unverified environment can establish no live-runtime facts.
    if (environment?.verified && nonempty(environment.values[ref])) return { provider, credentialRef: ref, status: 'present', source: 'env' };
    if (refs.has(ref)) return { provider, credentialRef: ref, status: 'present', source: 'file' };
    if (project.names.has(ref)) return { provider, credentialRef: ref, status: 'present', source: 'project-env' };
    if (home.names.has(ref)) return { provider, credentialRef: ref, status: 'present', source: 'user-env' };
    if (!environment?.verified || storeUnknown || project.unknown || home.unknown) return {
      provider, credentialRef: ref, status: 'unknown', reason: `尚未核实 ${ref} 的完整运行时来源`,
    };
    return { provider, credentialRef: ref, status: 'missing', reason: `未配置 ${ref}；请在私有 DSH 凭据服务中设置后重试` };
  });
  return { scope: 'credential-presence', routes };
}

/** Apply to the dsh-pi model list only; other runtime providers retain their own status. */
export function annotateDshModels<T extends { id: string; available?: boolean; unavailableReason?: string }>(models: T[], readiness: DshReadiness): Array<T & { credentialStatus: DshRouteReadiness['status'] }> {
  return models.map(model => {
    const provider = model.id.includes('/') ? model.id.slice(0, model.id.indexOf('/')) : undefined;
    const route = readiness.routes.find(candidate => candidate.provider === provider);
    return { ...model, credentialStatus: route?.status ?? 'unknown', ...(route?.status === 'missing' ? {
      available: false, unavailableReason: route.reason ?? '此模型路由缺少凭据',
    } : {}) };
  });
}
