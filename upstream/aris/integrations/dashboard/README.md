# Optional read-only ARIS Dashboard

The Dashboard is a file observer for registered ARIS project directories. Pi
and ARIS own execution, native state, reports, reviews and acceptance. The
Dashboard performs no model calls, SSH dispatch, scheduling, SQLite writes or
research state transitions. Stopping it does not stop Pi.

## Fresh checkout on another machine

The prepared observer is self-contained; it does not require the parent BRI
repository or its Controller. From the ARIS checkout, use Node >=23.6 (Node 24
was tested), prepare an empty registry once, and start the observer:

    mkdir -p .aris
    test -e .aris/projects.json || printf '{"projects":[]}\n' > .aris/projects.json
    node integrations/dashboard/server.mjs .aris/projects.json 8791

In another terminal, use `integrations/pi/research.sh` with its default registry
or explicitly pass `--projects .aris/projects.json`. New projects appear without
restarting the observer. Pi, the independent reviewer and model authentication
must be prepared separately; see `../pi/README.md`.

The Windows host commands below are conveniences provided by the parent BRI
checkout on the current machine, rather than prerequisites for this standalone
observer.

## Windows start

The prepared Windows host is the normal entrypoint:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\brilliant-researcher\runner\dashboard-readonly.ps1 -Action start -Projects C:\path\to\brilliant-researcher\var\aris-projects.local.json

When the default registry path is used, omit the Projects argument:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\brilliant-researcher\runner\dashboard-readonly.ps1 -Action start

Open http://127.0.0.1:8791/. Check ownership and data availability with:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\brilliant-researcher\runner\dashboard-readonly.ps1 -Action status

Stop the read-only task with:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\brilliant-researcher\runner\dashboard-readonly.ps1 -Action stop

An intentional stop disables the scheduled recovery task; a later start enables
it again. The task uses the current Windows user with Limited privileges and
does not create a research queue or model process.

The registry file is checked on API requests. If its contents change, the
observer reloads it without a service restart, so a new project can be
registered while the Dashboard remains open. The registry file is a read
boundary: each root must be readable, and paths or symlinks escaping the root
are rejected.

## Registration

The Pi unified entrypoint writes the same registry automatically:

    bash integrations/pi/research.sh --project /path/to/brilliant-researcher/aris-projects/my-project --model YOUR_PROVIDER/YOUR_MODEL --projects /path/to/brilliant-researcher/var/aris-projects.local.json --id my-project --name "My ARIS project" --goal "The agreed goal" --prepare-only

A registry can also contain an object with a projects array, or a bare array:

    {
      "projects": [
        {
          "id": "my-research",
          "name": "My research",
          "root": "../aris-projects/my-project",
          "goal": "The agreed research question and completion condition",
          "supervisor": "Pi / ARIS + independent reviewer"
        }
      ]
    }

Relative roots are resolved relative to the registry file. Keep research
directories under /mnt/d/... so WSL and Windows resolve the same files. The
registration helper preserves unrelated top-level fields and refuses to reuse
an id for a different directory.

## What it displays

For each registered root, the observer reads ARIS-native files and shows:

- project overview and native phase status;
- run summaries, phase details, artifacts, reports and reviewer files;
- project journal events and the recorded Pi stream in pi-events.jsonl;
- available host/resource samples when an existing BRI cache is explicitly
  configured.

Research record mode keeps Pi stdout in pi-events.jsonl, stderr in
pi.stderr.log and native sessions in .pi/sessions. The Dashboard does not
invent an event when a file is missing. A native done or provisional state
remains waiting for its original acceptance gate; it is not rendered as
accepted. Unknown, unreadable and out-of-bound files remain visibly
unavailable.

The optional resource view is a read-only SQLite connection selected with
BRI_RESOURCE_DB. It exposes cached samples with timestamps and never starts a
sampler, so old telemetry is not current host availability. Existing BRI
history remains a separate maintenance surface.

## Standalone observer

When the Windows host is not used, the prepared observer can run directly with
Node >=23.6:

    node integrations/dashboard/server.mjs /absolute/path/to/projects.json 8791

The server accepts GET and HEAD only and binds to 127.0.0.1. No npm install is
needed for the prepared observer. It is safe to close after saving the browser
address; research continues in Pi.

## Boundaries and distribution

This Dashboard is intentionally read-only. It cannot create, steer, cancel or
resume a Pi run, and it does not replace the user or ARIS reviewer acceptance
gate. Paper smoke artifacts, web-extension setup and SSH experiment semantics
are documented in docs/aris-pi-usage.md; a successful Dashboard start does not
claim that paper-writing, all canonical skills, all models or a complete
ARIS+Pi+SSH chain has passed.

Do not distribute personal registry files, var logs, credentials, databases or
Pi global configuration with the observer. Keep only the prepared Dashboard
assets, the adapter and the upstream license/attribution files.

