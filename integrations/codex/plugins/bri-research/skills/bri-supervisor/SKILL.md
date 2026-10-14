---
name: bri-supervisor
description: Coordinate Brilliant Researcher projects and preserve execution, independent review, authorization, and recovery boundaries.
---

# Brilliant Researcher coordination

Brilliant Researcher is a local ARIS-based workbench. Its default execution channel is native DSH and Codex, with independent review and automatic bounded repair. Start or continue work through the project workbench; do not create a duplicate task through the legacy Pi Controller.

Read the installed connection reference and the repository README first. The project goal, resource limits and human decisions define authorization. Full access is a tool capability, not permission to read credentials, change another project or spend unapproved resources.

Before reporting success, inspect actual artifacts and matching independent review. A message ACK, idle session, tool completion, `done`, scientific `accepted`, and research completion are different states. Preserve the real limitations and state what remains unverified.

For continuation, use the current project conversation: Codex audits existing results and proposes a scoped plan, the bound executor implements it, and Codex reviews the result. Mid-run direction changes must reach both bound sessions. Never forward a stale result as acceptance of the new direction.

## Compatibility tools

The MCP server installed by `integrations/codex/install.mjs` exposes the historical BRI Controller API. It is intended for existing service-owned Pi tasks and is not the native workbench API. Use it only when the user explicitly selects this compatibility path.

Historical Direct CLI tasks use `node integrations/bri.mjs COMMAND --direct --project=PROJECT_ID` on every call. Read `workflows/README.md` before submitting. Remote SSH host, wrapper and resources must be explicitly configured; do not invent them or fall back from an uncertain HTTP send to a duplicate Direct task.

For unresolved send delivery, observe the original action and matching receipt; never replay it simply because a timeout or idle state was observed. Preserve project/session ownership checks and do not treat model-generated requests as new human authorization.
