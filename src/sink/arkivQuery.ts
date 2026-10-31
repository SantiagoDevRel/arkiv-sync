import { createPublicClient, type PublicArkivClient } from '@arkiv-network/sdk'
import type { Attributes } from '@arkiv-network/sdk/schema'
import { hexToBytes } from 'viem'
import { http, type Chain, type Transport } from 'viem'
import type { Hex } from '../types.js'
import { createRabdiNetwork } from './network.js'
import { SYNC_SCHEMA_NAME } from './schema.js'
import { quoteValue } from './predicate.js'
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
export interface ArkivReaderOptions { rpcUrl?:string; chain?:Chain; transport?:Transport; accessKey?:string }
export interface QueryParams {
  /** Page size 1..100. query() sorts only this page; queryAll() sorts all bounded results. */
  limit?:number
  owner?:Hex
  offset?:number
  /** Expected response block. Rabdi only serves the head; drift fails closed. */
  atBlock?:bigint
  sortBy?:string
  sortDir?:'asc'|'desc'
}
export interface QueryPage { entities:DecodedEntity[]; offset?:number; blockNumber:bigint }
export interface ArkivReader {
  query(predicate:string, params?:QueryParams):Promise<DecodedEntity[]>
  queryPage(predicate:string, params?:QueryParams):Promise<QueryPage>
  queryAll(predicate:string, params?:Omit<QueryParams,'offset'> & {maxResults:number}):Promise<DecodedEntity[]>
  raw:PublicArkivClient
}
export function decodeEntity(entity:{ $key?:Hex; $owner?:Hex; $creator?:Hex; $expiresAt?:bigint; $attributes?:Attributes }):DecodedEntity {
  if (!entity.$key) throw new Error('Query result lacks an entity key.')
  const attributes:DecodedEntity['attributes']={}
  const attributeTypes:Record<string,string>={}
  for (const [name,cell] of Object.entries(entity.$attributes ?? {})) {
    attributes[name]=typeof cell.value === 'bigint' ? cell.value.toString() : cell.value as string|number|boolean
    attributeTypes[name]=cell.type
  }
  let data:unknown
  const encoded = entity.$attributes?.data
  if (encoded?.type === 'bytes') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(encoded.value))
    try { data = JSON.parse(text) } catch { data = text }
  }
  return {key:entity.$key, owner:entity.$owner, creator:entity.$creator, attributes,attributeTypes,data,
    expiresAtBlock:entity.$expiresAt?.toString()}
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
  const raw=createPublicClient({chain:opts.chain ?? createRabdiNetwork(opts.accessKey).chain,
    transport:opts.transport ?? http(opts.rpcUrl,{retryCount:0,fetchOptions:{cache:'no-store'}})})
  async function queryPage(predicate:string,params:QueryParams={}):Promise<QueryPage> {
    if (!params.owner) throw new Error('An owner is required for every Arkiv Sync query.')
    const scoped = scopeToOwner(`(arkiv.schema = ${quoteValue(SYNC_SCHEMA_NAME)}) AND (${predicate.trim() || 'true'})`,params.owner)
    assertSafePredicate(predicate)
    const limit=params.limit ?? 25
    const page=await raw.query(scoped,{limit,offset:params.offset ?? 0,
      select:{$key:true,$owner:true,$creator:true,$attributes:true,$expiresAt:true}})
    if (params.atBlock!==undefined && page.blockNumber!==params.atBlock) throw new Error('Head changed during query; no partial result returned.')
    if (page.entities.some(e => e.$owner?.toLowerCase()!==params.owner!.toLowerCase())) throw new Error('RPC returned an out-of-owner scoped entity.')
    return {entities:sort(page.entities.map(decodeEntity),params),
      offset:page.entities.length===limit ? (params.offset ?? 0)+page.entities.length : undefined,blockNumber:page.blockNumber}
  }
  async function queryAll(predicate:string,params:Omit<QueryParams,'offset'> & {maxResults:number}={maxResults:1000}) {
    if (!Number.isSafeInteger(params.maxResults)||params.maxResults<1) throw new Error('maxResults must be a positive safe integer.')
    let atBlock=params.atBlock
    const entities:DecodedEntity[]=[]
    let offset=0
    const seen=new Set<string>()
    while (true) {
      const page=await queryPage(predicate,{...params,atBlock,offset,sortBy:undefined})
      atBlock ??= page.blockNumber
      for (const entity of page.entities) {
        if (seen.has(entity.key)) throw new Error('Repeated entity during scan; no partial result returned.')
        seen.add(entity.key); entities.push(entity)
      }
      if (entities.length>params.maxResults) throw new Error('Query exceeded maxResults; no partial result returned.')
      if (page.offset===undefined) break
      offset=page.offset
    }
    return sort(entities,params)
  }
  return {raw,queryPage,queryAll,query:async(predicate,params={}) => (await queryPage(predicate,params)).entities}
}
