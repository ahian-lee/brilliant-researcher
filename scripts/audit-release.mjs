// Audit the exact source selected by Git; never print suspected secret values.
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const files=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
if(!files.length)throw new Error('No Git source files selected; stage or commit the public source first.');
const problems=[];
const rules=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['github-token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
 ['api-key',/\bsk-[A-Za-z0-9_-]{24,}\b/],
 ['aws-access-key',/\bAKIA[A-Z0-9]{16}\b/],
];
for(const file of files){
 if(/^(?:var|projects|research-projects|output|node_modules|\.playwright-cli)\//.test(file)||/(?:^|\/)(?:\.env|auth\.json|credentials\.ya?ml)$/.test(file)||/\.local\.(?:json|ya?ml)$/.test(file)){problems.push(`${file}: private-state path`);continue;}
 const path=resolve(root,file);if(lstatSync(path).isSymbolicLink()){problems.push(`${file}: source symlink needs review`);continue;}
 const content=readFileSync(path);if(content.includes(0))continue;
 const value=content.toString('utf8');
 for(const [name,pattern]of rules)if(pattern.test(value))problems.push(`${file}: ${name}`);
}
for(const file of ['LICENSE','NOTICE','README.md','README_CN.md','upstream/aris/LICENSE','licenses/PASEO-DSH-DIRECT-MIT.txt'])if(!files.includes(file))problems.push(`${file}: missing public attribution/documentation`);
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log(`Release audit PASS: ${files.length} selected source files; no forbidden local state or literal credential patterns.`);
