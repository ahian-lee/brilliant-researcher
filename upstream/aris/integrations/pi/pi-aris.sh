#!/usr/bin/env bash
# Thin host adaptation: upstream skills and reviewer stay unchanged.
set -euo pipefail
ARIS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ARIS_REPO="$ARIS_ROOT"

usage() {
  cat >&2 <<'EOF'
Usage: pi-aris.sh <skill> [--skill NAME ...] [--workdir DIR] [--prepare-only] [--headless] [--record] [Pi arguments/prompt...]

The first skill and every --skill NAME must be a directory under skills/ with a
real SKILL.md. --record implies --headless, records Pi's JSON event stream in
<workdir>/pi-events.jsonl, and keeps the Pi session directory in
<workdir>/.pi/sessions. Use --continue or another native Pi resume option to
continue a saved session.
EOF
}

# Keep the historical positional skill while allowing an explicit, repeatable
# --skill form for multi-skill runs. Everything after -- is passed to Pi as-is.
SKILLS=()
WORKDIR="${ARIS_WORKDIR:-$PWD}"
PREPARE=0
HEADLESS=0
RECORD=0
PI_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --skill)
      [ $# -ge 2 ] || { echo 'Missing value for --skill' >&2; usage; exit 2; }
      SKILLS+=("$2"); shift 2;;
    --skills)
      [ $# -ge 2 ] || { echo 'Missing value for --skills' >&2; usage; exit 2; }
      IFS=',' read -r -a skill_list <<< "$2"
      [ "${#skill_list[@]}" -gt 0 ] || { echo 'Empty --skills value' >&2; usage; exit 2; }
      SKILLS+=("${skill_list[@]}"); shift 2;;
    --workdir) [ $# -ge 2 ] || exit 2; WORKDIR="$2"; shift 2;;
    --prepare-only) PREPARE=1; shift;;
    --headless) HEADLESS=1; shift;;
    --record) RECORD=1; shift;;
    --) shift; PI_ARGS+=("$@"); break;;
    *)
      # The first bare argument is the legacy positional skill. Later bare
      # arguments are Pi messages/prompts and must retain their exact bytes.
      if [ "${#SKILLS[@]}" -eq 0 ]; then SKILLS+=("$1"); else PI_ARGS+=("$1"); fi
      shift;;
  esac
done

[ "${#SKILLS[@]}" -gt 0 ] || { echo 'A skill name is required.' >&2; usage; exit 2; }
[ -d "$WORKDIR" ] || { echo "Work directory must already exist: $WORKDIR" >&2; exit 3; }
WORKDIR="$(cd "$WORKDIR" && pwd)"

# Pi accepts a missing --skill path without failing. Validate names before any
# project configuration write so a typo cannot silently start an unscoped run.
# The lexical check blocks path traversal; realpath also rejects a symlinked
# skill directory that escapes the upstream skills root.
SKILLS_ROOT="$(cd "$ARIS_ROOT/skills" && pwd -P)"
validate_skill() {
  local name="$1"
  local skill_file expected real_skill
  case "$name" in
    ''|.|..|*/*|*\\*|*[!A-Za-z0-9._-]*)
      echo "Invalid skill name (use a skills/<name> directory): $name" >&2
      return 1
      ;;
  esac
  skill_file="$SKILLS_ROOT/$name/SKILL.md"
  if [ ! -f "$skill_file" ]; then
    echo "Unknown skill or missing SKILL.md: $name" >&2
    return 1
  fi
  expected="$SKILLS_ROOT/$name/SKILL.md"
  real_skill="$(realpath -e -- "$skill_file" 2>/dev/null || true)"
  case "$real_skill" in
    "$expected") ;;
    *)
      echo "Skill path escapes upstream skills root: $name" >&2
      return 1
      ;;
  esac
}

declare -A seen_skills=()
unique_skills=()
for skill in "${SKILLS[@]}"; do
  validate_skill "$skill" || exit 2
  if [ -z "${seen_skills[$skill]+x}" ]; then
    seen_skills["$skill"]=1
    unique_skills+=("$skill")
  fi
done
SKILLS=("${unique_skills[@]}")
WORKFLOW="${SKILLS[0]}"

if ! command -v pi >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"
fi
for d in "$HOME"/apps/node-v*/bin "$HOME"/.local/bin; do
  [ ! -d "$d" ] || PATH="$d:$PATH"
done
export PATH
. "$ARIS_ROOT/integrations/pi/runtime-env.sh"
command -v pi >/dev/null || { echo 'Pi not found; install/configure Pi in this environment first.' >&2; exit 4; }
REVIEWER_EXAMPLE="${ARIS_REVIEWER_EXAMPLE:-$ARIS_ROOT/integrations/pi/mcp.json.example}"
# Merge instead of discarding unrelated project MCP servers. No global configuration writes.
python3 - "$REVIEWER_EXAMPLE" "$ARIS_ROOT" "$WORKDIR" "${CODEX_BIN:-$(command -v codex || true)}" <<'PY'
import json,sys,pathlib
example,aris,root,codex=sys.argv[1:]
p=pathlib.Path(root)/'.pi/mcp.json';p.parent.mkdir(parents=True,exist_ok=True)
new=json.loads(pathlib.Path(example).read_text().replace('ARIS_ROOT',aris))
old=json.loads(p.read_text()) if p.exists() else {}
if 'codex' in new['mcpServers']:
 import os,shutil
 resolved=shutil.which(codex) if codex else None
 if not resolved or not os.access(resolved,os.X_OK):
  raise SystemExit('Codex reviewer executable is missing. Configure CODEX_BIN or install/login Codex; no model has been started.')
 codex=resolved
for name,server in new['mcpServers'].items():
 if name=='codex':
  server['requestTimeoutMs']=600000
  if codex: server.setdefault('env',{})['CODEX_BIN']=codex
 old.setdefault('mcpServers',{})[name]=server
# Extension v1.5 applies only the global timeout when actually calling tools.
old.setdefault('settings',{})['requestTimeoutMs']=600000
p.write_text(json.dumps(old,ensure_ascii=False,indent=2)+'\n')
PY
if [ "$PREPARE" = 1 ]; then echo "Prepared project MCP configuration in $WORKDIR/.pi/mcp.json"; exit; fi
# Reuse the official Web extension. Users install it once with setup-runtime.sh
# --web; a scoped run never installs packages or invokes a search summarizer.
WEB_EXTENSION="${ARIS_WEB_EXTENSION:-$ARIS_LOCAL_RUNTIME/web/node_modules/pi-web-access/index.ts}"
web_provided=0
for arg in "${PI_ARGS[@]}"; do
  [ "$arg" != "$WEB_EXTENSION" ] || web_provided=1
  case "$arg" in */pi-web-access/index.ts) web_provided=1;; esac
done
if [ "$web_provided" = 0 ] && [ -f "$WEB_EXTENSION" ]; then
  PI_ARGS=(--extension "$WEB_EXTENSION" "${PI_ARGS[@]}")
  if [[ "$WEB_EXTENSION" == */pi-web-access/index.ts ]]; then
    export XDG_CONFIG_HOME="$ARIS_LOCAL_RUNTIME/web/xdg"
    mkdir -p "$XDG_CONFIG_HOME/pi"
    [ -e "$XDG_CONFIG_HOME/pi/web-search.json" ] || cp "$ARIS_ROOT/integrations/pi/web-search.example.json" "$XDG_CONFIG_HOME/pi/web-search.json"
  fi
elif [ "$web_provided" = 0 ]; then
  case "$WORKFLOW" in research-pipeline|idea-discovery|research-lit|idea-creator|novelty-check)
    echo 'Web extension missing. Run integrations/pi/setup-runtime.sh --web, or set ARIS_WEB_EXTENSION to an installed extension. No model started.' >&2
    exit 4;;
  esac
fi
# Only transport names/helper paths differ. Do not rewrite upstream skill instructions.
skill_summary="${SKILLS[*]}"
ADAPTER="Pi is the ARIS execution host, replacing Claude Code. Work only within the user's authorized scope, resources and budget. Read and execute the selected upstream skill(s) at $ARIS_ROOT/skills/<name>/SKILL.md: $skill_summary. Their MCP tool mcp__codex__codex is Pi's mcp_codex_codex; mcp__codex__codex-reply is mcp_codex_codex_reply. Read/Write/Edit/Bash map to read/write/edit/bash. Execute a nested Skill or /skill-name by reading its canonical SKILL.md at $ARIS_ROOT/skills/skill-name/SKILL.md and following it; do not send Claude slash commands to a shell. Grep/Glob use normal bash file search. WebSearch/WebFetch map to web_search/fetch_content when a web extension is loaded. Preserve reviewer threadId and upstream independence/trace/acceptance rules. Upstream tools/templates/skills are at $ARIS_ROOT; resolve helper references there and write research artifacts and .aris state in the current project directory. Mark the native stage running on entry, done only with artifacts, accepted only under its original gate. Do not request BRI Controller or double-write BRI decisions. This is not permission for unrelated subagents or extra research. A missing reviewer/error is REVIEW_UNAVAILABLE, never acceptance: save the error and stop; do not repair host installations, user configuration, credentials or executables outside the project."
echo "ARIS workflow=$WORKFLOW; project=$WORKDIR; reviewer configuration=$REVIEWER_EXAMPLE" >&2
cd "$WORKDIR"

# Explicit headless mode is opt-in. Record mode is headless JSON mode plus a
# project-local session directory, so --continue and --resume remain native Pi
# operations and do not touch the user's global Pi configuration.
if [ "$HEADLESS" = 1 ] || [ "$RECORD" = 1 ]; then
  normalized_args=()
  option_end=0
  skip_mode_value=0
  for arg in "${PI_ARGS[@]}"; do
    if [ "$skip_mode_value" = 1 ]; then
      skip_mode_value=0
      continue
    fi
    if [ "$option_end" = 0 ] && [ "$arg" = "--mode" ]; then
      skip_mode_value=1
      continue
    fi
    if [ "$option_end" = 0 ] && { [ "$arg" = "--print" ] || [ "$arg" = "-p" ]; }; then
      continue
    fi
    normalized_args+=("$arg")
    [ "$arg" = "--" ] && option_end=1
  done
  PI_ARGS=(--mode json --print "${normalized_args[@]}")
fi
if [ "$RECORD" = 1 ]; then
  has_session_dir=0
  option_end=0
  for arg in "${PI_ARGS[@]}"; do
    if [ "$option_end" = 0 ] && [ "$arg" = "--session-dir" ]; then has_session_dir=1; break; fi
    [ "$arg" = "--" ] && option_end=1
  done
  if [ "$has_session_dir" = 0 ]; then
    session_args=()
    option_end=0
    session_inserted=0
    for arg in "${PI_ARGS[@]}"; do
      if [ "$option_end" = 0 ] && [ "$arg" = "--" ] && [ "$session_inserted" = 0 ]; then
        session_args+=(--session-dir "$WORKDIR/.pi/sessions")
        session_inserted=1
      fi
      session_args+=("$arg")
      [ "$arg" = "--" ] && option_end=1
    done
    [ "$session_inserted" = 1 ] || session_args+=(--session-dir "$WORKDIR/.pi/sessions")
    PI_ARGS=("${session_args[@]}")
  fi
fi

PI_CMD=(pi)
for skill in "${SKILLS[@]}"; do
  # Pass each validated canonical directory directly. Passing the aggregate
  # skills root would also discover legacy duplicate copies below skills-codex.
  PI_CMD+=(--skill "$SKILLS_ROOT/$skill")
done
PI_CMD+=(--append-system-prompt "$ADAPTER" --approve "${PI_ARGS[@]}")
if [ "$RECORD" != 1 ]; then
  exec "${PI_CMD[@]}"
fi

# Tee both streams without putting diagnostics into the JSONL event stream and
# keep Pi's exact exit status. Named pipes keep stdout live for callers that
# consume the JSON protocol incrementally.
EVENT_LOG="$WORKDIR/pi-events.jsonl"
STDERR_LOG="$WORKDIR/pi.stderr.log"
STREAM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-aris.XXXXXX")"
OUT_FIFO="$STREAM_DIR/stdout"
ERR_FIFO="$STREAM_DIR/stderr"
mkfifo "$OUT_FIFO" "$ERR_FIFO"
tee -a "$EVENT_LOG" < "$OUT_FIFO" &
OUT_TEE_PID=$!
tee -a "$STDERR_LOG" >&2 < "$ERR_FIFO" &
ERR_TEE_PID=$!
set +e
"${PI_CMD[@]}" > "$OUT_FIFO" 2> "$ERR_FIFO"
PI_STATUS=$?
wait "$OUT_TEE_PID"
wait "$ERR_TEE_PID"
set -e
rm -f -- "$OUT_FIFO" "$ERR_FIFO"
rmdir -- "$STREAM_DIR"
exit "$PI_STATUS"
