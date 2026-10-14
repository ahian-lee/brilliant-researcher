#!/usr/bin/env bash
# Convenience only: the upstream skill owns execution, decisions and run state.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
PROJECT=""; MODEL=""; BRIEF=""; ID=""; NAME=""; GOAL=""
PROJECTS="${ARIS_PROJECTS:-$ROOT/.aris/projects.json}"
WORKFLOW=research-pipeline; PREPARE=0; RESUME=0; SECONDS_LIMIT=0; EXTRA=()
usage() {
  echo 'Usage: research.sh --project DIR --model PROVIDER/MODEL [--brief FILE] [--projects FILE] [--id ID] [--name NAME] [--goal TEXT] [--workflow SKILL] [--timeout-seconds N] [--prepare-only] [--continue] [-- Pi options]'
  echo 'Fill RESEARCH_BRIEF.md with your goal, resources, completion conditions and budget first. Default workflow: research-pipeline.'
}
while [ $# -gt 0 ]; do
  case "$1" in
    --project|--model|--brief|--projects|--id|--name|--goal|--workflow|--timeout-seconds)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --project) PROJECT="$2";; --model) MODEL="$2";; --brief) BRIEF="$2";;
        --projects) PROJECTS="$2";; --id) ID="$2";; --name) NAME="$2";;
        --goal) GOAL="$2";; --workflow) WORKFLOW="$2";; --timeout-seconds) SECONDS_LIMIT="$2";;
      esac
      shift 2;;
    --prepare-only) PREPARE=1; shift;;
    --continue) RESUME=1; shift;;
    --help|-h) usage; exit;;
    --) shift; EXTRA=("$@"); break;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$MODEL" ] || { usage >&2; exit 2; }
[[ "$WORKFLOW" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -f "$ROOT/skills/$WORKFLOW/SKILL.md" ] || { echo "Unknown workflow: $WORKFLOW" >&2; exit 2; }
[[ "$SECONDS_LIMIT" =~ ^[0-9]+$ ]] || { echo 'timeout-seconds must be a nonnegative integer' >&2; exit 2; }
mkdir -p "$PROJECT"
PROJECT="$(cd "$PROJECT" && pwd)"
if [ -n "$BRIEF" ]; then
  BRIEF="$(realpath "$BRIEF")"
  if [ "$BRIEF" != "$PROJECT/RESEARCH_BRIEF.md" ]; then
    [ ! -e "$PROJECT/RESEARCH_BRIEF.md" ] || { echo 'Existing RESEARCH_BRIEF.md retained; edit it or omit --brief.' >&2; exit 2; }
    cp "$BRIEF" "$PROJECT/RESEARCH_BRIEF.md"
  fi
fi
[ -s "$PROJECT/RESEARCH_BRIEF.md" ] || { echo 'Create RESEARCH_BRIEF.md from templates/RESEARCH_BRIEF_TEMPLATE.md and specify resources and budget.' >&2; exit 2; }
ID="${ID:-$(basename "$PROJECT")}"; NAME="${NAME:-$ID}"
python3 "$DIR/register-project.py" --config "$PROJECTS" --root "$PROJECT" --id "$ID" --name "$NAME" --goal "$GOAL"
echo "Dashboard project registry: $PROJECTS" >&2
if [ "$PREPARE" = 1 ]; then
  exec bash "$DIR/check-mcp-tools.sh" "$PROJECT"
fi
# Optional local environment, installed separately; never download on research startup.
if [ -d "$ROOT/.aris/runtime/python/bin" ]; then PATH="$ROOT/.aris/runtime/python/bin:$PATH"; fi
if [ -d "$ROOT/.aris/runtime/bin" ]; then PATH="$ROOT/.aris/runtime/bin:$PATH"; fi
export PATH
ARGS=("$WORKFLOW" --workdir "$PROJECT" --record --model "$MODEL")
if [ "$RESUME" = 1 ]; then ARGS+=(--continue); fi
ARGS+=("${EXTRA[@]}" 'Read RESEARCH_BRIEF.md. Execute the selected upstream ARIS workflow continuously within its scope and budget. Use native .aris state, independent reviewer evidence and original acceptance rules. AUTO_PROCEED=true; resume existing work when continuing, never duplicate an unconfirmed experiment. Save the final result or explicit unresolved reason in REPORT.md. Do not end at an informational checkpoint.')
if [ "$SECONDS_LIMIT" -gt 0 ]; then
  echo "Pi process wall-clock limit: $SECONDS_LIMIT seconds. Remote experiments require their own brief limits." >&2
  exec timeout --signal=TERM --kill-after=30 "$SECONDS_LIMIT" bash "$DIR/pi-aris.sh" "${ARGS[@]}"
fi
exec bash "$DIR/pi-aris.sh" "${ARGS[@]}"
