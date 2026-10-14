# Security

Brilliant Researcher is a local research workbench for a trusted machine. Its controller and native agent runtime have no internet-facing authentication boundary. Keep them bound to localhost; do not publish their ports through a public tunnel, reverse proxy, or network listener.

## Agent access and project scope

Coding agents can read and modify files and invoke tools under their runtime permissions. Use a dedicated project workspace and state the allowed resources, network use, cost and operations outside that workspace. A full-access setting increases runtime capability; it does not enlarge user authorization or make every action appropriate.

Project scope checks and approval handling complement the underlying agent sandbox. They are not an operating-system isolation guarantee against arbitrary local programs. A local process with access to the same user account may read configuration or call local services; internal request headers are not authentication secrets.

## Credentials and research data

Keep provider credentials in the agent's normal credential store, and local paths/settings in ignored local configuration. Never commit API keys, tokens, session logs, private datasets or unpublished research. Model-backed work sends prompts and selected content to configured providers under their service terms; a local dashboard does not make inference offline.

Deliverable export excludes known credential paths, raw session records, dependencies and caches, but cannot recognize every sensitive statement embedded in a document or dataset. Inspect the ZIP, screenshots and logs before sharing. Public bug reports should use a minimal generic project.

## Report a vulnerability

Use this repository's GitHub **Security → Report a vulnerability** option if private vulnerability reporting is available. If it is unavailable, open a public issue requesting a private contact channel without including exploit details, secrets, private research or raw logs. No dedicated security inbox or response-time commitment is currently published.

Include the affected version or commit, impact, a minimal reproduction using generic data, and any proposed fix in the private report. Rotate any exposed credentials through their provider and remove them from shared material. Removing a key from the latest commit alone does not remove it from Git history.
