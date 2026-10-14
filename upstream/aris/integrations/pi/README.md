# Pi + ARIS

This directory is a thin host adapter for upstream ARIS. Pi executes the
selected upstream skill inside the user-authorized scope; the user or external
supervisor owns the goal, resources, budget, completion condition and major
trade-offs. An optional Dashboard observes the project files and never schedules
research.

Upstream skills, helpers and Codex execution servers are unchanged. This
adapter handles canonical skill discovery, project MCP merging, Pi transport
names, web-extension loading, JSONL recording and native Pi session recovery.
It does not add a Controller or a second research state machine.

## Requirements

- Linux or WSL with Pi and an explicitly configured model. The prepared
  environment was checked with Pi 0.85.1 and Node 22.22.1.
- An independently logged-in Codex CLI for the default reviewer. Set
  CODEX_BIN to its absolute path if it is not on PATH.
- Pi's MCP extension and a working bwrap/user-namespace sandbox. Discovery
  checks do not prove model access or sandbox execution.
- A project directory on a path readable by both WSL and the Windows
  Dashboard. Use /mnt/d/... for the shared workspace.
- The optional Dashboard uses the prepared Windows Node environment and listens
  on 127.0.0.1:8791.

## Project-local optional runtime

For a fresh checkout, install Pi's MCP client once in the environment where
Pi runs, if it is not already present:

    pi install npm:pi-mcp-extension

Pi and the reviewer must already have working model authentication. This
repository does not distribute anyone's model credentials. Follow the
upstream `mcp-servers/codex-exec/README.md` for reviewer prerequisites.

From the ARIS checkout:

    bash integrations/pi/setup-runtime.sh --web

For plotting and paper compilation:

    bash integrations/pi/setup-runtime.sh --paper

Or prepare both:

    bash integrations/pi/setup-runtime.sh --all

These commands are explicit setup actions. A normal research start never
installs packages or edits global Pi configuration. Python packages, project
latexmk and the optional private Poppler files live below .aris/runtime.
Paper setup still requires host pdflatex and bibtex; it never installs
texlive-full.

The current prepared web extension is the official pi-web-access 0.34.0.
The project config selects zero-config Exa MCP search, uses workflow none, and
does not make an extra summary-model call. Pi still uses its selected execution
model for the research workflow itself. Set ARIS_WEB_EXTENSION only when
deliberately selecting another installed extension.

Setup uses that tested package version by default; ARIS_WEB_VERSION explicitly
selects a different version. ARIS_RUNTIME_DIR changes the private runtime
location consistently for setup, the launcher and diagnostics.

A no-model smoke check covers the optional runtime:

    python3 integrations/pi/runtime-check.py --paper --smoke --json

It creates private var/runtime-smoke-* evidence for CSV, a matplotlib figure,
LaTeX plus BibTeX, PDF page/text extraction and first-page rendering. This is a
runtime check, not evidence that paper-writing or a user paper has passed.

## Unified research entrypoint

Create and fill a project brief first:

    cd /path/to/brilliant-researcher/upstream/aris
    PROJECT=/path/to/brilliant-researcher/aris-projects/my-project
    mkdir -p "$PROJECT"
    cp templates/RESEARCH_BRIEF_TEMPLATE.md "$PROJECT/RESEARCH_BRIEF.md"

Run a no-model preparation check and register the project:

    CONFIG=/path/to/brilliant-researcher/var/aris-projects.local.json
    bash integrations/pi/research.sh \
      --project "$PROJECT" \
      --model "YOUR_PROVIDER/YOUR_MODEL" \
      --brief "$PROJECT/RESEARCH_BRIEF.md" \
      --projects "$CONFIG" \
      --id my-project \
      --name "My ARIS project" \
      --goal "The agreed research question and completion condition" \
      --workflow research-pipeline \
      --prepare-only

The preparation path merges the project MCP file and checks actual Pi
discovery. It does not start a model turn. The current checker covers all 83
canonical skill directories and their tool set; that is loading evidence, not a
claim that every skill or model workflow has been run.

Start after the check passes by removing --prepare-only:

    bash integrations/pi/research.sh \
      --project "$PROJECT" \
      --model "YOUR_PROVIDER/YOUR_MODEL" \
      --brief "$PROJECT/RESEARCH_BRIEF.md" \
      --projects "$CONFIG" \
      --id my-project \
      --name "My ARIS project" \
      --goal "The agreed research question and completion condition" \
      --workflow research-pipeline \
      --timeout-seconds 3600

The actual research.sh options are --project, --model, --brief, --projects,
--id, --name, --goal, --workflow, --timeout-seconds, --prepare-only and
--continue. Arguments after -- are passed to Pi. The default workflow is
research-pipeline; select a real upstream skill such as experiment-bridge or
auto-review-loop when the project scope calls for it.

The entrypoint always uses Pi record mode:

- JSON/print stdout is appended to project pi-events.jsonl.
- stderr is appended separately to project pi.stderr.log.
- Pi's native session directory is project .pi/sessions.
- ARIS runs, review state, traces and reports remain native project artifacts.
- The Pi exit code is returned to the caller.

The log and native state are evidence. They do not grant new authorization.

## Resume

Inspect native ARIS state, the last reviewer evidence and any still-running
experiment before resuming the same project:

    bash integrations/pi/research.sh \
      --project "$PROJECT" \
      --model "YOUR_PROVIDER/YOUR_MODEL" \
      --brief "$PROJECT/RESEARCH_BRIEF.md" \
      --projects "$CONFIG" \
      --id my-project \
      --workflow research-pipeline \
      --continue

Resume uses the same Pi session directory and ARIS state. It does not reset
the authorized budget or review limit. A timeout or an unobservable SSH job is
not evidence that an experiment failed; check the original log and artifacts
before retrying. The word done is executor completion, not accepted; a missing
reviewer is REVIEW_UNAVAILABLE.

## Dashboard

See integrations/dashboard/README.md. The Windows read-only host can be
started with:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\brilliant-researcher\runner\dashboard-readonly.ps1 -Action start -Projects C:\path\to\brilliant-researcher\var\aris-projects.local.json

Open http://127.0.0.1:8791/. The registry is re-read when API requests observe
a file change, so registering a new project does not require a Dashboard
restart. The observer performs GET/HEAD reads only and cannot steer, cancel,
resume or create a Pi run. Historical BRI resource data, when configured, is a
timestamped cache rather than live availability.

## SSH boundary

SSH is optional and belongs in an explicitly authorized experiment-bridge
scope. A Windows OpenSSH read-only probe to the example-host alias, one bounded
deterministic CPU fixture, and scp retrieval were tested. That validates the
SSH/scp primitive boundary only; it is not acceptance of a complete Pi + ARIS
SSH research chain or remote GPU study. A timeout means the remote state is
unobservable, not proof of remote death.

## Limits

Do not start a legacy BRI Controller for a new ARIS project or run two
schedulers against the same directory. Keep personal var files, credentials,
databases, Pi global settings and runtime caches out of a distribution. This
adapter has not claimed every canonical skill, every model, paper-writing
end-to-end or the complete ARIS+Pi+SSH workflow has passed.

