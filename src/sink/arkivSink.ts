import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, ExpirationTime, EntityMutationError, type ExecuteBatchParameters, type PublicArkivClient, type WalletArkivClient } from '@arkiv-network/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { jsonToPayload } from '@arkiv-network/sdk/utils'
import { addr, str, u64, type ArkivValue, type Attributes } from '@arkiv-network/sdk/attr'
import { and, eq, gte, lte, type Expression } from '@arkiv-network/sdk/query'
import { formatEther, http, type Account, type Chain, type Transport } from 'viem'
import type { Hex, Logger, Sink, SinkRecord, WriteProgress, WriteResult } from '../types.js'
import { bigintReplacer, stableStringify, short, scrubSecrets } from '../util.js'
import { normalizeAttributes, storageAttributeName } from './attributes.js'
import { WriteReconciliationRequiredError } from './errors.js'

export interface ArkivNetwork {
  chain: Chain
  name: string
  isTestnet: boolean
  explorerUrl?: string
  faucetUrl?: string
}
/** SDK0.8.1 chain; explorer from Arkiv's Tiramisu network documentation. */
export const TIRAMISU_NETWORK: ArkivNetwork = {
  chain: tiramisu, name: 'arkiv:tiramisu', isTestnet: true,
  explorerUrl: 'https://tiramisu.explorer.arkiv.network',
}
const KNOWN_MAINNETS = new Set([1, 10, 25, 56, 100, 137, 204, 250, 324, 1101, 1284, 5000, 8453, 34443, 42161, 42220, 43114, 59144, 81457, 534352, 7777777, 1313161554])

export interface ArkivSinkOptions {
  /** Supply exactly one local key or caller-owned account. Never put a key in chat/logs. */
  privateKey?: string
  account?: Account
  rpcUrl?: string
  /** Optional custom transport, including a caller's authenticated server transport. */
  transport?: Transport
  logger: Logger
  network?: ArkivNetwork
  allowMainnet?: boolean
  /** Records per batch, package policy rather than a protocol cap. Default50. */
  batchSize?: number
  /** Maximum rows scanned before reconciliation aborts without deleting. Default10000. */
  maxScanRows?: number
}

export function assertWritableChain(actualChainId: number, network: ArkivNetwork, allowMainnet: boolean): void {
  if (KNOWN_MAINNETS.has(actualChainId)) throw new Error(`chainId ${actualChainId} is a known EVM mainnet; Arkiv Sync never signs there.`)
  if (actualChainId !== network.chain.id) throw new Error(`RPC chainId ${actualChainId} does not match configured network "${network.name}" (${network.chain.id}).`)
  if (!network.isTestnet && !allowMainnet) throw new Error(`Refusing non-testnet Arkiv network "${network.name}" without allowMainnet: true.`)
}
function positivePolicy(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`)
  return value
}
function normalizeKey(raw: string): Hex {
  const value = raw.trim()
  const key = value.startsWith('0x') ? value : `0x${value}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('PRIVATE_KEY must be32-byte hex. Configure a locally held throwaway testnet key.')
  return key as Hex
}
type Existing = { key: Hex; contentHash?: string; attributes: Attributes; expiresAt: bigint }
type Prepared = { record: SinkRecord; contentHash: string; attributes: Readonly<Record<string, ArkivValue>>; payload: Uint8Array; contentType: string; expires: ReturnType<typeof ExpirationTime.fromSeconds> }

/** Source EVM logs -> mutable Arkiv derived entities. One instance has one exclusive writer queue. */
export class ArkivSink implements Sink {
  readonly name: string
  readonly identity: string
  private readonly network: ArkivNetwork
  private readonly allowMainnet: boolean
  private readonly batchSize: number
  private readonly maxScanRows: number
  private readonly pub: PublicArkivClient
  private readonly wallet: WalletArkivClient
  private readonly account: Account
  private readonly log: Logger
  private writes = 0
  private startBalance = 0n
  private writeChain: Promise<unknown> = Promise.resolve()
  private initialized = false
  private blocked?: WriteReconciliationRequiredError

  constructor(opts: ArkivSinkOptions) {
    if (Boolean(opts.account) === Boolean(opts.privateKey)) throw new Error('Supply exactly one account or privateKey.')
    this.account = opts.account ?? privateKeyToAccount(normalizeKey(opts.privateKey!))
    this.log = opts.logger
    this.network = opts.network ?? TIRAMISU_NETWORK
    this.allowMainnet = opts.allowMainnet ?? process.env.ARKIV_ALLOW_MAINNET === '1'
    this.batchSize = positivePolicy(opts.batchSize, 50, 'batchSize')
    this.maxScanRows = positivePolicy(opts.maxScanRows, 10_000, 'maxScanRows')
    this.name = this.network.name
    this.identity = `arkiv:${this.network.chain.id}:${this.account.address.toLowerCase()}:storage3`
    const transport = opts.transport ?? http(opts.rpcUrl, { retryCount: 0, fetchOptions: { cache: 'no-store' } })
    this.pub = createPublicClient({ chain: this.network.chain, transport })
    this.wallet = createWalletClient({ chain: this.network.chain, account: this.account, transport })
  }
  get address(): Hex { return this.account.address }
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(fn, fn)
    this.writeChain = result.then(() => undefined, () => undefined)
    return result
  }
  async init(): Promise<void> {
    if (this.blocked) throw this.blocked
    assertWritableChain(await this.pub.getChainId(), this.network, this.allowMainnet)
    if (this.initialized) return
    this.startBalance = await this.pub.getBalance({ address: this.address })
    if (this.startBalance === 0n) throw new Error(`Wallet ${short(this.address)} has0 balance on ${this.name}; fund it with the network gas token.`)
    this.initialized = true
    this.log.info(`sink ready: ${this.name}, wallet ${short(this.address)}`)
  }
  private owner(): Expression { return eq('$owner', addr(this.address)) }
  private async scan(predicate: Expression, maxRows: number): Promise<Existing[]> {
    const atBlock = await this.pub.getBlockNumber({ cacheTime: 0 })
    const rows: Existing[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.pub.query(predicate, { atBlock, cursor, limit: 200,
        select: { key: true, owner: true, attributes: true, expiresAt: true } })
      if (page.blockNumber !== atBlock) throw new Error('RPC returned a different snapshot block.')
      for (const entity of page.entities) {
        if (!entity.key || !entity.attributes || entity.expiresAt === undefined || entity.owner?.toLowerCase() !== this.address.toLowerCase()) throw new Error('Incomplete or out-of-owner scoped query result.')
        rows.push({ key: entity.key, attributes: entity.attributes, expiresAt: entity.expiresAt,
          contentHash: entity.attributes.content_hash?.type === 'str' ? entity.attributes.content_hash.value : undefined })
        if (rows.length > maxRows) throw new Error(`Scoped query exceeded maxScanRows ${maxRows}; no partial reconciliation is allowed.`)
      }
      cursor = page.cursor
      if (cursor) {
        if (seen.has(cursor)) throw new Error('RPC repeated a pagination cursor.')
        seen.add(cursor)
      }
    } while (cursor)
    return rows
  }
  private async findByEventId(id: string, scope: Record<string,string|number> = {}): Promise<Existing | undefined> {
    const predicates = [this.owner(), eq('event_id', str(id))]
    for (const [name,value] of Object.entries(scope)) predicates.push(eq(storageAttributeName(name), value))
    const rows = await this.scan(and(predicates), 2)
    if (rows.length > 1) throw new Error('Duplicate event_id in owner scope requires manual reconciliation.')
    return rows[0]
  }
  private prepare(record: SinkRecord): Prepared {
    const expires = ExpirationTime.fromSeconds(record.expiresInSeconds)
    const normalized = normalizeAttributes(record.attributes)
    const suppliedId = normalized.event_id
    if (suppliedId && (suppliedId.type !== 'str' || suppliedId.value !== record.eventId)) throw new Error('event_id attribute does not match record.eventId.')
    const payloadJson = toJsonObject(record.payload)
    const contentType = record.contentType ?? 'application/json'
    const attributes = { ...normalized, event_id: str(record.eventId) }
    const contentHash = createHash('sha256').update(stableStringify({ contentType,
      expiresInSeconds: record.expiresInSeconds, extendOnUpdate: record.extendOnUpdate ?? false,
      attributes, payload: payloadJson })).digest('hex')
    return { record, contentHash, payload: jsonToPayload(payloadJson), contentType, expires,
      attributes: { ...attributes, content_hash: str(contentHash) } }
  }
  private replacement(prepared: Prepared, existing: Existing): NonNullable<ExecuteBatchParameters['patches']> {
    return [{ entityKey: existing.key, set: prepared.attributes,
      unset: Object.keys(existing.attributes).filter(name => !Object.hasOwn(prepared.attributes, name)),
      payload: prepared.payload, contentType: prepared.contentType }]
  }
  private async submit(params: ExecuteBatchParameters) {
    await this.init() // Recheck actual chain before every admitted wallet call.
    try { return await this.wallet.executeBatch(params) }
    catch (cause) {
      this.blocked = new WriteReconciliationRequiredError('Arkiv write requires reconciliation; automatic resubmission is stopped.',
        { cause, txHash: cause instanceof EntityMutationError ? cause.txHash : undefined })
      throw this.blocked
    }
  }
  async write(record: SinkRecord, onWritten?: WriteProgress): Promise<WriteResult> {
    return (await this.writeBatch([record], onWritten))[0]!
  }
  async writeBatch(records: SinkRecord[], onWritten?: WriteProgress): Promise<WriteResult[]> {
    if (!records.length) return []
    const byId = new Map(records.map(record => [record.eventId, record]))
    const prepared = [...byId.values()].map(record => this.prepare(record))
    const outcomes = new Map<string, WriteResult>()
    await this.runExclusive(async () => {
      if (this.blocked) throw this.blocked
      await this.init()
      const existing = new Map<string, Existing>()
      const firstSync = prepared[0]!.attributes.sync
      const scoped = firstSync?.type === 'str' && prepared.every(p => p.attributes.sync?.type === 'str' && p.attributes.sync.value === firstSync.value && p.attributes.block?.type === 'u64')
      if (scoped) {
        const blocks = prepared.map(p => (p.attributes.block as ReturnType<typeof u64>).value)
        const lo = blocks.reduce((a,b) => a < b ? a : b)
        const hi = blocks.reduce((a,b) => a > b ? a : b)
        const rows = await this.scan(and(this.owner(), eq('sync', firstSync), gte('block', u64(lo)), lte('block', u64(hi))), this.maxScanRows)
        for (const row of rows) {
          const id = row.attributes.event_id
          if (id?.type !== 'str') throw new Error('Owned scoped entity lacks a string event_id.')
          if (existing.has(id.value)) throw new Error('Duplicate event_id in owner/sync scope requires reconciliation.')
          existing.set(id.value, row)
        }
      } else {
        for (const p of prepared) {
          const sync = p.attributes.sync
          const found = await this.findByEventId(p.record.eventId, sync?.type === 'str' ? {sync:sync.value} : undefined)
          if (found) existing.set(p.record.eventId, found)
        }
      }
      const changed = prepared.filter(p => {
        const old = existing.get(p.record.eventId)
        if (old?.contentHash === p.contentHash) {
          const result: WriteResult = { op: 'skip', key: old.key }
          outcomes.set(p.record.eventId, result)
          onWritten?.({ eventId: p.record.eventId, ...result })
          return false
        }
        return true
      })
      for (let i=0; i<changed.length; i+=this.batchSize) {
        const chunk = changed.slice(i,i+this.batchSize)
        const creates = chunk.filter(p => !existing.has(p.record.eventId))
        const updates = chunk.filter(p => existing.has(p.record.eventId))
        const params: ExecuteBatchParameters = {
          creates: creates.map(p => ({ payload: p.payload, contentType: p.contentType, attributes: p.attributes, expires: p.expires })),
          patches: updates.flatMap(p => this.replacement(p, existing.get(p.record.eventId)!)),
        }
        const extensions: NonNullable<ExecuteBatchParameters['extensions']> = []
        for (const p of updates) if (p.record.extendOnUpdate) {
          const old = existing.get(p.record.eventId)!
          extensions.push({ entityKey: old.key,
            expires: ExpirationTime.atBlock(old.expiresAt + 1n, { atLeast: p.expires }) })
        }
        if (extensions.length) params.extensions = extensions
        const result = await this.submit(params)
        if (result.createdEntities.length !== creates.length || result.patchedEntities.length !== updates.length || result.extendedEntities.length !== extensions.length) {
          this.blocked = new WriteReconciliationRequiredError('Successful batch returned unmatched key counts; preserve txHash and reconcile.', { txHash: result.txHash })
          throw this.blocked
        }
        const expectedUpdates = updates.map(p => existing.get(p.record.eventId)!.key)
        if (result.patchedEntities.some((key,index) => key !== expectedUpdates[index])) {
          this.blocked = new WriteReconciliationRequiredError('Successful batch returned unmatched patch identities; reconcile.', { txHash: result.txHash })
          throw this.blocked
        }
        let ci=0,ui=0
        this.writes += chunk.length
        for (const p of chunk) {
          const updating = existing.has(p.record.eventId)
          const value: WriteResult = { op: updating ? 'update' : 'create', key: updating ? result.patchedEntities[ui++] : result.createdEntities[ci++], txHash: result.txHash }
          outcomes.set(p.record.eventId, value)
          try { onWritten?.({ eventId: p.record.eventId, ...value }) }
          catch (cause) {
            this.blocked = new WriteReconciliationRequiredError('Write succeeded but progress callback failed; preserve txHash and reconcile.', {cause,txHash:result.txHash})
            throw this.blocked
          }
        }
      }
    })
    const seen = new Set<string>()
    return records.map(record => {
      if (seen.has(record.eventId)) return { op: 'skip' }
      seen.add(record.eventId)
      return outcomes.get(record.eventId)!
    })
  }
  async delete(id: string, scope?:Record<string,string|number>): Promise<void> {
    await this.runExclusive(async () => {
      if (this.blocked) throw this.blocked
      const found = await this.findByEventId(id,scope)
      if (found) await this.submit({ deletes: [{ entityKey: found.key }] })
    })
  }
  async reconcile(fromBlock: bigint, toBlock: bigint, keep: Set<string>, scope: Record<string,string|number> = {}): Promise<number> {
    return this.runExclusive(async () => {
      if (this.blocked) throw this.blocked
      const predicates = [this.owner(), gte('block',u64(fromBlock)),lte('block',u64(toBlock))]
      for (const [key,value] of Object.entries(scope)) predicates.push(eq(storageAttributeName(key), typeof value === 'number' ? value : str(value)))
      const rows = await this.scan(and(predicates),this.maxScanRows)
      const stale = rows.filter(row => {
        const id = row.attributes.event_id
        if (id?.type !== 'str') throw new Error('Scoped entity lacks event_id; refusing partial deletion.')
        return !keep.has(id.value)
      })
      for (let i=0; i<stale.length; i+=this.batchSize) {
        const keys = stale.slice(i,i+this.batchSize).map(row => row.key)
        const result = await this.submit({ deletes:keys.map(entityKey => ({entityKey})) })
        if (result.deletedEntities.length !== keys.length || result.deletedEntities.some((key,index) => key !== keys[index])) {
          this.blocked = new WriteReconciliationRequiredError('Successful deletion count/keys mismatch; reconcile.',{txHash:result.txHash})
          throw this.blocked
        }
      }
      return stale.length
    })
  }
  async balance(): Promise<bigint> { return this.pub.getBalance({ address:this.address }) }
  costSummary(): undefined { return undefined } // No receipt-fee journal is maintained by this sink.
  /** Balance delta can include unrelated transfers; receipt accounting is the authoritative cost. */
  async spendReport() {
    const balance = await this.balance()
    const spent = this.startBalance > balance ? this.startBalance-balance : 0n
    const spentGlm = Number(formatEther(spent))
    return {spentGlm,writes:this.writes,perWriteGlm:this.writes ? spentGlm/this.writes : 0}
  }
  static explorerTx(hash:string):string { return `${TIRAMISU_NETWORK.explorerUrl}/tx/${hash}` }
  explorerTxUrl(hash:string):string {
    if (!this.network.explorerUrl) throw new Error('Configure the verified network explorer URL.')
    return `${this.network.explorerUrl}/tx/${hash}`
  }
}
function toJsonObject(payload:unknown):object {
  if (payload && typeof payload === 'object') return JSON.parse(JSON.stringify(payload,bigintReplacer))
  return {value:typeof payload === 'bigint' ? payload.toString() : payload}
}
