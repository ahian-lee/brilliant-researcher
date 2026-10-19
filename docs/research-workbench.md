# Project collaboration workbench

[中文](research-workbench_CN.md) · [Home](../README.md) · [Architecture](architecture.md)

Follow the [installation instructions](../README.md): use `npm run connect` for agent settings, `npm run doctor` for no-model diagnostics and `npm start -- --with-runtime` to launch both services. Then open the [local workbench](http://127.0.0.1:8791/). Select a project to use its overview, workflows and skills, figures, and project conversation together. The default execution backend uses native DSH and Codex interfaces. Install and configure those agents separately and keep the native runtime running; Paseo is not required.

For an npm-installed agent on Windows, select `node.exe` and its CLI JavaScript entry; a `.cmd` or `.bat` wrapper cannot be launched as a native executable. This applies to both DSH and Codex. The doctor checks port and configuration ownership without calling models; it does not test provider authentication or inference.

Use **EN / 中文** in the top bar to switch between English and Chinese interface text. The default is English, and the browser remembers your selection. The same selector is available in the new-project dialog, including while a draft is being edited. Project goals, conversations, agent output, artifacts, and upstream skill text retain their original language; switching languages preserves the draft and sends no agent command.

## Set the goal and scope

When creating a project, specify the intended result, allowed directories and resources, and constraints on cost, network use, or operations outside the project. The default mode executes within that scope without asking about every ordinary file operation, test, or repair. Decisions about scope, cost, resources, or direction remain with you. A mode that reviews individual permissions is also available.

Start with free collaboration, a single ARIS task, or a full research workflow. Automatic execution and Codex review are available in all three modes. A single task uses the selected skill; the full research workflow requires an explicit selection. In managed collaboration, ARIS supplies the selected research instructions while BRI owns execution, review and repair, replacing nested reviewer launches and internal repair loops. Selecting a skill does not implicitly select the whole pipeline. If you disable automatic collaboration, the task runs directly with the selected instructions and no automatic independent acceptance. This workbench option is separate from the historical Direct integration. Models and reasoning options come from the execution backend. Configuration and observed runtime settings are shown separately: a model appearing in the catalog does not establish that it has been tested successfully.

## Set a budget

Optional limits are available during creation and in the overview's project-budget section:

| Setting | Meaning |
| --- | --- |
| Duration | Minutes per collaboration round; default 6 hours |
| Repairs | Maximum repair cycles after review; default 3 |
| Tokens / USD | Optional cumulative limits for the round, including registered child tasks |
| Concurrent agents | Maximum active agents in the project; includes parent sessions and children |
| Child sessions | Maximum children created across the round, not a fresh quota for each action |

Blank fields clear an explicit setting. Zero tokens or USD disallows subsequent corresponding model consumption; zero child sessions disables delegation, and zero repairs disables repair cycles. Duration must be positive and concurrency at least one. Unedited values remain unchanged. Saving authorizes future work under the new settings; it does not expand the caps already approved for the active round or automatically wake an exhausted round. The overview shows current-round caps separately from saved project defaults. A new iteration receives a new budget and retains the previous round's usage and artifacts.

Run usage comes from native session deltas, with parent and child contributions handled by the backend. Session cards show their own reported usage; do not add these cards to the run total. Missing tokens or cost means **not reported**, not zero; partial reports remain partial. If a configured limit cannot be checked because metering is missing, the system stops new managed actions and shows the reason. Checks occur at dispatch and observation boundaries: provider latency and a model turn already in flight can exceed a reported threshold, so a BRI budget is not a provider-side prepaid spending cap. Direct sends also receive a budget scope; they do not gain automatic review or repair by doing so.

Since v0.2.1, a reused DSH session can retain unknown lifetime tokens while still providing an exact token delta for a new round. This requires the historical unmetered event identities to remain unchanged and reported token totals to stay nondecreasing. A new missing event, changed coverage or a regression makes the round's token coverage unreliable and persistently blocks further native dispatch under its token cap; later reports do not silently clear that block. Historical missing usage is never counted as zero or rewritten as complete. USD remains unknown unless its own reports establish the cost delta.

## Execute, review, and change direction

Automatic collaboration follows DSH execution → independent Codex review → repair according to the findings. A delivery or message acknowledgement only confirms receipt. Check the independent review to determine whether the artifacts passed. The backend can continue after the browser is closed, provided its processes remain running.

DSH names an execution tool, so it does not establish the model family. When an ARIS phase records only `dsh` or `dsh-pi`, acceptance uses the model actually reported by the native session and retains the original agent label. A missing observation cannot be replaced by the configured model; unknown families remain unclassified, and same-family review remains provisional. A different recorded model cannot be overwritten through this resolution.

The project conversation on the right is the shared entry point for activity, new requirements, and pending items. Direction changes sent to a bound execution or review session are synchronized to both sides. The backend stops the old round and continues after the agents confirm the new requirements; results from the old direction do not count for the revised task. Enter sends a message; Shift+Enter inserts a newline. Confirming a selection with a Chinese input method does not send the message.

Registered child tasks use native sessions and show their parent, task, status and available usage. BRI limits creation and concurrency, and observes children before handing artifacts to the reviewer. Pausing or changing direction revokes the old action's delegation authority and requests child interruption; if stopping cannot be confirmed, new work waits and the state remains visible. An acknowledgement is not confirmation that all children have stopped.

When a decision is needed, the blocked-work and pending-decision sections show the reason and a route to the relevant item. Automatic permission review is shown as system activity, not counted as a request for your decision. Budget exhaustion, an executor's explicit blocked result, a transport error and automatic review have distinct states; an empty human queue does not imply the run is healthy. Questions, choices, requested operations, and answer methods appear together in the pending-items tab. Use the corresponding question's submit button to answer; submitted responses remain visible. Add general project requirements in the ordinary conversation without forwarding review feedback or opening another approval window.

Recovery is finite. A confirmed idle session without a usable result can be asked to diagnose and continue at most twice; a malformed final reply has a separate allowance of at most two format-only restatements, without redoing implementation. Uncertain sends are observed instead of blindly replayed. A genuine blocked result stops with its reason and preserves the current work. Persistent failures become visible attention states rather than an unlimited retry loop.

Delayed native history reads preserve newer controller scope, revocations and budget state, even before a first snapshot exists. If a managed send fails before native submission, it reports an explicit rejection with its reason. If submission may already have occurred and its acknowledgement is lost, the result remains unknown and the request is not resent.

Before sending a new managed task prompt, BRI can compact an idle DSH session when its latest assistant call reports more than 200,000 `totalTokens` and no later native summary covers that call. This uses DSH's native `compact` command and retains the session identity and journal. Set `dsh.contextCompactionThresholdTokens` in `var/native-runtime.local.json` to a positive token threshold if needed. Compaction calls the configured model and may incur charges; summary usage joins the usage ledger, and a failed compaction without a summary remains unmetered. BRI rechecks scope and budget after maintenance and before the task prompt. The implementation is covered by software checks; effectiveness on a real long session remains to be verified.

Model and reasoning settings can be changed once the sessions are idle. Pause collaboration first if execution, audit planning, or review is in progress.

## Continue iterating or redo work

The overview's continue/redo action and a workflow stage's redo-from-here action open the existing project conversation with Codex audit and planning enabled by default. Send the prefilled iteration request or add the changes you want; you do not need to write the complete plan yourself.

Continuing after a pause, fault or exhausted budget starts a new round with the same executor and reviewer conversations. The previous round keeps its timestamps, usage and receipts; the new round uses the project's saved budget and starts its own elapsed time. A send whose outcome is still unknown must be reconciled before another round can replace it.

When execution delivers a new ARIS run, independent acceptance and the current progress summary refer to that run. The startup follow-up provides a fallback for execution without a new native run; it cannot substitute for a delivered run or turn an older run's acceptance into a new result. Only actual delivered phases receive acceptance.

Codex first inspects existing artifacts, then provides an audit, recommendations, execution steps, and acceptance criteria. These appear in the overview. A plan within the authorized scope is passed to DSH for execution, followed by independent Codex review and any needed repairs. The cycle waits for your response when a scope, cost, or direction decision is required.

A new task received after a completed collaboration round also starts with audit planning by default. For an already precise task, you can disable that option and execute directly; independent review still follows. Redo scope can cover the enabled workflow from the beginning, a stage and its successors, or only one stage. Selecting the scope does not launch work; sending the request does. If no Codex reviewer is bound, the conversation offers an idle reviewer connection and retains the request and selected scope; connecting the reviewer alone does not start a model turn. Direction synchronization shows the confirmations from the bound executor and reviewer, not an assumed acknowledgement from every child.

If the audit finds no new work necessary, its plan returns `no_change` and collaboration becomes `audited`. This records an audit without a new DSH execution or new scientific acceptance. `accepted` means the corresponding artifacts passed independent review; a `done` stage or a finished execution alone is insufficient.

## Inspect progress, history, and artifacts

The overview leads with the conclusion, gap to the goal and current step, preserving evidence limitations that affect the conclusion. Long plans and technical detail can be expanded. Execution artifacts and the matching review result appear beside the summary, with safe project-artifact links. A blocked execution shows its actual reason; artifacts from an earlier direction do not acquire approval for a new one. Progress reflects actual stage acceptance. Audit planning is shown as not yet executing, and affected stages advance again during the new execution. Acceptance from a previous round does not become acceptance of the new one.

Workflows and skills expands the current round; previous rounds appear in history with their artifacts and acceptance records retained. Figures collects images and PDFs that actually exist in the project. Figures without a usage manifest appear as unclassified.

Export downloads a ZIP containing supported documents, figures, data, code, and progress files. Its `EXPORT_README.md` describes the included scope. Credentials, raw session logs, dependencies, and caches are excluded, and limits or packaging failures are reported. Inspect the package before sharing because research content itself can contain sensitive information.

Marking a project completed moves it to the completed list, where it remains available for inspection, export, or restoration. This organizational action neither accepts scientific results nor stops active sessions. A later task can return an archived project to active work.

## Verification boundaries

v0.2.0 passed a representative live run on Windows: DSH and Codex child sessions delivered real files, an independent reviewer rejected an injected counter defect, and DSH automatically repaired it. A new direction sent with Enter reached both bound agents; the latest component then passed six tests and independent browser checks (0 → 2 → 4 → reset to 0). Native question answering, real SVG preview, matched review display, stage progress, result ZIP and project completion were checked through the actual workbench/API. Budget stops and restart identity preservation were observed separately; stopped rounds were retained without acceptance.

Software checks in [tests](../tests) cover native interfaces, finite recovery, project isolation, budgets, iteration, export and bilingual UI. [nativeCollaborationRecovery.ts](../tests/nativeCollaborationRecovery.ts) exercises core/runtime recovery together, [nativeRestartRecovery.ts](../tests/nativeRestartRecovery.ts) covers the delivered-before-status-save crash window without replay, and [dashboardWorkbenchUx.mjs](../tests/dashboardWorkbenchUx.mjs) checks UI state and unknown usage without calling models.

Isolated tests, a browser preview, provider discovery and a successful build do not establish authentication, inference, complete ARIS workflow execution or scientific correctness. No claim is made that every skill or model has been validated. Private research material and raw sessions are excluded from the public release.

Deployment and data boundaries are described in [Architecture](architecture.md) and [SECURITY.md](../SECURITY.md): the services are for localhost on a trusted machine; full access does not enlarge authorization; model calls may incur charges and send project content to configured providers.
