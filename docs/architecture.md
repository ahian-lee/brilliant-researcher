# Architecture

[中文](architecture_CN.md) · [Home](../README.md) · [Workbench guide](research-workbench.md)

Brilliant Researcher (BRI) uses ARIS research skills inside a local project workbench. The default agent path is native DSH execution with independent Codex review. Historical Direct/Pi paths remain for compatibility.

## Components

```mermaid
flowchart TB
    Browser[Local browser workbench] --> Controller[Local HTTP controller]
    Controller --> Core[Project scope, collaboration, approvals and iteration]
    Controller --> Reader[ARIS state and artifact reader]
    Controller --> Runtime[Local native runtime]
    Runtime --> DSH[DSH profile and native sessions]
    Runtime --> Codex[Codex app-server and native threads]
    DSH --> Workspace[Project workspace]
    Codex --> Workspace
    Reader --> Workspace
    Core --> State[Local registry and collaboration state]
    Skills[Vendored ARIS skills and helpers] --> DSH
```

| Component | Source | Responsibility |
| --- | --- | --- |
| Browser | [apps/dashboard](../apps/dashboard) | Project overview, conversation, stages, questions, figures, export and history |
| Controller | [apps/controller](../apps/controller) | Local APIs, project coordination and serving the built dashboard |
| Core | [packages/core](../packages/core) | Project state, collaboration, iteration planning and scope decisions |
| Native runtime | [runner/native-runtime-host.ts](../runner/native-runtime-host.ts) | Native session operations behind a local HTTP interface |
| DSH driver | [dshDriver.ts](../packages/adapters/src/native/dshDriver.ts) | Native DSH events, prompts, resume, model selection and interactions |
| Codex driver | [codexDriver.ts](../packages/adapters/src/native/codexDriver.ts) | Codex app-server threads, turns, approvals and questions |
| ARIS reader | [arisReader.ts](../packages/adapters/src/arisReader.ts) | Read native run, review and trace information |
| Workspace reader | [arisWorkspace.ts](../packages/adapters/src/arisWorkspace.ts) | Discover skill definitions, stage artifacts and figures within a registered root |
| Export | [projectExport.ts](../packages/adapters/src/projectExport.ts) | Package supported project deliverables with explicit exclusions |
| Research foundation | [upstream/aris](../upstream/aris) | Vendored ARIS skills, workflow definitions and supporting tools |

The ARIS files derive from commit `2132036060e03e8d0df69a4b21e5971819c0c2d6`. This release vendors selected public files and includes local integration adaptations; it is not a pristine complete upstream checkout. See [NOTICE](../NOTICE) for attribution.

## Native sessions and collaboration

The runtime uses native DSH and Codex session identifiers and events. Each DSH session has its own process and native writer lease; Codex connects through its app-server protocol. BRI keeps local session metadata so it can reconnect or resume using those native records. Persistence does not imply that a stopped process continues running.

[NativeDriver](../packages/adapters/src/native/types.ts) defines model discovery, open/inspect/send, interruption, configuration, question/permission responses, and shutdown. DSH and Codex implement that interface. Supporting another coding agent requires an adapter and verification of those operations; selecting an arbitrary provider name does not implement them.

[workbenchCollaboration.ts](../apps/controller/src/workbenchCollaboration.ts) connects project collaboration to [collaborationLoop.ts](../packages/core/src/collaborationLoop.ts). The default cycle is DSH execution → independent Codex review → repair or acceptance. New iteration can start with a Codex audit and plan. Direction changes are synchronized to bound sessions and supersede the old round, so earlier results cannot count as acceptance of the changed request.

Ordinary work can proceed inside the declared project scope. Questions about scope, cost, resources or direction remain user decisions. Permission review and user questions use the existing project conversation. Broad runtime capability, including full access, does not grant additional user authorization.

## State and evidence

- Delivery acknowledgement confirms receipt of a request.
- A completed turn or `done` stage describes execution state.
- `accepted` records that the corresponding artifacts passed the configured independent reviewer.
- `audited` with a `no_change` plan records an audit without new execution or new scientific acceptance.
- Archiving a project organizes it in the completed list; it does not accept results or stop active sessions.

A workflow definition is a plan, not a result. The reader checks native artifacts and review information rather than treating every declared phase as completed. A model catalog is also distinct from the model recorded on a real turn. The UI presents configuration and runtime observations separately.

Prior rounds and their artifacts remain available. Stage progress is based on the applicable acceptance records, and stages affected by a redo are updated for the new round. Software acceptance does not substitute for domain assessment of a scientific claim.

## Local configuration and startup

`npm run setup` prepares local configuration without overwriting existing files. `npm start` serves the workbench at port 8791; `npm run dev` uses the Vite development server. The agent runtime is a separate process started with `npm run runtime` after configuring `var/native-runtime.local.json`. Its default port is 8793. Use the [configuration examples](../examples) as the starting point and explicitly enable agents you have installed and authenticated.

Node.js 24 is required for direct TypeScript execution and `node:sqlite`. Python 3 is needed by ARIS helpers. On Windows the dashboard/controller and native runtime run directly, while Bash-based ARIS helpers use WSL. An individual skill may need additional packages, tools, credentials or datasets. An offline dashboard run exercises the web application, not a model call.

The top-bar **EN / 中文** selector, implemented in [i18n.tsx](../apps/dashboard/src/i18n.tsx), switches English and Chinese interface text. Project content, agent output, artifacts, and upstream skill text retain their original language. Core user documentation is available in both languages; MIT legal text and the complete upstream skill collection are not translated.

### Windows background hosting

For Windows users who need background processes independent of their launch terminal, [DashboardWindowsHost.cs](../runner/DashboardWindowsHost.cs), [dashboard-readonly.ps1](../runner/dashboard-readonly.ps1) and [native-runtime-service.ps1](../runner/native-runtime-service.ps1) provide hosting components. Review their parameters and adapt them to your installation before use. They are an advanced deployment path, not required for the terminal-based quick start.

The dashboard host uses a detached child process and a Job Object to tie process cleanup to the owning host. The service scripts manage scheduled-task startup and recovery. Browser closure is separate from service shutdown; intentional shutdown must use the service's stop operation. Do not infer controller health from a surviving Vite development page.

Linux and macOS compatibility is intended, but complete service and real-agent flows have not all been exercised there. Windows-native CI checks software behavior; live provider access still needs a local run.

## Trust and data boundaries

The controller and native runtime are local tools for a trusted machine. The native runtime rejects browser-origin calls and requires its expected internal request header; that header is not an authentication secret. There is no internet-facing identity boundary. Keep the services bound to localhost.

Workspace readers constrain artifact access to registered project roots, including resolved symlink paths. Export excludes known credential, raw-session, dependency and cache paths and reports limits or failures. Review the ZIP before sharing: arbitrary research content can still contain sensitive text.

Local configuration, model credentials, research projects and native session records are not part of the public release. Native agents may send prompts and selected project content to their configured model providers; local hosting does not imply offline inference. See [SECURITY.md](../SECURITY.md).

## Verification boundaries

Representative real-agent runs exercised execution, review, questions, repair, direction synchronization and iteration through acceptance. Selected exceptional branches use isolated tests. [tests](../tests) includes runtime, collaboration, planning, workspace and export checks. These checks do not verify all ARIS skills, model endpoints, scientific claims or operating systems.
