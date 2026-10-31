import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, ExpirationTime, EntityMutationError, type ExecuteBatchParameters, type PublicArkivClient, type WalletArkivClient } from '@arkiv-network/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { createRabdiNetwork, RABDI_CHAIN_ID, RABDI_EXPLORER_URL, RABDI_MAX_LIFETIME_BLOCKS, type ArkivNetwork } from './network.js'
import { entitySchema, SYNC_SCHEMA_NAME } from './schema.js'
import { GasBudgetError, prepareGas } from './gas.js'
import { WriteOperation, WriteConfirmationError } from './writeOperation.js'
import { FileWriteJournal, type WriteJournal, type JournalEntry, type JournalTarget } from './journal.js'
import { randomSalt, type TxParams } from '@arkiv-network/sdk'

import { addr, bytes, str, u64, type ArkivValue, type Attributes } from '@arkiv-network/sdk/schema'
import { and, eq, gte, lte, type Expression } from '@arkiv-network/sdk/query'
import { custom, formatEther, http, type Account, type Chain, type Transport } from 'viem'
import type { Hex, Logger, Sink, SinkRecord, WriteProgress, WriteResult } from '../types.js'
import { bigintReplacer, stableStringify, short, scrubSecrets } from '../util.js'
import { normalizeAttributes, storageAttributeName } from './attributes.js'
import { WriteReconciliationRequiredError } from './errors.js'

export type { ArkivNetwork } from './network.js'
const KNOWN_MAINNETS = new Set([1, 10, 25, 56, 100, 137, 204, 250, 324, 1101, 1284, 5000, 8453, 34443, 42161, 42220, 43114, 59144, 81457, 534352, 7777777, 1313161554])
// Symbol registry also coordinates multiple loaded copies of this package in one process.
const queueSymbol = Symbol.for('arkiv-sync.signer-queues.v1')
const registry = globalThis as typeof globalThis & { [queueSymbol]?: Map<string, Promise<unknown>> }
const signerQueues = registry[queueSymbol] ??= new Map<string, Promise<unknown>>()

export interface ArkivSinkOptions {
  /** Supply exactly one local key or caller-owned account. Never put a key in chat/logs. */
  privateKey?: string
  accessKey?: string
  /** Per-write overrides may raise gas; safety floors and the half-block ceiling always apply. */
  txParams?: TxParams
  /** Durable journal directory, shared by every instance using this signer. Default .arkiv-sync. */
  journalDirectory?: string
  /** Custom durable store; MemoryWriteJournal is explicitly for tests only. */
  journal?: WriteJournal
  account?: Account
  rpcUrl?: string
  /** Optional custom transport, including a caller's authenticated server transport. */
  transport?: Transport
  logger: Logger
  network?: ArkivNetwork
  allowMainnet?: boolean
  /** entities per batch, package policy rather than a protocol cap. Default 50. */
  batchSize?: number
  /** Maximum rows scanned before reconciliation aborts without deleting. Default 10000. */
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('PRIVATE_KEY must be 32-byte hex. Configure a locally held throwaway testnet key.')
  return key as Hex
}
type Existing = { key: Hex; contentHash?: string; attributes: Attributes; expiresAt: bigint }
type Prepared = { record: SinkRecord; contentHash: string; attributes: Attributes; expires: ReturnType<typeof ExpirationTime.fromSeconds> }

/** Source EVM logs -> mutable Arkiv derived entities. Instances share one queue per signer/chain. */
export class ArkivSink implements Sink {
  readonly name: string
  readonly identity: string
  private readonly network: ArkivNetwork
  private readonly allowMainnet: boolean
  private readonly batchSize: number
  private readonly maxScanRows: number
  private readonly txParams: TxParams
  private readonly pub: PublicArkivClient
  private readonly wallet: WalletArkivClient
  private readonly account: Account
  private readonly log: Logger
  private readonly journal: WriteJournal
  private activeOperation?: WriteOperation<Awaited<ReturnType<WalletArkivClient['executeBatch']>>>
  private writes = 0
  private startBalance = 0n
  private initialized = false
  private blocked?: WriteReconciliationRequiredError

  constructor(opts: ArkivSinkOptions) {
    if (Boolean(opts.account) === Boolean(opts.privateKey)) throw new Error('Supply exactly one account or privateKey.')
    this.account = opts.account ?? privateKeyToAccount(normalizeKey(opts.privateKey!))
    this.log = opts.logger
    this.network = opts.network ?? createRabdiNetwork(opts.accessKey)
    this.txParams = opts.txParams ?? {}
    this.allowMainnet = opts.allowMainnet ?? process.env.ARKIV_ALLOW_MAINNET === '1'
    this.batchSize = positivePolicy(opts.batchSize, 50, 'batchSize')
    this.maxScanRows = positivePolicy(opts.maxScanRows, 10_000, 'maxScanRows')
    this.name = this.network.name
    this.identity = `arkiv:${this.network.chain.id}:${this.account.address.toLowerCase()}:storage4`
    this.journal = opts.journal ?? new FileWriteJournal(opts.journalDirectory)
    const transport = opts.transport ?? http(opts.rpcUrl, { retryCount: 0, fetchOptions: { cache: 'no-store' } })
    this.pub = createPublicClient({ chain: this.network.chain, transport })
    this.wallet = createWalletClient({ chain: this.network.chain, account: this.account,
      transport: custom({ request: async request => {
        if ((request.method === 'eth_sendTransaction' || request.method === 'eth_sendRawTransaction') && !this.activeOperation) throw new Error('No durable operation admission for wallet broadcast.')
        const result = await this.pub.transport.request(request as any)
        if (request.method === 'eth_sendTransaction' || request.method === 'eth_sendRawTransaction') {
          if (!this.activeOperation) throw new Error('No durable operation admission for wallet broadcast.')
          await this.activeOperation.broadcast(result as Hex)
        }
        return result
      } }, { retryCount: 0 }) })
  }
  get address(): Hex { return this.account.address }
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const queueKey = `${this.network.chain.id}:${this.address.toLowerCase()}`
    const result = (signerQueues.get(queueKey) ?? Promise.resolve()).then(fn, fn)
    const tail = result.then(() => undefined, () => undefined)
    signerQueues.set(queueKey, tail)
    void tail.then(() => { if (signerQueues.get(queueKey) === tail) signerQueues.delete(queueKey) })
    return result
  }
  async init(): Promise<void> {
    return this.runExclusive(() => this.initialize())
  }
  private async initialize(): Promise<void> {
    if (this.blocked) throw this.blocked
    assertWritableChain(await this.pub.getChainId(), this.network, this.allowMainnet)
    await this.recoverJournal()
    if (this.initialized) return
    this.startBalance = await this.pub.getBalance({ address: this.address })
    if (this.startBalance === 0n) throw new Error(`Wallet ${short(this.address)} has zero balance on ${this.name}; fund it with the network gas token.`)
    this.initialized = true
    this.log.info(`sink ready: ${this.name}, wallet ${short(this.address)}`)
  }
  private owner(): Expression { return and(eq('$owner', addr(this.address)), eq('arkiv.schema', str(SYNC_SCHEMA_NAME))) }
  private async scan(predicate: Expression, maxRows: number): Promise<Existing[]> {
    const rows: Existing[] = []
    let offset = 0
    let snapshot: bigint | undefined
    const seen = new Set<string>()
    while (true) {
      const page = await this.pub.query(predicate, { offset, limit: 100,
        select: { $key: true, $owner: true, $attributes: true, $expiresAt: true } })
      snapshot ??= page.blockNumber
      if (page.blockNumber !== snapshot) throw new Error('Head changed during scan; no partial reconciliation is allowed.')
      for (const entity of page.entities) {
        if (!entity.$key || !entity.$attributes || entity.$expiresAt === undefined || entity.$owner?.toLowerCase() !== this.address.toLowerCase()) throw new Error('Incomplete or out-of-owner scoped query result.')
        if (seen.has(entity.$key)) throw new Error('Repeated entity during scan; refusing incomplete reconciliation.')
        seen.add(entity.$key)
        rows.push({ key: entity.$key, attributes: entity.$attributes, expiresAt: entity.$expiresAt,
          contentHash: entity.$attributes.content_hash?.type === 'str' ? entity.$attributes.content_hash.value : undefined })
        if (rows.length > maxRows) throw new Error(`Scoped query exceeded maxScanRows ${maxRows}; no partial reconciliation is allowed.`)
      }
      if (page.entities.length < 100) break
      offset += page.entities.length
    }
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
    if (this.network.chain.id === RABDI_CHAIN_ID && expires.minLifetime >= RABDI_MAX_LIFETIME_BLOCKS) {
      throw new Error('Entity Expiration must be below Rabdi maxLifetime; use Lifetime Extension for longer-lived entities.')
    }
    const normalized = normalizeAttributes(record.attributes)
    const suppliedId = normalized.event_id
    if (suppliedId && (suppliedId.type !== 'str' || suppliedId.value !== record.eventId)) throw new Error('event_id attribute does not match record.eventId.')
    const dataJson = toJsonObject(record.data)
    const contentType = record.contentType ?? 'application/json'
    const attributes = { ...normalized, event_id: str(record.eventId),
      data: bytes(new TextEncoder().encode(stableStringify(dataJson))), content_type: str(contentType) }
    const contentHash = createHash('sha256').update(stableStringify({ contentType,
      expiresInSeconds: record.expiresInSeconds, extendOnUpdate: record.extendOnUpdate ?? false,
      attributes, data: dataJson })).digest('hex')
    return { record, contentHash, expires,
      attributes: { ...attributes, content_hash: str(contentHash) } }
  }
  private replacement(prepared: Prepared, existing: Existing): NonNullable<ExecuteBatchParameters['patches']> {
    const old = Object.fromEntries(Object.entries(existing.attributes).filter(([name]) => name !== 'arkiv.schema'))
    const removed = Object.fromEntries(Object.entries(old).filter(([name]) => !Object.hasOwn(prepared.attributes, name)))
    // Each valid state fits independently. An unnamed removal schema avoids building their
    // over-limit union; both patches still execute atomically in one SDK batch.
    return [
      ...(Object.keys(removed).length ? [{ schema: entitySchema(removed, false), entityKey: existing.key, unset: Object.keys(removed) }] : []),
      { schema: entitySchema(prepared.attributes), entityKey: existing.key, set: prepared.attributes },
    ]
  }
  private targets(params: ExecuteBatchParameters): JournalTarget[] {
    const targets: JournalTarget[] = []
    const upsert = (values: any, key?: Hex) => {
      if (values?.event_id?.type !== 'str' || values?.content_hash?.type !== 'str') throw new Error('Write lacks durable event identity/content hash.')
      targets.push({ kind: 'upsert', key, eventId: values.event_id.value, contentHash: values.content_hash.value,
        sync: values.sync?.type === 'str' ? values.sync.value : undefined })
    }
    for (const value of params.creates ?? []) upsert(value.values)
    for (const value of params.patches ?? []) if (value.set?.content_hash) upsert(value.set, value.entityKey)
    for (const value of params.deletes ?? []) targets.push({ kind: 'delete', key: value.entityKey })
    for (const value of params.extensions ?? []) targets.push({ kind: 'extend', key: value.entityKey,
      minLifetime: value.expiration.minLifetime.toString(), expiresAt: value.expiration.expiresAt.toString() })
    return targets
  }
  private async matchesTargets(entry: JournalEntry, receiptBlock?: bigint): Promise<boolean> {
    for (const target of entry.targets) {
      if (target.kind === 'upsert') {
        const found = await this.findByEventId(target.eventId!, target.sync ? { sync: target.sync } : {})
        if (!found || found.contentHash !== target.contentHash || target.key && found.key !== target.key) return false
      } else {
        let entity
        try { entity = await this.pub.getEntity(target.key!) }
        catch (error) {
          if (target.kind === 'delete' && (error as Error).name === 'NoEntityFoundError') continue
          throw error
        }
        if (target.kind === 'delete') return false
        if (!receiptBlock || entity.$owner?.toLowerCase() !== this.address.toLowerCase()) return false
        const floor = receiptBlock + BigInt(target.minLifetime!)
        const absolute = BigInt(target.expiresAt!)
        if (entity.$expiresAt < (floor > absolute ? floor : absolute)) return false
      }
    }
    return entry.targets.length > 0
  }
  private async recoverJournal(): Promise<void> {
    for (const entry of await this.journal.entries(this.identity)) {
      if (entry.state === 'confirmed' || entry.state === 'failed' || entry.state === 'idle') continue
      if (entry.attempts === 0) { entry.state = 'idle'; await this.journal.save(this.identity, entry); continue }
      let receipt
      if (entry.txHash) {
        try { receipt = await this.pub.getTransactionReceipt({ hash: entry.txHash }) }
        catch { /* a failed lookup never authorizes resubmission */ }
        if (entry.state === 'retryable' && !entry.sdkAcknowledged && entry.attempts === 1 &&
            receipt?.status === 'reverted' && receipt.gasUsed === BigInt(entry.gas!)) continue
      }
      if ((!entry.txHash || receipt?.status === 'success' && receipt.transactionHash.toLowerCase() === entry.txHash.toLowerCase() && receipt.from.toLowerCase() === this.address.toLowerCase()) &&
          await this.matchesTargets(entry, receipt?.blockNumber)) {
        entry.state = 'confirmed'; await this.journal.save(this.identity, entry); continue
      }
      throw new WriteReconciliationRequiredError('Durable operation remains pending/uncertain; reconcile its hash or lookup before any new write.', { txHash: entry.txHash })
    }
  }
  private async submit(params: ExecuteBatchParameters, override: TxParams = this.txParams) {
    await this.initialize()
    const id = createHash('sha256').update(stableStringify({
      creates: params.creates?.map(value => ({ values: value.values, expiration: value.expiration })),
      patches: params.patches?.map(value => ({ key: value.entityKey, set: value.set, unset: value.unset })),
      deletes: params.deletes, extensions: params.extensions,
    })).digest('hex')
    const entries = await this.journal.entries(this.identity)
    if (entries.some(entry => entry.id !== id && !['confirmed', 'failed', 'idle'].includes(entry.state))) {
      throw new WriteReconciliationRequiredError('Another durable operation holds this signer; reconcile it first.')
    }
    const entry: JournalEntry = entries.find(value => value.id === id) ?? { id, state: 'idle', attempts: 0, targets: this.targets(params) }
    if (entry.state === 'confirmed' && !await this.matchesTargets(entry)) {
      throw new WriteReconciliationRequiredError('A completed operation no longer has its expected effects. Verify expiration/reset and select a new journal generation before re-deriving.', { txHash: entry.txHash })
    }
    // Fixed salts ensure the SDK estimates exactly the bytes it will later sign.
    params = { ...params, creates: params.creates?.map(item => ({ ...item, salt: item.salt ?? randomSalt() })) }
    const operation = new WriteOperation<Awaited<ReturnType<WalletArkivClient['executeBatch']>>>(entry as any,
      async snapshot => this.journal.save(this.identity, { ...entry, ...snapshot }))
    this.activeOperation = operation
    try {
      return await operation.run({
        prepare: previousGas => prepareGas(this.pub, this.account, params, override, previousGas),
        send: tx => this.wallet.executeBatch(params, tx),
        receipt: async hash => {
          try { return await this.pub.getTransactionReceipt({ hash }) }
          catch (error) { if ((error as Error).name === 'TransactionReceiptNotFoundError') return null; throw error }
        },
        // A hash alone is insufficient: SDK also throws after successful receipts it cannot decode.
        confirmedRevertHash: error => error instanceof EntityMutationError && /reverted/i.test(error.message) ? error.txHash : undefined,
        errorHash: error => error instanceof EntityMutationError ? error.txHash : undefined,
      })
    } catch (cause) {
      if (operation.attempts === 0) throw cause
      this.blocked = new WriteReconciliationRequiredError('Arkiv write requires reconciliation; further writes are stopped.',
        { cause, txHash: operation.txHash ?? (cause instanceof WriteConfirmationError ? cause.txHash : undefined) })
      throw this.blocked
    } finally { this.activeOperation = undefined }
  }
  async write(record: SinkRecord, onWritten?: WriteProgress, txParams?: TxParams): Promise<WriteResult> {
    return (await this.writeBatch([record], onWritten, txParams))[0]!
  }
  async writeBatch(records: SinkRecord[], onWritten?: WriteProgress, txParams?: TxParams): Promise<WriteResult[]> {
    if (!records.length) return []
    const byId = new Map(records.map(record => [record.eventId, record]))
    const prepared = [...byId.values()].map(record => this.prepare(record))
    const outcomes = new Map<string, WriteResult>()
    await this.runExclusive(async () => {
      if (this.blocked) throw this.blocked
      await this.initialize()
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
      const queue: Prepared[][] = []
      for (let i = 0; i < changed.length; i += this.batchSize) queue.push(changed.slice(i, i + this.batchSize))
      while (queue.length) {
        const chunk = queue.shift()!
        const creates = chunk.filter(p => !existing.has(p.record.eventId))
        const updates = chunk.filter(p => existing.has(p.record.eventId))
        const params: ExecuteBatchParameters = {
          creates: creates.map(p => ({ schema: entitySchema(p.attributes), values: p.attributes, expiration: p.expires })),
          patches: updates.flatMap(p => this.replacement(p, existing.get(p.record.eventId)!)),
        }
        const extensions: Array<{ entityKey: Hex; expiration: ReturnType<typeof ExpirationTime.atBlock> }> = []
        for (const p of updates) if (p.record.extendOnUpdate) {
          const old = existing.get(p.record.eventId)!
          extensions.push({ entityKey: old.key,
            expiration: ExpirationTime.atBlock(old.expiresAt + 1n, { atLeast: p.expires }) })
        }
        if (extensions.length) params.extensions = extensions
        let result
        try { result = await this.submit(params, txParams) }
        catch (error) {
          if (error instanceof GasBudgetError && chunk.length > 1) {
            const midpoint = Math.ceil(chunk.length / 2)
            queue.unshift(chunk.slice(0, midpoint), chunk.slice(midpoint))
            continue
          }
          throw error
        }
        if (result.createdEntities.length !== creates.length || result.patchedEntities.length !== params.patches!.length || result.extendedEntities.length !== extensions.length) {
          this.blocked = new WriteReconciliationRequiredError('Successful batch returned unmatched key counts; preserve txHash and reconcile.', { txHash: result.txHash })
          throw this.blocked
        }
        const expectedUpdates = params.patches!.map(p => p.entityKey)
        if (result.patchedEntities.some((key,index) => key !== expectedUpdates[index])) {
          this.blocked = new WriteReconciliationRequiredError('Successful batch returned unmatched patch identities; reconcile.', { txHash: result.txHash })
          throw this.blocked
        }
        let ci=0
        this.writes += chunk.length
        for (const p of chunk) {
          const updating = existing.has(p.record.eventId)
          const value: WriteResult = { op: updating ? 'update' : 'create', key: updating ? existing.get(p.record.eventId)!.key : result.createdEntities[ci++], txHash: result.txHash }
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
        const result = await this.submitDeletes(keys)
        if (result.deletedEntities.length !== keys.length || result.deletedEntities.some((key,index) => key !== keys[index])) {
          this.blocked = new WriteReconciliationRequiredError('Successful deletion count/keys mismatch; reconcile.',{txHash:result.txHash})
          throw this.blocked
        }
      }
      return stale.length
    })
  }
  private async submitDeletes(keys: Hex[]): Promise<{ deletedEntities: Hex[]; txHash: Hex }> {
    try { return await this.submit({ deletes: keys.map(entityKey => ({ entityKey })) }) }
    catch (error) {
      if (!(error instanceof GasBudgetError) || keys.length <= 1) throw error
      const midpoint = Math.ceil(keys.length / 2)
      const first = await this.submitDeletes(keys.slice(0, midpoint))
      const second = await this.submitDeletes(keys.slice(midpoint))
      return { deletedEntities: [...first.deletedEntities, ...second.deletedEntities], txHash: second.txHash }
    }
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
  static explorerTx(hash:string):string { return `${RABDI_EXPLORER_URL}/tx/${hash}` }
  explorerTxUrl(hash:string):string {
    if (!this.network.explorerUrl) throw new Error('Configure the verified network explorer URL.')
    return `${this.network.explorerUrl}/tx/${hash}`
  }
}
function toJsonObject(data:unknown):object {
  if (data && typeof data === 'object') return JSON.parse(JSON.stringify(data,bigintReplacer))
  return {value:typeof data === 'bigint' ? data.toString() : data}
}
