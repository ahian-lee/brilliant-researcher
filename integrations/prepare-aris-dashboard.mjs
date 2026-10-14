// Copy the existing UI and file reader into the ARIS adaptation for portable use.
// Run `npm run build` first. No private project registration or research output is copied.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const target=resolve('upstream/aris/integrations/dashboard');
mkdirSync(target,{recursive:true});
rmSync(resolve(target,'dist'),{recursive:true,force:true});
cpSync('apps/dashboard/dist',resolve(target,'dist'),{recursive:true});
cpSync('packages/adapters/src/arisReader.ts',resolve(target,'arisReader.ts'));
cpSync('packages/adapters/src/piEvents.ts',resolve(target,'piEvents.ts'));
cpSync('packages/adapters/src/researchFocus.ts',resolve(target,'researchFocus.ts'));
cpSync('packages/adapters/src/agentSessions.ts',resolve(target,'agentSessions.ts'));
cpSync('packages/adapters/src/arisWorkspace.ts',resolve(target,'arisWorkspace.ts'));
cpSync('node_modules/react/LICENSE',resolve(target,'REACT-LICENSE.txt'));
cpSync('node_modules/react-dom/LICENSE',resolve(target,'REACT-DOM-LICENSE.txt'));
console.log('Prepared reusable ARIS Dashboard assets and file reader.');
