# Project collaboration workbench

[中文](research-workbench_CN.md) · [Home](../README.md) · [Architecture](architecture.md)

Follow the [installation instructions](../README.md), then open the [local workbench](http://127.0.0.1:8791/). Select a project to use its overview, workflows and skills, figures, and project conversation together. The default execution backend uses native DSH and Codex interfaces. Install and configure those agents separately and keep the native runtime running; Paseo is not required.

Use **EN / 中文** in the top bar to switch between English and Chinese interface text. The default is English, and the browser remembers your selection. Project goals, conversations, agent output, artifacts, and upstream skill text retain their original language; changing the interface does not translate that content.

## Set the goal and scope

When creating a project, specify the intended result, allowed directories and resources, and constraints on cost, network use, or operations outside the project. The default mode executes within that scope without asking about every ordinary file operation, test, or repair. Decisions about scope, cost, resources, or direction remain with you. A mode that reviews individual permissions is also available.

Start with free collaboration, a single ARIS task, or a full research workflow. Free collaboration enables automatic execution and Codex review by default. A single task starts the selected skill; the full research workflow requires an explicit selection. Models and reasoning options come from the execution backend. Configuration and observed runtime settings are shown separately: a model appearing in the catalog does not establish that it has been tested successfully.

## Execute, review, and change direction

Automatic collaboration follows DSH execution → independent Codex review → repair according to the findings. A delivery or message acknowledgement only confirms receipt. Check the independent review to determine whether the artifacts passed. The backend can continue after the browser is closed, provided its processes remain running.

The project conversation on the right is the shared entry point for activity, new requirements, and pending items. Direction changes sent to a bound execution or review session are synchronized to both sides. The backend stops the old round and continues after the agents confirm the new requirements; results from the old direction do not count for the revised task. Enter sends a message; Shift+Enter inserts a newline. Confirming a selection with a Chinese input method does not send the message.

When a decision is needed, the blocked-work and pending-decision sections show the reason and a route to the relevant item. Questions, choices, requested operations, and answer methods appear together in the pending-items tab. Use the corresponding question's submit button to answer; submitted responses remain visible. Add general project requirements in the ordinary conversation without forwarding review feedback or opening another approval window.

Model and reasoning settings can be changed once the sessions are idle. Pause collaboration first if execution, audit planning, or review is in progress.

## Continue iterating or redo work

The overview's continue/redo action and a workflow stage's redo-from-here action open the existing project conversation with Codex audit and planning enabled by default. Send the prefilled iteration request or add the changes you want; you do not need to write the complete plan yourself.

Codex first inspects existing artifacts, then provides an audit, recommendations, execution steps, and acceptance criteria. These appear in the overview. A plan within the authorized scope is passed to DSH for execution, followed by independent Codex review and any needed repairs. The cycle waits for your response when a scope, cost, or direction decision is required.

A new task received after a completed collaboration round also starts with audit planning by default. For an already precise task, you can disable that option and execute directly; independent review still follows. Redo scope can cover the enabled workflow from the beginning, a stage and its successors, or only one stage. Selecting the scope does not launch work; sending the request does.

If the audit finds no new work necessary, its plan returns `no_change` and collaboration becomes `audited`. This records an audit without a new DSH execution or new scientific acceptance. `accepted` means the corresponding artifacts passed independent review; a `done` stage or a finished execution alone is insufficient.

## Inspect progress, history, and artifacts

The overview explains current work, observed results, distance from the goal, and suggested next steps, preserving evidence limitations that affect the conclusion. Progress reflects actual stage acceptance. Audit planning is shown as not yet executing, and affected stages advance again during the new execution. Acceptance from a previous round does not become acceptance of the new one.

Workflows and skills expands the current round; previous rounds appear in history with their artifacts and acceptance records retained. Figures collects images and PDFs that actually exist in the project. Figures without a usage manifest appear as unclassified.

Export downloads a ZIP containing supported documents, figures, data, code, and progress files. Its `EXPORT_README.md` describes the included scope. Credentials, raw session logs, dependencies, and caches are excluded, and limits or packaging failures are reported. Inspect the package before sharing because research content itself can contain sensitive information.

Marking a project completed moves it to the completed list, where it remains available for inspection, export, or restoration. This organizational action neither accepts scientific results nor stops active sessions. A later task can return an archived project to active work.

## Verification boundaries

Native execution, independent review, real user questions, automatic repair, and direction synchronization have been exercised on representative components. Real agents also completed an iteration through a new audit plan, a mid-execution direction update, a revised plan, execution, and acceptance. Some failure, unknown-state, `needs_input`, and `no_change` branches were verified with isolated tests.

Public software checks are in [tests](../tests). [nativeRuntime.ts](../tests/nativeRuntime.ts), [collaborationLoop.ts](../tests/collaborationLoop.ts), and [iterationPlanning.ts](../tests/iterationPlanning.ts) cover native interfaces, collaboration, and iteration planning respectively. Tests do not replace real model calls or research acceptance. These observations do not establish validation of every ARIS skill, model, or full scientific workflow. Private research material and raw sessions are excluded from the public release.

Deployment and data boundaries are described in [Architecture](architecture.md) and [SECURITY.md](../SECURITY.md): the services are for localhost on a trusted machine; full access does not enlarge authorization; model calls may incur charges and send project content to configured providers.
