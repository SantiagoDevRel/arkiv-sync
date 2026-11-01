import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspect} from 'node:util';
import {scrubSecrets} from 'arkiv-sync';

const key=Symbol.for('sync.provider.error.fixture');
const fakeURL='https://rpc.rabdi.db-chain.testnet.arkiv.network/synthetic-demo-key';
const marker='SYNTHETIC_PROVIDER_MARKER';
const moduleSource=`const state=()=>globalThis[Symbol.for('sync.provider.error.fixture')];
export const SOURCE_CHAINS=new Proxy({sepolia:{chain:{id:11155111},defaultRpcUrls:['https://source.example/fixture'],defaultConfirmations:1}},{get(t,k){if(state().endpoint==='abi')throw state().error;return Reflect.get(t,k);}});
export class MemoryCursorStore{};export class WriteReconciliationRequiredError extends Error{};
export const days=n=>n*86400,storageAttributeName=n=>n,quoteValue=n=>JSON.stringify(n),scrubSecrets=e=>state().scrubSecrets(e);
export function createArkivReader(){return{query:async()=>{state().upstreamCalls++;throw state().error;}};}
export function createIndexer(config){return{init:async()=>{state().upstreamCalls++;for(const level of ['debug','info','warn','error']){if(config.logger)config.logger[level](state().error.message,state().error);else console.error(state().scrubSecrets(state().error));}throw state().error;},stop(){}};}
`;
const moduleURL='data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64');
let serial=0;
async function invoke(endpoint,validHash=false){
 const names=['ARKIV_ACCESS_KEY','ARKIV_WRITE_ACCESS_KEY','ARKIV_DEMO_OWNER','ENABLE_DEMO_WRITES','PRIVATE_KEY','ETHERSCAN_API_KEY'],before=names.map(n=>process.env[n]);
 const originalFetch=globalThis.fetch,methods=['log','info','warn','error','debug'],oldConsole=methods.map(n=>console[n]),logs=[];
 const error=Object.assign(new Error(marker+' '+fakeURL,{cause:new Error(fakeURL)}),{details:{url:fakeURL},txHash:validHash?'0x'+'12'.repeat(32):fakeURL,toJSON(){return{message:this.message,cause:this.cause?.message,details:this.details};}});
 const state={endpoint,error,scrubSecrets,upstreamCalls:0};globalThis[key]=state;
 names.forEach(n=>process.env[n]=n==='ENABLE_DEMO_WRITES'?'1':n==='ARKIV_DEMO_OWNER'?'0x'+'11'.repeat(20):'synthetic-demo-key');
 methods.forEach(n=>console[n]=(...args)=>logs.push(inspect(args,{depth:20})+' '+JSON.stringify(args)));
 globalThis.fetch=async()=>{state.upstreamCalls++;return new Response(JSON.stringify({result:'0x100'}));};
 const res={statusCode:200,body:'',setHeader(){},end(v=''){this.body+=v;},write(v){this.body+=v;},writeHead(n){this.statusCode=n;},flushHeaders(){}};
 let thrown;
 try{
  let source=fs.readFileSync(new URL('../api/'+endpoint+'.js',import.meta.url),'utf8').replace("from 'arkiv-sync'",'from '+JSON.stringify(moduleURL)).replace("from '../shared/request-guard.js'",'from '+JSON.stringify(new URL('../shared/request-guard.js',import.meta.url).href));
  const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(source+'\n// case '+serial++).toString('base64'));
  try{await handler({method:'POST',headers:{host:'sample.example',origin:'https://sample.example','content-type':'application/json'},url:'/api/'+endpoint+'?contract=0x'+'22'.repeat(20)+'&address=0x'+'22'.repeat(20)+'&chain=sepolia&event=Transfer(address%20from)&mode=backfill',on(){}},res);}catch(e){thrown=e;}
  return{status:res.statusCode,body:res.body,logs,thrown,serializedThrown:inspect(thrown,{depth:20})+' '+JSON.stringify(thrown),upstreamCalls:state.upstreamCalls};
 }finally{globalThis.fetch=originalFetch;methods.forEach((n,i)=>console[n]=oldConsole[i]);names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);delete globalThis[key];}
}
for(const endpoint of ['query','run','abi'])test(endpoint+' discards provider errors, keyed URLs and nested causes',async()=>{
 const result=await invoke(endpoint);console.log(JSON.stringify({errorCase:endpoint,providerVisible:(result.body+result.logs.join('')+result.serializedThrown).includes(marker),keyedURLVisible:(result.body+result.logs.join('')+result.serializedThrown).includes(fakeURL)}));
 assert.equal(result.thrown,undefined,'handler must contain provider errors');
 const exposed=result.body+result.logs.join('')+result.serializedThrown;
 for(const value of [marker,fakeURL,'synthetic-demo-key','rpc.rabdi.db-chain.testnet.arkiv.network'])assert.equal(exposed.includes(value),false,'provider data must not escape any public/log/thrown representation');
 if(endpoint==='query'){assert.equal(result.status,400);assert.deepEqual(JSON.parse(result.body),{ok:false,error:'Could not query Rabdi. Retry the read later.',code:'RABDI_QUERY_FAILED'});assert.equal(result.upstreamCalls,1);}
 if(endpoint==='abi'){assert.equal(result.status,500);assert.deepEqual(JSON.parse(result.body),{ok:false,error:'Could not load contract events. Retry later.',code:'ABI_LOOKUP_FAILED'});}
 if(endpoint==='run'){assert.match(result.body,/INDEXER_RUN_FAILED/);assert.equal(result.body.includes('txHash'),false);assert.equal(result.logs.length,4);assert.ok(result.logs.every(l=>l.includes('INDEXER_ACTIVITY')));}
});
test('run retains a validated reconciliation hash with the fixed public error',async()=>{
 const result=await invoke('run',true);assert.equal(result.thrown,undefined);assert.match(result.body,new RegExp('0x'+'12'.repeat(32)));assert.match(result.body,/INDEXER_RUN_FAILED/);assert.equal(result.body.includes(marker),false);
});
