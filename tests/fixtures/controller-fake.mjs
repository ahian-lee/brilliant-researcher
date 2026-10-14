import assert from 'node:assert/strict';
import { FakeRemote } from '../fakeRemote.ts';
import { setTransport } from '../../packages/adapters/src/ssh.ts';

// Install the in-memory transport before the real Controller imports its runner.
// Reject any target outside this fixture instead of falling back to real SSH.
const fake = new FakeRemote();
const transport = fake.transport();
let intercepted = 0;
setTransport(async (command, args, options) => {
  assert.ok(command === 'ssh' || command === 'scp');
  if (command === 'ssh') assert.equal(args.at(-2), 'fake-host');
  else assert.ok(args.at(-1).startsWith('fake-host:'));
  intercepted++;
  return transport(command, args, options);
});
process.on('message', message => {
  if (message === 'transport-audit') process.send?.({fixture:'fake-remote',intercepted,fakeProcesses:fake.procs.size});
});
await import('../../apps/controller/src/server.ts');
