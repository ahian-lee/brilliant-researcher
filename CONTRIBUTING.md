# Contributing

Brilliant Researcher (BRI) combines a local workbench with ARIS research workflows. Contributions should make execution, review, scope handling, or evidence easier to inspect.

## Run locally

Use Node.js 24 and npm. Install Python 3 if you will run ARIS helpers.

```sh
npm ci
npm run setup
npm run build
npm start
```

For UI development, use `npm run dev`. See [README.md](README.md) for native agent setup. Tests can run without real model credentials; a live agent integration requires separately installed, authenticated agents and may incur provider charges.

## Make a focused change

Describe the concrete problem and resulting behavior. Preserve existing scope checks, permission handling, path containment, and distinctions between receipt, execution completion and acceptance. Add or update tests where a meaningful failure could otherwise recur; a documentation correction does not need a new test framework.

Run checks appropriate to the change:

```sh
npm test
npm run test:workbench
npm run build
```

For changes to an agent adapter, verify the affected native operation when you have access to that agent. Report whether validation was an isolated test, an offline run, or a real model-backed run; list any checks you could not perform. Do not commit model keys, local configuration, research datasets, private session logs or user-specific paths. Use generic fixtures.

The [architecture](docs/architecture.md) maps the controller, core, adapters and dashboard. Additional coding agents should implement the existing [NativeDriver interface](packages/adapters/src/native/types.ts) and retain question, permission, cancellation and resume semantics.

## Upstream and review

ARIS is maintained at [wanshuiyin/Auto-claude-code-research-in-sleep](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep). Keep its license and attribution when changing vendored code. Clearly describe local adaptations; do not present them as upstream releases.

Open an issue for a bug or a concrete feature request, or send a focused pull request. Include reproduction steps, the relevant environment and validation. Remove private content from screenshots and logs. For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than posting sensitive details in a public issue.
