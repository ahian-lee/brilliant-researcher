// Windows lifecycle diagnostic only: no BRI DB, SSH, agents, or models.
import { createServer } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';
const [state, portText] = process.argv.slice(2);
const port = Number(portText);
writeFileSync(state, JSON.stringify({ pid: process.pid, argv: process.argv, started: new Date().toISOString() }));
const timer = setInterval(() => appendFileSync(`${state}.heartbeat`, `${Date.now()}\n`), 1000);
createServer((_req, res) => { res.end(JSON.stringify({ pid: process.pid })); }).listen(port, '127.0.0.1');
process.on('exit', code => appendFileSync(`${state}.exit`, `${code}\n`));
