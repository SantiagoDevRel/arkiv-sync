/** Real SDK0.8.1 clients and ABI encoding, deterministic in-memory RPC only; no network/keys. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk'
import { bool, dec, u64, u256 } from '@arkiv-network/sdk/attr'
import { custom, defineChain, parseAbi, parseAbiParameters, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, hexToBytes, bytesToHex, type Hex } from 'viem'
import { ArkivSink, type ArkivNetwork } from '../src/sink/arkivSink.js'
import { createArkivReader } from '../src/sink/arkivQuery.js'
import { storageAttributeName } from '../src/sink/attributes.js'
import { WriteReconciliationRequiredError } from '../src/sink/errors.js'
import { silentLogger } from '../src/log.js'
import type { SinkRecord } from '../src/types.js'

const OWNER='0x00000000000000000000000000000000000000aa' as const
const OTHER='0x00000000000000000000000000000000000000bb' as const
const NATIVE='0x4400000000000000000000000000000000000044' as const
const chain=defineChain({id:7706815,name:'Sorbet fixture',nativeCurrency:{name:'Fixture',symbol:'TEST',decimals:18},rpcUrls:{default:{http:['http://fixture.invalid']}},testnet:true})
const network:ArkivNetwork={chain,name:'fixture:sorbet',isTestnet:true}
const EXECUTE=parseAbi(['function execute((uint8 operation,bytes operationData)[] ops) returns(bytes32[] keys)'])
const ATTR='(bytes32 name,uint8 typeId,bytes value)[]'
const PARAMS={
  1:parseAbiParameters(`(uint128 salt,uint64 expiresAt,uint64 minLifetime,uint8 creationFlags,${ATTR} attributes)`),
  2:parseAbiParameters(`(bytes32 entityKey,${ATTR} mutations)`),
  3:parseAbiParameters('(bytes32 entityKey,uint64 expiresAt,uint64 minLifetime)'),
  4:parseAbiParameters('(bytes32 entityKey,address newOwner)'),
  5:parseAbiParameters('(bytes32 entityKey)'),
}
type Cell={name:Hex;typeId:number;value:Hex}
type Row={key:Hex;owner:Hex;creator:Hex;expiresAt:bigint;attributes:Map<string,{type:string;value:unknown}>;payload:Hex;contentType:string}
const TYPES:Record<number,{tag:string;abi:string}>={1:{tag:'bool',abi:'bool'},2:{tag:'i32',abi:'int32'},3:{tag:'u64',abi:'uint64'},4:{tag:'u256',abi:'uint256'},5:{tag:'dec',abi:'int256'},6:{tag:'bytes32',abi:'bytes32'},7:{tag:'bytes',abi:'bytes'},8:{tag:'str',abi:'string'},9:{tag:'addr',abi:'address'},10:{tag:'key',abi:'bytes32'}}
const hash=(s:string) => ('0x'+createHash('sha256').update(s).digest('hex')) as Hex
const quantity=(n:bigint|number) => ('0x'+BigInt(n).toString(16)) as Hex
class Fixture {
  rows=new Map<Hex,Row>(); receipts=new Map<Hex,unknown>(); head=100n; chainId=7706815; sends=0
  requests:Array<{method:string;params:unknown}>=[]
  batches:number[][]=[]; pageSize=200; fault?:'cursor'|'broadcast'|'decode'; queryOwner?:Hex
  advanceHeadOnSend=false
  transport=custom({request:async ({method,params}) => this.request(method,params)}, {retryCount:0})
  sink(opts:Partial<ConstructorParameters<typeof ArkivSink>[0]>={}) {return new ArkivSink({account:{address:OWNER,type:'json-rpc'},network,logger:silentLogger,transport:this.transport,...opts})}
  private cells(row:Row,cells:readonly Cell[]) {
    for (const cell of cells) {
      const name=new TextDecoder().decode(hexToBytes(cell.name)).replace(/\0+$/,'')
      if (cell.typeId===0) {row.attributes.delete(name);continue}
      const type=TYPES[cell.typeId]!
      const decoded = type.tag==='str' ? new TextDecoder().decode(hexToBytes(cell.value)) :
        type.tag==='bytes' ? cell.value : decodeAbiParameters(parseAbiParameters(type.abi),cell.value)[0]
      if (name==='$payload') {row.payload=decoded as Hex;continue}
      if (name==='$contentType') {row.contentType=decoded as string;continue}
      let value:unknown=decoded
      if (type.tag==='u64'||type.tag==='u256') value=quantity(decoded as bigint)
      if (type.tag==='dec') {
        const n=decoded as bigint;const negative=n<0n;const v=negative ? -n : n
        const tail=(v%10n**18n).toString().padStart(18,'0').replace(/0+$/,'')
        value=(negative?'-':'')+(v/10n**18n).toString()+(tail ? '.'+tail : '')
      }
      row.attributes.set(name,{type:type.tag,value})
    }
  }
  private rpc(row:Row) {return {key:row.key,owner:this.queryOwner ?? row.owner,creator:row.creator,expiresAt:quantity(row.expiresAt),
    attributes:[...row.attributes].map(([name,cell])=>({name,...cell})),payload:row.payload,contentType:row.contentType}}
  private log(eventName:'EntityCreated'|'ExpiryExtended'|'EntityPatched'|'EntityDeleted',key:Hex,expiresAt?:bigint) {
    const topics=encodeEventTopics({abi:ENTITY_EVENTS_ABI,eventName,args:{entityKey:key,owner:OWNER}})
    const data=eventName==='EntityCreated' ? encodeAbiParameters(parseAbiParameters('uint64,uint8'),[expiresAt!,0]) :
      eventName==='ExpiryExtended' ? encodeAbiParameters(parseAbiParameters('uint64'),[expiresAt!]) : '0x'
    return {address:NATIVE,topics,data}
  }
  async request(method:string,params:unknown) : Promise<unknown> {
    this.requests.push({method,params})
    const list=params as any[]
    if (method==='eth_chainId') return quantity(this.chainId)
    if (method==='eth_blockNumber') return quantity(this.head)
    if (method==='eth_getBalance') return quantity(10n**18n)
    if (method==='eth_estimateGas') return quantity(100000)
    if (method==='eth_getTransactionCount') return '0x0'
    if (method==='eth_gasPrice') return '0x1'
    if (method==='arkiv_query') {
      const [query,options]=list as [string,any]
      assert(options.select.key && options.select.attributes,'current SDK projection')
      assert.equal(options.atBlock,quantity(this.head),'every sink/complete-reader query pins snapshot')
      assert(!('includeData' in options) && !('resultsPerPage' in options),'no legacy options')
      if (options.cursor && this.fault==='cursor') throw Object.assign(new Error('fixture cursor rejected'),{code:-32005})
      let rows=[...this.rows.values()].filter(row=>row.expiresAt>this.head)
      const owner=/\$owner = addr\((0x[0-9a-fA-F]+)\)/.exec(query)?.[1]
      if (owner) rows=rows.filter(row=>row.owner.toLowerCase()===owner.toLowerCase())
      for (const m of query.matchAll(/(event_id|sync|contract) = str\('((?:[^']|'')*)'\)/g)) rows=rows.filter(row=>row.attributes.get(m[1]!)?.value===m[2]!.replace(/''/g,"'"))
      const low=/block >= u64\((\d+)\)/.exec(query)?.[1],high=/block <= u64\((\d+)\)/.exec(query)?.[1]
      if(low) rows=rows.filter(row=>BigInt(row.attributes.get('block')!.value as string)>=BigInt(low))
      if(high) rows=rows.filter(row=>BigInt(row.attributes.get('block')!.value as string)<=BigInt(high))
      const offset=options.cursor ? Number(options.cursor.slice(1)) : 0
      const size=Math.min(this.pageSize,Number(BigInt(options.limit)))
      return {data:rows.slice(offset,offset+size).map(row=>this.rpc(row)),blockNumber:quantity(this.head),cursor:offset+size<rows.length ? `c${offset+size}` : undefined}
    }
    if (method==='eth_sendTransaction') {
      this.sends++
      if (this.advanceHeadOnSend) this.head++
      const transaction=list[0]
      assert.equal(transaction.to.toLowerCase(),NATIVE.toLowerCase())
      const decoded=decodeFunctionData({abi:EXECUTE,data:transaction.data})
      const operations=decoded.args![0]
      this.batches.push(operations.map(op=>op.operation))
      const txHash=hash(`fixture-tx-${this.sends}`)
      const logs:any[]=[]
      for(const op of operations) {
        const [args]=decodeAbiParameters(PARAMS[op.operation as keyof typeof PARAMS],op.operationData) as any
        if(op.operation===1) {
          const key=hash(`fixture-entity-${this.rows.size}-${this.sends}-${logs.length}`)
          const row:Row={key,owner:OWNER,creator:OWNER,expiresAt:args.expiresAt>this.head+args.minLifetime ? args.expiresAt : this.head+args.minLifetime,attributes:new Map(),payload:'0x',contentType:''}
          this.cells(row,args.attributes);this.rows.set(key,row);logs.push(this.log('EntityCreated',key,row.expiresAt))
        } else {
          const row=this.rows.get(args.entityKey)!
          assert(row,'mutation target exists')
          if(op.operation===2) {this.cells(row,args.mutations);logs.push(this.log('EntityPatched',row.key))}
          if(op.operation===3) {row.expiresAt=args.expiresAt>this.head+args.minLifetime ? args.expiresAt : this.head+args.minLifetime;logs.push(this.log('ExpiryExtended',row.key,row.expiresAt))}
          if(op.operation===5) {this.rows.delete(row.key);logs.push(this.log('EntityDeleted',row.key))}
        }
      }
      const receipt={transactionHash:txHash,transactionIndex:'0x0',blockHash:hash('block100'),blockNumber:quantity(this.head),from:OWNER,to:NATIVE,
        cumulativeGasUsed:'0x1000',gasUsed:'0x1000',effectiveGasPrice:'0x1',status:'0x1',type:'0x0',contractAddress:null,logsBloom:'0x'+'0'.repeat(512),
        logs:this.fault==='decode' ? [] : logs.map((log,index)=>({...log,blockNumber:quantity(this.head),blockHash:hash('block100'),transactionHash:txHash,transactionIndex:'0x0',logIndex:quantity(index),removed:false}))}
      this.receipts.set(txHash,receipt)
      if(this.fault==='broadcast') throw new Error('fixture dropped broadcast response after applying operation')
      return txHash
    }
    if(method==='eth_getTransactionReceipt') return this.receipts.get(list[0])
    if(method==='eth_sendRawTransaction') throw new Error('Signing keys and raw broadcasts forbidden in this fixture')
    throw new Error(`Unimplemented fixture RPC ${method}; no network fallback`)
  }
}
function record(id:string,attrs:Record<string,any>={},sync='sync-a'):SinkRecord {
  return {eventId:id,attributes:Object.entries({eventId:id,chainId:11155111,block:9007199254740993n,sync,...attrs}).map(([key,value])=>({key,value})),payload:{message:id,value:9007199254740995n},expiresInSeconds:120}
}
const outcomes:Array<{name:string;status:string}>=[]
async function test(name:string,run:()=>Promise<void>|void) {
  await run();outcomes.push({name,status:'PASS'});console.log(`PASS ${name}`)
}
await test('default explorer is documented while an unspecified custom explorer fails closed',()=>{
  assert.equal(ArkivSink.explorerTx(hash('transaction')),`https://tiramisu.explorer.arkiv.network/tx/${hash('transaction')}`)
  assert.throws(()=>new Fixture().sink().explorerTxUrl(hash('transaction')),/verified network explorer/)
})
await test('current SDK real create -> typed read -> dedup skip',async()=>{
  const f=new Fixture(),sink=f.sink()
  const result=await sink.write(record('a',{enabled:bool(true),amount:u256(9007199254740995n),price:dec('1.25')}))
  assert.equal(result.op,'create');assert(result.key && result.txHash)
  const skip=await sink.write(record('a',{enabled:bool(true),amount:u256(9007199254740995n),price:dec('1.25')}))
  assert.equal(skip.op,'skip');assert.equal(f.sends,1)
  const reader=createArkivReader({chain,transport:f.transport})
  const rows=await reader.queryAll("sync = str('sync-a')",{owner:OWNER,maxResults:10})
  assert.equal(rows[0]!.attributes.block,'9007199254740993')
  assert.equal(rows[0]!.attributes.amount,'9007199254740995')
  assert.equal(rows[0]!.attributes.price,'1.25');assert.equal(rows[0]!.attributes.enabled,true)
  assert.equal(rows[0]!.attributeTypes.block,'u64');assert.equal(rows[0]!.expiresAtBlock,'160')
  assert.equal((rows[0]!.data as any).value,'9007199254740995')
})
await test('immediate same-input replay reads a fresh post-receipt head and admits no duplicate',async()=>{
  const f=new Fixture();f.advanceHeadOnSend=true
  const sink=f.sink(),input=record('fresh-head')
  const created=await sink.write(input)
  assert.equal(f.head,101n);assert.equal(created.op,'create')
  const replay=await sink.write(input)
  assert.equal(replay.op,'skip');assert.equal(f.sends,1);assert.equal(f.rows.size,1)
  const snapshots=f.requests.filter(request=>request.method==='arkiv_query').map(request=>(request.params as any[])[1].atBlock)
  assert.deepEqual(snapshots,['0x64','0x65'])
})
await test('complete reader immediately observes the next block after a previous empty snapshot',async()=>{
  const f=new Fixture();f.advanceHeadOnSend=true
  const reader=createArkivReader({chain,transport:f.transport})
  assert.deepEqual(await reader.queryAll("sync = str('sync-a')",{owner:OWNER,maxResults:10}),[])
  const created=await f.sink().write(record('reader-fresh-head'))
  const rows=await reader.queryAll("sync = str('sync-a')",{owner:OWNER,maxResults:10})
  assert.equal(rows.length,1);assert.equal(rows[0]!.key,created.key)
  assert.equal(f.head,101n);assert.equal(f.sends,1)
})
await test('replacement unsets removed attrs and preserves expiry by default',async()=>{
  const f=new Fixture(),sink=f.sink()
  const first=await sink.write(record('a',{oldField:'old',keep:'before'}))
  await sink.write(record('a',{keep:'after'}))
  const row=f.rows.get(first.key as Hex)!
  assert(!row.attributes.has('old_field'));assert.equal(row.attributes.get('keep')!.value,'after')
  assert.equal(row.expiresAt,160n);assert.deepEqual(f.batches[1],[2])
})
await test('explicit extension is atomic with replacement and never shorter',async()=>{
  const f=new Fixture(),sink=f.sink();const first=await sink.write(record('a'))
  const changed={...record('a',{changed:true}),expiresInSeconds:20,extendOnUpdate:true}
  await sink.write(changed)
  assert.deepEqual(f.batches[1],[2,3]);assert(f.rows.get(first.key as Hex)!.expiresAt>160n)
})
await test('mixed create/patch keys map to original rows despite SDK operation ordering',async()=>{
  const f=new Fixture(),sink=f.sink();const old=await sink.write(record('old'))
  const results=await sink.writeBatch([record('old',{next:'v'}),record('new')])
  assert.deepEqual(f.batches[1],[1,2]);assert.equal(results[0]!.key,old.key)
  assert.equal(results[0]!.op,'update');assert.equal(results[1]!.op,'create');assert.notEqual(results[1]!.key,old.key)
})
await test('duplicate input last wins while returned positions do not overcount',async()=>{
  const f=new Fixture(),sink=f.sink();const results=await sink.writeBatch([record('a',{v:1}),record('a',{v:2})])
  assert.equal(f.rows.size,1);assert.equal(results[1]!.op,'skip');assert.equal([...f.rows.values()][0]!.attributes.get('v')!.value,2)
})
await test('owner and sync isolate replacement/deletion/reconciliation',async()=>{
  const f=new Fixture(),sink=f.sink()
  const a=await sink.write(record('same',{},'sync-a'));const b=await sink.write(record('same',{},'sync-b'))
  const foreign:Row={...f.rows.get(a.key as Hex)!,key:hash('foreign'),owner:OTHER};f.rows.set(foreign.key,foreign)
  await sink.delete('same',{sync:'sync-a'})
  assert(!f.rows.has(a.key as Hex));assert(f.rows.has(b.key as Hex));assert(f.rows.has(foreign.key))
  assert.equal(await sink.reconcile(9007199254740993n,9007199254740993n,new Set(),{sync:'sync-b'}),1)
  assert(f.rows.has(foreign.key));assert.equal(f.rows.size,1)
})
await test('concurrent writes stay one exclusive create',async()=>{
  const f=new Fixture(),sink=f.sink();const results=await Promise.all([sink.write(record('a')),sink.write(record('a'))])
  assert.equal(f.sends,1);assert.deepEqual(results.map(r=>r.op),['create','skip'])
})
await test('name mapping collisions and odd expiry reject before any send',async()=>{
  const f=new Fixture(),sink=f.sink()
  assert.equal(storageAttributeName('tokenID'),'token_id')
  await assert.rejects(sink.write(record('a',{fooBar:1,foo_bar:2})),/collision/)
  await assert.rejects(sink.write({...record('a'),expiresInSeconds:3}),/multiple/)
  assert.equal(f.sends,0)
})
await test('chain mismatch rejects even after earlier initialization',async()=>{
  const f=new Fixture(),sink=f.sink();await sink.init();f.chainId=1
  await assert.rejects(sink.write(record('a')),/mainnet/);assert.equal(f.sends,0)
})
await test('bounded pinned multi-page read preserves exact numeric sort',async()=>{
  const f=new Fixture(),sink=f.sink();await sink.writeBatch([record('a',{rank:u64(9007199254740993n)}),record('b',{rank:u64(9007199254740992n)}),record('c',{rank:u64(10n)})])
  f.pageSize=1;const reader=createArkivReader({chain,transport:f.transport})
  const rows=await reader.queryAll("sync = str('sync-a')",{owner:OWNER,maxResults:3,limit:2,sortBy:'rank',sortDir:'asc'})
  assert.deepEqual(rows.map(r=>r.attributes.rank),['10','9007199254740992','9007199254740993'])
  await assert.rejects(reader.queryAll("sync = str('sync-a')",{owner:OWNER,maxResults:2}),/maxResults/)
  await assert.rejects(reader.queryPage("sync = str('sync-a')",{cursor:'c1'}),/original atBlock/)
})
await test('cursor failure returns no partial result and admits no write/delete',async()=>{
  const f=new Fixture(),sink=f.sink();await sink.writeBatch([record('a'),record('b')]);const sends=f.sends
  f.pageSize=1;f.fault='cursor'
  await assert.rejects(sink.reconcile(9007199254740993n,9007199254740993n,new Set(),{sync:'sync-a'}))
  assert.equal(f.sends,sends);assert.equal(f.rows.size,2)
})
await test('out-of-owner RPC row fails closed',async()=>{
  const f=new Fixture(),sink=f.sink();await sink.write(record('a'));f.queryOwner=OTHER
  await assert.rejects(sink.write(record('b')),/out-of-owner/);assert.equal(f.sends,1)
})
await test('unknown broadcast outcome blocks every subsequent admission',async()=>{
  const f=new Fixture(),sink=f.sink();f.fault='broadcast'
  await assert.rejects(sink.write(record('a')),WriteReconciliationRequiredError)
  f.fault=undefined;await assert.rejects(sink.write(record('a')),WriteReconciliationRequiredError)
  assert.equal(f.sends,1);assert.equal(f.rows.size,1)
})
await test('successful receipt decode failure preserves txHash and prevents retry',async()=>{
  const f=new Fixture(),sink=f.sink();f.fault='decode';let error:unknown
  try{await sink.write(record('a'))}catch(e){error=e}
  assert(error instanceof WriteReconciliationRequiredError);assert(error.txHash)
  f.fault=undefined;await assert.rejects(sink.write(record('a')),WriteReconciliationRequiredError);assert.equal(f.sends,1)
})
await test('progress failure after real SDK success preserves hash and stops',async()=>{
  const f=new Fixture(),sink=f.sink();let error:unknown
  try{await sink.write(record('a'),()=>{throw new Error('journal unavailable')})}catch(e){error=e}
  assert(error instanceof WriteReconciliationRequiredError);assert(error.txHash)
  await assert.rejects(sink.write(record('b')),WriteReconciliationRequiredError);assert.equal(f.sends,1)
})
await test('scan bound refuses partial reconciliation before deletion',async()=>{
  const f=new Fixture();await f.sink().writeBatch([record('a'),record('b')]);const sends=f.sends
  const bounded=f.sink({maxScanRows:1})
  await assert.rejects(bounded.reconcile(9007199254740993n,9007199254740993n,new Set(),{sync:'sync-a'}),/maxScanRows/)
  assert.equal(f.sends,sends);assert.equal(f.rows.size,2)
})
await test('sender-scoped duplicate entities require reconciliation',async()=>{
  const f=new Fixture(),sink=f.sink();const created=await sink.write(record('a'))
  const row=f.rows.get(created.key as Hex)!
  f.rows.set(hash('duplicate'),{...row,key:hash('duplicate')})
  await assert.rejects(sink.write(record('a')),/Duplicate event_id/);assert.equal(f.sends,1)
})
console.log(JSON.stringify({status:'PASS',sdk:'0.8.1',tests:outcomes.length,outcomes,networkRequests:0,realBroadcasts:0,keysAccessed:false,scope:'SDK transport/ABI fixtures only; parent funded Tiramisu E2E remains required'}))
