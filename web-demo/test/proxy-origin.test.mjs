import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const same = {host: 'sample.example', origin: 'https://sample.example', 'content-type': 'application/json'};
const cases = [
  ['foreign JSON origin', {...same, origin: 'https://foreign.example'}, 403],
  ['foreign plain-text origin', {...same, origin: 'https://foreign.example', 'content-type': 'text/plain'}, 403],
  ['same-origin plain text', {...same, 'content-type': 'text/plain'}, 415],
  ['missing content type', {host: same.host, origin: same.origin}, 415],
  ['odd content type', {...same, 'content-type': 'application/jsonp'}, 415],
  ['ambiguous content type', {...same, 'content-type': 'application/json, text/plain'}, 415],
  ['array content type', {...same, 'content-type': ['application/json']}, 415],
  ['cross-site without origin', {host: same.host, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site'}, 403],
  ['cross-site despite matching origin', {...same, 'sec-fetch-site': 'cross-site'}, 403],
  ['cross-site metadata with whitespace and case', {...same, 'sec-fetch-site': ' Cross-Site '}, 403],
  ['malformed origin', {...same, origin: 'invalid-origin'}, 403],
  ['opaque origin', {...same, origin: 'null'}, 403],
  ['empty origin', {...same, origin: ''}, 403],
  ['different origin port', {...same, origin: 'https://sample.example:444'}, 403],
  ['origin with no request host', {origin: same.origin, 'content-type': 'application/json'}, 403],
];


const fixtureKey=Symbol.for('sync.proxy.origin.fixture');
const moduleSource=`const state=()=>globalThis[Symbol.for('sync.proxy.origin.fixture')];
export const SOURCE_CHAINS={sepolia:{key:'sepolia',chain:{id:11155111,name:'Sepolia'},defaultRpcUrls:['https://source.example/fixture'],defaultConfirmations:1}};
export class MemoryCursorStore{};export class WriteReconciliationRequiredError extends Error{};
export const days=n=>n*86400,storageAttributeName=n=>n,quoteValue=n=>JSON.stringify(n),scrubSecrets=e=>String(e?.message??e);
export function createArkivReader(){state().readerCalls++;return{query:async()=>{await fetch('https://upstream.example/query');return[];}};}
export function createIndexer(){state().indexerCalls++;return{init:async()=>{await fetch('https://upstream.example/init');},runOnce:async()=>({written:0,upToDate:true}),stop(){}};}
`;
const moduleURL='data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64');let serial=0;
async function invoke(endpoint,headers,method='POST'){
 const env=['ARKIV_ACCESS_KEY','ARKIV_DEMO_OWNER','ENABLE_DEMO_WRITES','ARKIV_WRITE_ACCESS_KEY','PRIVATE_KEY','ETHERSCAN_API_KEY'],previous=env.map(n=>process.env[n]),previousFetch=globalThis.fetch;
 for(const n of env)process.env[n]=n==='ARKIV_DEMO_OWNER'?'0x'+'11'.repeat(20):n==='ENABLE_DEMO_WRITES'?'1':'example-test';
 const state={calls:0,readerCalls:0,indexerCalls:0};globalThis[fixtureKey]=state;
 globalThis.fetch=async()=>{state.calls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x100',abi:[],status:'0'}),{headers:{'content-type':'application/json'}});};
 const response={statusCode:200,stream:false,body:'',headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=JSON.stringify(v);return this;},writeHead(n,h){this.statusCode=n;this.headers={...this.headers,...h};this.stream=true;},write(v){this.body+=v;},end(v=''){this.body+=v;},flushHeaders(){}};
 try{
  const file=new URL('../api/'+endpoint+'.js',import.meta.url);let source=fs.readFileSync(file,'utf8').replace("from 'arkiv-sync'",'from '+JSON.stringify(moduleURL));
  source=source.replace("from '../shared/request-guard.js'",'from '+JSON.stringify(new URL('../shared/request-guard.js',import.meta.url).href));
  const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(source+'\n// case '+serial++).toString('base64'));
  const request={method,headers,url:'/api/'+endpoint+'?contract=0x'+'22'.repeat(20)+'&address=0x'+'22'.repeat(20)+'&chain=sepolia&event=Transfer(address%20from)&mode=backfill',body:'{}',on(){}};
  await handler(request,response);return{status:response.statusCode,calls:state.calls,indexers:state.indexerCalls,readers:state.readerCalls,stream:response.stream,body:response.body};
 }finally{globalThis.fetch=previousFetch;delete globalThis[fixtureKey];env.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];});}
}
for(const endpoint of ['query','run','abi']){
 for(const[name,headers,expected]of cases)test(endpoint+' POST rejects '+name+' before spending a key',async()=>{
  const result=await invoke(endpoint,headers);console.log(JSON.stringify({originCase:endpoint+' POST '+name,expected,status:result.status,upstreamCalls:result.calls}));assert.equal(result.calls,0,'rejected request must not reach upstream');assert.equal(result.indexers,0);assert.equal(result.readers,0);assert.equal(result.stream,false);assert.equal(result.status,expected);
 });
 for(const[name,headers]of [['foreign JSON origin',{...same,origin:'https://foreign.example'}],['foreign plain-text origin',{...same,origin:'https://foreign.example','content-type':'text/plain'}],['cross-site without origin',{host:same.host,'sec-fetch-site':'cross-site'}]])test(endpoint+' GET rejects '+name,async()=>{
  const result=await invoke(endpoint,headers,'GET');console.log(JSON.stringify({originCase:endpoint+' GET '+name,expected:403,status:result.status,upstreamCalls:result.calls}));assert.equal(result.calls,0,'rejected request must not reach upstream');assert.equal(result.indexers,0);assert.equal(result.readers,0);assert.equal(result.stream,false);assert.equal(result.status,403);
 });
 for(const[name,headers,method]of [['same-origin JSON',same,'POST'],['JSON with charset',{...same,'content-type':'application/json; charset=utf-8'},'POST'],['origin absent',{host:same.host,'content-type':'application/json'},'POST'],['matching port',{...same,host:'sample.example:444',origin:'https://sample.example:444'},'POST'],['same-origin GET without content type',{host:same.host,origin:same.origin},'GET']])test(endpoint+' allows '+name,async()=>{
  const result=await invoke(endpoint,headers,method);assert.equal(result.status,200);assert.equal(result.calls,endpoint==='query'?1:2);if(endpoint==='run'){assert.equal(result.indexers,1);assert.match(result.body,/"state":"stopped"/);}else assert.equal(result.indexers,0);
 });
}
