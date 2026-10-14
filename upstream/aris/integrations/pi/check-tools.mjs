// Read installed Pi resources, bind its normal extension lifecycle, then inspect tools.
// No session.prompt(), reviewer call, or model request is issued.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
const [binary, cwd, aris, ...requestedSkillNames] = process.argv.slice(2);
const skillRoot = resolve(aris || '.', 'skills');
const canonicalSkillNames = existsSync(skillRoot)
  ? readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(skillRoot, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort()
  : [];
const requiredSkillNames = requestedSkillNames.length > 0 ? requestedSkillNames : canonicalSkillNames;
const safeSkillName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== '.' && name !== '..';
const invalidSkillNames = requiredSkillNames.filter((name) => !safeSkillName(name));
const missingSkillFiles = requiredSkillNames
  .filter((name) => safeSkillName(name))
  .filter((name) => !existsSync(resolve(skillRoot, name, 'SKILL.md')));
const skillPaths = requiredSkillNames
  .filter((name) => safeSkillName(name) && existsSync(resolve(skillRoot, name, 'SKILL.md')))
  .map((name) => resolve(skillRoot, name));
let dist = dirname(realpathSync(binary));
if (dist.endsWith('/bundle')) dist = dirname(dist);
const {createAgentSession} = await import(pathToFileURL(resolve(dist, 'core/sdk.js')));
const {DefaultResourceLoader} = await import(pathToFileURL(resolve(dist, 'core/resource-loader.js')));
const {SessionManager} = await import(pathToFileURL(resolve(dist, 'core/session-manager.js')));
const runtimeDir = resolve(process.env.ARIS_RUNTIME_DIR || resolve(aris, '.aris/runtime'));
const webPath=process.env.ARIS_WEB_EXTENSION || resolve(runtimeDir, 'web/node_modules/pi-web-access/index.ts');
const webInstalled=existsSync(webPath);
if (webInstalled && webPath.endsWith('/pi-web-access/index.ts')) process.env.XDG_CONFIG_HOME=resolve(runtimeDir, 'web/xdg');
process.chdir(cwd);
const loader = new DefaultResourceLoader({cwd, agentDir: process.env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi/agent'), additionalSkillPaths: skillPaths, additionalExtensionPaths:webInstalled?[webPath]:[]});
await loader.reload({resolveProjectTrust:async()=>true});
const {session} = await createAgentSession({cwd,resourceLoader:loader,sessionManager:SessionManager.inMemory()});
try {
  await session.bindExtensions({mode:'rpc'});
  const required=['mcp_codex_codex','mcp_codex_codex_reply'];
  const needsWeb = new Set(['research-pipeline','idea-discovery','research-lit','idea-creator','novelty-check']);
  const active=session.getActiveToolNames();
  const skillResult = loader.getSkills();
  const loadedSkills = skillResult.skills;
  const upstreamSkillsLoaded = requiredSkillNames.filter((name) => loadedSkills.some((skill) => {
    if (skill.name !== name) return false;
    try {
      return realpathSync(skill.filePath) === realpathSync(resolve(skillRoot, name, 'SKILL.md'));
    } catch {
      return false;
    }
  }));
  const passed = invalidSkillNames.length === 0 &&
    missingSkillFiles.length === 0 &&
    required.every(x=>active.includes(x)) &&
    (!requiredSkillNames.some((name) => needsWeb.has(name)) || ['web_search','fetch_content'].every(x=>active.includes(x))) &&
    upstreamSkillsLoaded.length === requiredSkillNames.length;
  console.log(JSON.stringify({
    modelCalls:0,
    activeReviewerTools:required.filter(x=>active.includes(x)),
    activeWebTools:['web_search','fetch_content'].filter(x=>active.includes(x)),
    requestedSkills:requiredSkillNames,
    upstreamSkillCount:canonicalSkillNames.length,
    upstreamSkillsLoaded,
    invalidSkillNames,
    missingSkillFiles,
    skillDiagnostics:skillResult.diagnostics,
    extensionErrors:loader.getExtensions().errors,
    passed
  }));
  process.exitCode=passed?0:1;
} finally {
  await session.extensionRunner.emit({type:'session_shutdown'});
  session.dispose();
}
