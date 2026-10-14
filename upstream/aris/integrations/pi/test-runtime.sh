#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
CHECK="$SCRIPT_DIR/runtime-check.py"
PY="$ROOT/.aris/runtime/python/bin/python"
[ -x "$PY" ] || { echo "missing prepared project Python: $PY" >&2; exit 2; }

CHECK_JSON="$(mktemp)"
SMOKE_JSON="$(mktemp)"
trap 'rm -f -- "$CHECK_JSON" "$SMOKE_JSON"' EXIT

python3 "$CHECK" --root "$ROOT" --json >"$CHECK_JSON"
"$PY" - "$CHECK_JSON" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
assert report["python"]["executable"].startswith(str(Path(report["root"]) / ".aris/runtime/python")), report
assert all(info["present"] for info in report["imports"].values()), report["imports"]
print("runtime dependency check passed")
PY

python3 "$CHECK" --root "$ROOT" --paper --smoke --json >"$SMOKE_JSON"
"$PY" - "$SMOKE_JSON" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
smoke = report["smoke"]
assert smoke and smoke["passed"] is True, report
assert smoke["pages"] >= 1, smoke
for filename in ("data.csv", "figure.png", "paper.tex", "refs.bib", "paper.pdf", "page-1.png", "smoke.log"):
    assert (Path(smoke["directory"]) / filename).is_file(), filename
assert smoke["external_pdf_tools"]["pdfinfo"]["pages"] == smoke["pages"], smoke
assert smoke["external_pdf_tools"]["pdftotext"]["contains_title"] is True, smoke
print("runtime paper smoke passed:", smoke["directory"])
PY

echo "runtime checks passed"

