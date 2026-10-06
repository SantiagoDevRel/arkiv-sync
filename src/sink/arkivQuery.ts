import { createPublicClient, type PublicArkivClient } from '@arkiv-network/sdk'
import type { EntityFields } from '@arkiv-network/sdk/types'
import { http, type Chain, type Transport } from 'viem'
import type { Hex } from '../types.js'
import { TIRAMISU_NETWORK } from './arkivSink.js'
import { assertSafePredicate, scopeToOwner } from './predicate.js'

export interface DecodedEntity {
  key: Hex
  owner?: string
  creator?: string
  attributes: Record<string,string|number|boolean>
  attributeTypes: Record<string,string>
  data: unknown
  expiresAtBlock?: string
}
export interface ArkivReaderOptions { rpcUrl?:string; chain?:Chain; transport?:Transport }
export interface QueryParams {
  /** Page size1..200. query() sorts only this page; queryAll() sorts all bounded results. */
  limit?:number
  owner?:Hex
  cursor?:string
  /** A cursor must be reused with the same block/query/select/limit. */
  atBlock?:bigint
  sortBy?:string
  sortDir?:'asc'|'desc'
}
export interface QueryPage { entities:DecodedEntity[]; cursor?:string; blockNumber:bigint }
export interface ArkivReader {
  query(predicate:string, params?:QueryParams):Promise<DecodedEntity[]>
  queryPage(predicate:string, params?:QueryParams):Promise<QueryPage>
  queryAll(predicate:string, params?:Omit<QueryParams,'cursor'> & {maxResults:number}):Promise<DecodedEntity[]>
  raw:PublicArkivClient
}
export function decodeEntity(entity:EntityFields):DecodedEntity {
  if (!entity.key) throw new Error('Query result lacks an entity key.')
  const attributes:DecodedEntity['attributes']={}
  const attributeTypes:Record<string,string>={}
  for (const [name,cell] of Object.entries(entity.attributes ?? {})) {
    attributes[name]=typeof cell.value === 'bigint' ? cell.value.toString() : cell.value as string|number|boolean
    attributeTypes[name]=cell.type
  }
  let data:unknown
  if (entity.payload?.length) {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(entity.payload)
    try {data=JSON.parse(text)} catch {data=text}
  }
  return {key:entity.key, owner:entity.owner, creator:entity.creator, attributes,attributeTypes,data,
    expiresAtBlock:entity.expiresAt?.toString()}
}
function compare(a:string|number|boolean|undefined,b:string|number|boolean|undefined):number {
  // Compare exact decimal strings without Number precision loss.
  const decimal=/^-?\d+(?:\.\d+)?$/
  if (decimal.test(String(a)) && decimal.test(String(b))) {
    const split=(v:string) => {const negative=v.startsWith('-');const [whole,fraction='']=v.replace(/^-/,'').split('.');return {negative,whole:whole!,fraction}}
    const av=split(String(a)),bv=split(String(b));const places=Math.max(av.fraction.length,bv.fraction.length)
    const scaled=(v:ReturnType<typeof split>) => BigInt(v.whole+v.fraction.padEnd(places,'0'))*(v.negative ? -1n : 1n)
    const an=scaled(av),bn=scaled(bv);return an<bn ? -1 : an>bn ? 1 : 0
  }
  return String(a ?? '').localeCompare(String(b ?? ''))
}
function sort(rows:DecodedEntity[],params:QueryParams) {
  if (!params.sortBy) return rows
  const name=params.sortBy
  return rows.sort((a,b) => compare(a.attributes[name],b.attributes[name])*(params.sortDir==='asc' ? 1 : -1))
}
export function createArkivReader(opts:ArkivReaderOptions={}):ArkivReader {
  const raw=createPublicClient({chain:opts.chain ?? TIRAMISU_NETWORK.chain,
    transport:opts.transport ?? http(opts.rpcUrl,{fetchOptions:{cache:'no-store'}})})
  async function queryPage(predicate:string,params:QueryParams={}):Promise<QueryPage> {
    if (params.cursor && params.atBlock===undefined) throw new Error('A cursor requires its original atBlock snapshot.')
    const scoped=params.owner ? scopeToOwner(predicate,params.owner) : (assertSafePredicate(predicate),predicate)
    const page=await raw.query(scoped,{limit:params.limit ?? 25,cursor:params.cursor,atBlock:params.atBlock,
      select:{key:true,owner:true,creator:true,attributes:true,payload:true,expiresAt:true}})
    if (params.atBlock!==undefined && page.blockNumber!==params.atBlock) throw new Error('RPC returned a different snapshot block.')
    if (params.owner && page.entities.some(e => e.owner?.toLowerCase()!==params.owner!.toLowerCase())) throw new Error('RPC returned an out-of-owner scoped entity.')
    return {entities:sort(page.entities.map(decodeEntity),params),cursor:page.cursor,blockNumber:page.blockNumber}
  }
  async function queryAll(predicate:string,params:Omit<QueryParams,'cursor'> & {maxResults:number}={maxResults:1000}) {
    if (!Number.isSafeInteger(params.maxResults)||params.maxResults<1) throw new Error('maxResults must be a positive safe integer.')
    const atBlock=params.atBlock ?? await raw.getBlockNumber({cacheTime:0})
    const entities:DecodedEntity[]=[]
    let cursor:string|undefined
    const seen=new Set<string>()
    do {
      const page=await queryPage(predicate,{...params,atBlock,cursor,sortBy:undefined})
      entities.push(...page.entities)
      if (entities.length>params.maxResults) throw new Error('Query exceeded maxResults; no partial result returned.')
      cursor=page.cursor
      if (cursor) {if (seen.has(cursor)) throw new Error('RPC repeated pagination cursor.');seen.add(cursor)}
    } while (cursor)
    return sort(entities,params)
  }
  return {raw,queryPage,queryAll,query:async(predicate,params={}) => (await queryPage(predicate,params)).entities}
}
