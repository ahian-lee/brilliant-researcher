// Verify the ARIS WebSearch/WebFetch extension without a model request.
// Usage: node check-web-tools.mjs /path/to/pi /workdir [extension-path]
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const [binary, cwd = process.cwd(), extensionArg] = process.argv.slice(2);
if (!binary) {
  console.error("usage: node check-web-tools.mjs /path/to/pi /workdir [extension-path]");
  process.exit(2);
}

let dist = dirname(realpathSync(binary));
if (dist.endsWith("/bin")) dist = resolve(dist, "../lib/node_modules/@earendil-works/pi-coding-agent/dist");
if (dist.endsWith("/bundle")) dist = dirname(dist);

const runtimeDir = resolve(
  process.env.ARIS_RUNTIME_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../../.aris/runtime"),
);
const extensionPath = resolve(
  extensionArg ?? process.env.ARIS_WEB_EXTENSION ?? resolve(runtimeDir, "web/node_modules/pi-web-access/index.ts"),
);
if(extensionPath.endsWith('/pi-web-access/index.ts')) process.env.XDG_CONFIG_HOME=resolve(runtimeDir, 'web/xdg');
const { createAgentSession } = await import(pathToFileURL(resolve(dist, "core/sdk.js")));
const { DefaultResourceLoader } = await import(pathToFileURL(resolve(dist, "core/resource-loader.js")));
const { SessionManager } = await import(pathToFileURL(resolve(dist, "core/session-manager.js")));

process.chdir(resolve(cwd));
const loader = new DefaultResourceLoader({
  cwd: resolve(cwd),
  agentDir: process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent"),
  additionalExtensionPaths: [extensionPath],
});
await loader.reload({ resolveProjectTrust: async () => true });
const { session } = await createAgentSession({
  cwd: resolve(cwd),
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

try {
  await session.bindExtensions({ mode: "rpc" });
  // pi-web-access uses the canonical names. The local fallback also exposes
  // ARIS-compatible aliases, but the official package is not required to do
  // so; the launcher maps WebSearch/WebFetch in its prompt to these names.
  const required = ["web_search", "fetch_content"];
  const optionalAliases = ["WebSearch", "WebFetch"];
  const active = session.getActiveToolNames();
  const extensions = loader.getExtensions();
  const output = {
    modelCalls: 0,
    extensionPath,
    activeWebTools: required.filter((name) => active.includes(name)),
    activeWebAliases: optionalAliases.filter((name) => active.includes(name)),
    extensionErrors: extensions.errors,
    passed: required.every((name) => active.includes(name)),
  };
  console.log(JSON.stringify(output));
  process.exitCode = output.passed ? 0 : 1;
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown" });
  session.dispose();
}
