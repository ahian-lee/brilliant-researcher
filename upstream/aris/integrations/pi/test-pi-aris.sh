#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$HERE/pi-aris.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-aris-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

WORKDIR="$TEST_ROOT/project with 空格"
mkdir -p "$WORKDIR/.pi"
mkdir -p "$TEST_ROOT/home"
cp "$HERE/mcp.json.example" "$TEST_ROOT/example.json"
printf '%s\n' '{"mcpServers":{"unrelated":{"transport":"stdio","command":"keep"}}}' > "$WORKDIR/.pi/mcp.json"

export PATH="$HERE/test-fixtures:$PATH"
export HOME="$TEST_ROOT/home"
export FAKE_PI_ARGS_LOG="$TEST_ROOT/pi.args"
export ARIS_REVIEWER_EXAMPLE="$TEST_ROOT/example.json"
export PI_CODING_AGENT_DIR="$TEST_ROOT/global-pi"

# A valid multi-skill prepare must write only project MCP state and must not
# invoke Pi (the fake's argument log remains absent).
bash "$LAUNCHER" research-pipeline --skill experiment-bridge \
  --workdir "$WORKDIR" --prepare-only --model ignored -- "提示 含 空格 中文"
[ ! -e "$FAKE_PI_ARGS_LOG" ]
python3 - "$WORKDIR/.pi/mcp.json" "$TEST_ROOT/global-pi" <<'PY'
import json
import pathlib
import sys

project = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert project["mcpServers"]["unrelated"]["command"] == "keep"
assert project["mcpServers"]["codex"]["requestTimeoutMs"] == 600000
assert project["settings"]["requestTimeoutMs"] == 600000
assert not pathlib.Path(sys.argv[2]).exists(), "global Pi configuration was changed"
PY

# Record mode forces Pi's JSON/print protocol, uses project-local sessions,
# tees complete stdout/stderr, appends on a second run, and returns Pi's code.
set +e
FAKE_PI_EXIT=7 bash "$LAUNCHER" research-pipeline --skill experiment-bridge \
  --record --workdir "$WORKDIR" --continue -- "提示 含 空格 中文" \
  > "$TEST_ROOT/stdout" 2> "$TEST_ROOT/stderr"
status=$?
set -e
[ "$status" -eq 7 ]
grep -Fq '中文 prompt' "$TEST_ROOT/stdout"
grep -Fq 'fake stderr' "$TEST_ROOT/stderr"
grep -Fq '中文 prompt' "$WORKDIR/pi-events.jsonl"
grep -Fq 'fake stderr' "$WORKDIR/pi.stderr.log"
grep -Fqx -- '--mode' "$FAKE_PI_ARGS_LOG"
grep -Fqx -- 'json' "$FAKE_PI_ARGS_LOG"
grep -Fqx -- '--print' "$FAKE_PI_ARGS_LOG"
grep -Fqx -- '--session-dir' "$FAKE_PI_ARGS_LOG"
grep -Fqx -- "$WORKDIR/.pi/sessions" "$FAKE_PI_ARGS_LOG"
grep -Fqx -- '提示 含 空格 中文' "$FAKE_PI_ARGS_LOG"

FAKE_PI_EXIT=0 bash "$LAUNCHER" research-pipeline --record \
  --workdir "$WORKDIR" -- '第二次'
[ "$(wc -l < "$WORKDIR/pi-events.jsonl")" -eq 2 ]

# Headless mode is explicit but does not create a record file by itself.
rm -f -- "$FAKE_PI_ARGS_LOG"
bash "$LAUNCHER" experiment-plan --headless --workdir "$WORKDIR" -- 'headless'
[ "$(wc -l < "$WORKDIR/pi-events.jsonl")" -eq 2 ]

# Path traversal and unknown names fail before Pi is invoked.
set +e
bash "$LAUNCHER" ../research-pipeline --workdir "$WORKDIR" --prepare-only >/dev/null 2> "$TEST_ROOT/invalid.err"
invalid=$?
bash "$LAUNCHER" does-not-exist --workdir "$WORKDIR" --prepare-only >/dev/null 2> "$TEST_ROOT/missing.err"
missing=$?
set -e
[ "$invalid" -ne 0 ]
[ "$missing" -ne 0 ]

printf '%s\n' 'pi-aris launcher tests passed'
