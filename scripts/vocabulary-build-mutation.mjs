import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {checkTree,violations} from './vocabulary-guard.mjs';
const repo=JSON.parse(fs.readFileSync('package.json','utf8')).name;
const graph=repo==='arkiv-graph-monorepo',sync=repo==='arkiv-sync';
const source=graph?'apps/example/src/app/page.tsx':sync?'web-demo/index.html':'sample/src/main.ts';
const dirs=graph?['apps/example/.next/static','apps/example/.next/server']:sync?['web-demo/public']:['sample/dist'];
const term='pay'+'load',marker='PKG2_'+term+'_MUTATION';
const original=fs.readFileSync(source,'utf8');
const build=()=>{const p=spawnSync(graph?'pnpm':'npm',graph?['build:example']:['run','build'],{cwd:graph?'.':sync?'web-demo':'sample',encoding:'utf8',maxBuffer:20*1024*1024});if(p.status!==0)throw new Error(p.stdout+'\n'+p.stderr);};
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(dir+'/'+e.name):[dir+'/'+e.name]);}
assert.deepEqual(checkTree('.'),[],'baseline guard must pass before mutation');
try{
 const changed=graph?original.replace('<footer ',`<span>${marker}</span><footer `):sync?original.replace('</body>',`<p>${marker}</p></body>`):original+`\ndocument.documentElement.dataset.vocabularyMutation = ${JSON.stringify(marker)};\n`;
 assert.notEqual(changed,original);
 fs.writeFileSync(source,changed);build();
 const emitted=dirs.flatMap(files).filter(file=>/\.(?:js|html|rsc)$/.test(file)).filter(file=>fs.readFileSync(file,'utf8').includes(marker));
 assert.ok(emitted.length,'source mutation must reach real generated output');
 for(const file of emitted)assert.ok(violations(file,fs.readFileSync(file,'utf8')).length,'guard must reject injected bundle '+file);
 console.log(JSON.stringify({sourceMutation:true,emitted,guardRejected:true}));
}finally{fs.writeFileSync(source,original);build();}
assert.deepEqual(checkTree('.'),[],'restored build must pass');
console.log('PASS source rebuild mutation and restoration');
