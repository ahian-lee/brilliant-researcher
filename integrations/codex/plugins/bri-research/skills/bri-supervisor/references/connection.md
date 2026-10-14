# Local connection

The installer replaces this reference with the current checkout, Node executable and configured local Controller URL. No developer machine path is shipped.

The default native workbench starts with `npm run setup`, `npm run build`, and `npm start`. Read the repository README for runtime configuration.

The compatibility MCP API and `integrations/bri.mjs --direct` manage older Pi tasks. They do not start or continue native workbench projects; never use both channels to dispatch the same work.
