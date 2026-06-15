import { createHash } from 'node:crypto'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Attribute,
  type MutateEntitiesParameters,
  type QueryOptions,
} from '@arkiv-network/sdk'
import { privateKeyToAccount } from '@arkiv-network/sdk/accounts'
import { braga } from '@arkiv-network/sdk/chains'
import { jsonToPayload, formatEther } from '@arkiv-network/sdk/utils'
import type { Hex, Logger, Sink, SinkRecord, WriteProgress, WriteResult } from '../types.js'
import { bigintReplacer, stableStringify, short } from '../util.js'
import { quoteValue, scopeToOwner } from './predicate.js'

const BRAGA_CHAIN_ID = 60138453102
const BRAGA_FAUCET = 'https://braga.hoodi.arkiv.network/faucet/'
const BRAGA_EXPLORER = 'https://explorer.braga.hoodi.arkiv.network'
const BATCH_SIZE = 50 // entities per mutateEntities transaction
const FIND_CONCURRENCY = 8 // parallel existence checks

export interface ArkivSinkOptions {
  /** A 0x + 64-hex testnet private key (from .env). Signs locally; never leaves the machine. */
  privateKey: string
  /** Override the Braga RPC. Default = the SDK's verified Braga endpoint. */
  rpcUrl?: string
  logger: Logger
}

/** Well-known mainnet chain ids — the sink NEVER writes to these, even if listed in the env. */
const KNOWN_MAINNETS = new Set([1, 10, 56, 100, 137, 250, 8453, 42161, 43114, 59144, 534352])

/** Allowlist of chain ids this sink may write to (default-deny). Braga + any ARKIV_ALLOW_CHAIN_ID,
 *  but a known mainnet is ALWAYS rejected (absolute "never sign on mainnet" guard). */
function allowedChainIds(): Set<number> {
  const ids = new Set<number>([BRAGA_CHAIN_ID])
  for (const part of (process.env.ARKIV_ALLOW_CHAIN_ID ?? '').split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n > 0 && !KNOWN_MAINNETS.has(n)) ids.add(n) // never a known mainnet
  }
  return ids
}

function normalizeKey(raw: string): Hex {
  const k = raw.trim()
  const withPrefix = k.startsWith('0x') ? k : `0x${k}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    // Never echo the value — it's a private key.
    throw new Error(
      'PRIVATE_KEY must be a 32-byte hex key (64 hex chars, optional 0x prefix). ' +
        'Use a THROWAWAY testnet key funded at the Braga faucet.',
    )
  }
  return withPrefix as Hex
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Arkiv (Braga) sink. Writes each event as one Arkiv entity. Key properties:
 *   - Local signing: viem `privateKeyToAccount` — the key never leaves the machine.
 *   - Testnet-only guard: default-deny allowlist (Braga + ARKIV_ALLOW_CHAIN_ID); never mainnet.
 *   - Balance preflight: a friendly faucet message instead of a cryptic "insufficient funds".
 *   - Idempotent upsert keyed by `eventId`, ALWAYS owner-scoped + injection-safe (shared store).
 *   - Update is full-replace: we send the COMPLETE record every time, so replace is correct.
 *   - Batched writes (mutateEntities) + reorg reconciliation by block-range query.
 */
export class ArkivSink implements Sink {
  readonly name = 'arkiv:braga'
  private readonly pub: ReturnType<typeof createPublicClient>
  private readonly wallet: ReturnType<typeof createWalletClient>
  private readonly account: ReturnType<typeof privateKeyToAccount>
  private readonly log: Logger
  private writes = 0
  private startBalance = 0n
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(opts: ArkivSinkOptions) {
    const key = normalizeKey(opts.privateKey)
    this.log = opts.logger
    this.account = privateKeyToAccount(key)
    const transport = http(opts.rpcUrl) // undefined → SDK uses Braga's default RPC
    this.pub = createPublicClient({ chain: braga, transport })
    this.wallet = createWalletClient({ chain: braga, account: this.account, transport })
  }

  get address(): Hex {
    return this.account.address as Hex
  }

  /**
   * Serialize every signed write through one queue. The wallet has a single nonce; concurrent
   * createEntity/updateEntity/mutateEntities calls would otherwise collide on it. Reads are not
   * serialized.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn)
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async init(): Promise<void> {
    // Verify the RPC actually serves an allowlisted (Braga) chain BEFORE signing anything.
    let chainId: number
    try {
      chainId = await this.pub.getChainId()
    } catch (err) {
      throw new Error(`Couldn't reach the Arkiv (Braga) RPC. (${String((err as Error).message)})`)
    }
    if (!allowedChainIds().has(chainId)) {
      throw new Error(
        `The Arkiv RPC reports chainId ${chainId}, which is not allowlisted (default Braga ${BRAGA_CHAIN_ID}). ` +
          `Arkiv Sync is testnet-only — set ARKIV_ALLOW_CHAIN_ID for another testnet, never a mainnet.`,
      )
    }

    const balance = await this.pub.getBalance({ address: this.account.address })
    this.startBalance = balance
    if (balance === 0n) {
      throw new Error(
        `Wallet ${this.address} has 0 GLM on Braga, so it can't write.\n` +
          `  → Fund this address at the faucet: ${BRAGA_FAUCET}\n` +
          `  → Then run the command again. (This key is a throwaway testnet burner.)`,
      )
    }
    const glm = Number(formatEther(balance))
    if (glm < 0.01) {
      this.log.warn(
        `wallet ${short(this.address)} balance is low (${glm} GLM). Top up at ${BRAGA_FAUCET} if writes start failing.`,
      )
    }
    this.log.info(`sink ready: ${this.name}, wallet ${short(this.address)}, balance ${glm} GLM`)
  }

  /** Find OUR entity (owner-scoped, injection-safe) carrying this eventId. */
  private async findByEventId(
    eventIdValue: string,
  ): Promise<{ key: Hex; contentHash: string | undefined } | null> {
    const predicate = scopeToOwner(`eventId = ${quoteValue(eventIdValue)}`, this.account.address)
    const options: QueryOptions = {
      includeData: { attributes: true, metadata: false, payload: false },
      resultsPerPage: 1,
    }
    const res = await this.pub.query(predicate, options)
    const entity = res.entities[0]
    if (!entity) return null
    const attrs = (entity.attributes ?? []) as Attribute[]
    const contentHash = attrs.find((a) => a.key === 'contentHash')?.value
    return {
      key: entity.key as Hex,
      contentHash: contentHash != null ? String(contentHash) : undefined,
    }
  }

  /** ONE paged lookup of OUR existing entities for a sync + block range → Map<eventId,{key,contentHash}>. */
  private async findExistingByRange(
    sync: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<Map<string, { key: Hex; contentHash?: string }>> {
    const predicate = scopeToOwner(
      `sync = ${quoteValue(sync)} && block >= ${fromBlock} && block <= ${toBlock}`,
      this.account.address,
    )
    const map = new Map<string, { key: Hex; contentHash?: string }>()
    let cursor: string | undefined
    do {
      const res = await this.pub.query(predicate, {
        includeData: { attributes: true, metadata: false, payload: false },
        resultsPerPage: 200,
        cursor,
      })
      for (const e of res.entities) {
        const attrs = (e.attributes ?? []) as Attribute[]
        const eid = attrs.find((a) => a.key === 'eventId')?.value
        const ch = attrs.find((a) => a.key === 'contentHash')?.value
        if (eid != null) {
          map.set(String(eid), { key: e.key as Hex, contentHash: ch != null ? String(ch) : undefined })
        }
      }
      cursor = res.cursor
    } while (cursor)
    return map
  }

  private prepare(record: SinkRecord) {
    const contentType = record.contentType ?? 'application/json'
    const expiresIn = record.expiresInSeconds
    const contentHash = hashContent(record, contentType, expiresIn)
    const attributes: Attribute[] = [...record.attributes, { key: 'contentHash', value: contentHash }]
    const payload = jsonToPayload(toJsonObject(record.payload))
    return { contentHash, attributes, payload, contentType, expiresIn }
  }

  async write(record: SinkRecord, onWritten?: WriteProgress): Promise<WriteResult> {
    const { contentHash, attributes, payload, contentType, expiresIn } = this.prepare(record)
    return this.runExclusive(async () => {
      const existing = await this.findByEventId(record.eventId)
      let res: WriteResult
      if (existing) {
        if (existing.contentHash === contentHash) {
          res = { op: 'skip', key: existing.key }
        } else {
          // Arkiv update = full-replace; we pass the COMPLETE new state, so replace is correct.
          const r = await this.wallet.updateEntity({ entityKey: existing.key, payload, contentType, attributes, expiresIn })
          this.writes++
          res = { op: 'update', key: r.entityKey as string, txHash: r.txHash as string }
        }
      } else {
        const r = await this.wallet.createEntity({ payload, contentType, attributes, expiresIn })
        this.writes++
        res = { op: 'create', key: r.entityKey as string, txHash: r.txHash as string }
      }
      onWritten?.({ eventId: record.eventId, op: res.op, key: res.key, txHash: res.txHash })
      return res
    })
  }

  /** Batched upsert — one transaction per BATCH_SIZE records. Atomic + dedup-safe. */
  async writeBatch(records: SinkRecord[], onWritten?: WriteProgress): Promise<WriteResult[]> {
    if (records.length === 0) return []

    // Dedupe within the batch by eventId (last wins) — getLogs is already unique, but a config
    // watching overlapping addresses/events could surface the same log twice; never plan it as two creates.
    const byId = new Map<string, SinkRecord>()
    for (const r of records) byId.set(r.eventId, r)
    const unique = [...byId.values()]
    const resultById = new Map<string, WriteResult>()

    // Whole plan (existence checks + partition + all chunks) runs in ONE write-lock critical section,
    // so two concurrent writeBatch calls can't both classify the same eventId as a create → no dup.
    await this.runExclusive(async () => {
      const prepared = unique.map((r) => ({ record: r, ...this.prepare(r) }))

      // Existence lookup. Prefer ONE paged range query (sync + block range) over N per-event queries
      // — the latter would hammer the RPC (429) on a busy tick. Falls back to per-event finds if the
      // records don't carry the `sync`/`block` system attributes (e.g. a non-indexer caller).
      const attrOf = (r: SinkRecord, k: string) => r.attributes.find((a) => a.key === k)?.value
      const syncId = String(attrOf(unique[0]!, 'sync') ?? '')
      const sameSync = syncId !== '' && unique.every((r) => String(attrOf(r, 'sync') ?? '') === syncId)
      const blockNums = unique.map((r) => Number(attrOf(r, 'block')))
      const allBlocks = blockNums.every((n) => Number.isFinite(n))

      let existingMap: Map<string, { key: Hex; contentHash?: string }>
      if (sameSync && allBlocks) {
        const lo = blockNums.reduce((a, b) => (b < a ? b : a), blockNums[0]!)
        const hi = blockNums.reduce((a, b) => (b > a ? b : a), blockNums[0]!)
        existingMap = await this.findExistingByRange(syncId, lo, hi)
      } else {
        existingMap = new Map()
        const found = await mapLimit(prepared, FIND_CONCURRENCY, (p) => this.findByEventId(p.record.eventId))
        prepared.forEach((p, i) => {
          const f = found[i]
          if (f) existingMap.set(p.record.eventId, f)
        })
      }

      type Op = { kind: 'create' | 'update'; id: string; params: Record<string, unknown> }
      const ops: Op[] = []
      for (const p of prepared) {
        const ex = existingMap.get(p.record.eventId)
        if (ex) {
          if (ex.contentHash === p.contentHash) {
            resultById.set(p.record.eventId, { op: 'skip', key: ex.key })
            onWritten?.({ eventId: p.record.eventId, op: 'skip', key: ex.key })
          } else {
            ops.push({ kind: 'update', id: p.record.eventId, params: { entityKey: ex.key, payload: p.payload, contentType: p.contentType, expiresIn: p.expiresIn, attributes: p.attributes } })
          }
        } else {
          ops.push({ kind: 'create', id: p.record.eventId, params: { payload: p.payload, contentType: p.contentType, expiresIn: p.expiresIn, attributes: p.attributes } })
        }
      }

      for (let start = 0; start < ops.length; start += BATCH_SIZE) {
        const chunk = ops.slice(start, start + BATCH_SIZE)
        const params: MutateEntitiesParameters = {}
        const cc = chunk.filter((o) => o.kind === 'create')
        const cu = chunk.filter((o) => o.kind === 'update')
        if (cc.length) params.creates = cc.map((o) => o.params as never)
        if (cu.length) params.updates = cu.map((o) => o.params as never)
        const r = await this.wallet.mutateEntities(params) // already inside the write lock
        const txHash = (r as { txHash?: string }).txHash
        this.writes += chunk.length
        for (const o of chunk) {
          resultById.set(o.id, { op: o.kind, txHash })
          onWritten?.({ eventId: o.id, op: o.kind, txHash })
        }
      }
    })

    // Align results back to the original input order. Duplicate input positions (same eventId) get
    // 'skip' so the caller never over-counts a single entity as multiple writes.
    const seen = new Set<string>()
    return records.map((r) => {
      if (seen.has(r.eventId)) return { op: 'skip' as const }
      seen.add(r.eventId)
      return resultById.get(r.eventId) ?? { op: 'skip' }
    })
  }

  async delete(eventIdValue: string): Promise<void> {
    // find + delete INSIDE the lock so the read-then-delete is atomic w.r.t. concurrent writes.
    await this.runExclusive(async () => {
      const existing = await this.findByEventId(eventIdValue)
      if (!existing) return
      await this.wallet.deleteEntity({ entityKey: existing.key })
    })
  }

  /**
   * Reorg reconciliation: delete OUR entities in block range [fromBlock,toBlock] whose eventId is
   * not in `keep` (the canonical set just re-derived). Works at any reorg depth — it relies on the
   * `block` attribute + numeric range query, not on in-memory window state. `scope` (e.g.
   * `{ sync: cursorId }`) narrows deletion to THIS indexer's records, so two indexers sharing one
   * wallet can't delete each other's entities in an overlapping block range.
   */
  async reconcile(
    fromBlock: bigint,
    toBlock: bigint,
    keep: Set<string>,
    scope?: Record<string, string | number>,
  ): Promise<number> {
    let clause = `block >= ${fromBlock} && block <= ${toBlock}`
    for (const [k, v] of Object.entries(scope ?? {})) {
      if (!/^[a-zA-Z0-9_]+$/.test(k)) throw new Error(`Invalid scope attribute key "${k}".`)
      clause += ` && ${k} = ${typeof v === 'number' ? v : quoteValue(String(v))}`
    }
    const predicate = scopeToOwner(clause, this.account.address)
    const stale: Hex[] = []
    let cursor: string | undefined
    do {
      const res = await this.pub.query(predicate, {
        includeData: { attributes: true, metadata: false, payload: false },
        resultsPerPage: 100,
        cursor,
      })
      for (const e of res.entities) {
        const eid = (e.attributes ?? []).find((a: Attribute) => a.key === 'eventId')?.value
        if (eid != null && !keep.has(String(eid))) stale.push(e.key as Hex)
      }
      cursor = res.cursor
    } while (cursor)

    // Batch the deletes — one tx per ~50 entities, not one tx per entity (a big reorg could orphan
    // thousands; serializing thousands of single-delete txs through one nonce would take forever).
    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      const chunk = stale.slice(i, i + BATCH_SIZE)
      await this.runExclusive(() =>
        this.wallet.mutateEntities({ deletes: chunk.map((entityKey) => ({ entityKey })) } as MutateEntitiesParameters),
      )
    }
    if (stale.length) this.log.warn(`reconcile: deleted ${stale.length} orphaned entit(y/ies) in blocks ${fromBlock}-${toBlock}`)
    return stale.length
  }

  /** Live balance — used by the cost/event metric and the smoke. */
  async balance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.account.address })
  }

  costSummary() {
    return { writes: this.writes, totalWei: 0n }
  }

  /** GLM spent since init + per-write average, for the cost/event metric. */
  async spendReport(): Promise<{ spentGlm: number; writes: number; perWriteGlm: number }> {
    const now = await this.balance()
    // Clamp: if the wallet was topped up mid-run, don't report a negative/garbage spend.
    const spentWei = this.startBalance > now ? this.startBalance - now : 0n
    const spentGlm = Number(formatEther(spentWei))
    const perWriteGlm = this.writes > 0 ? spentGlm / this.writes : 0
    return { spentGlm, writes: this.writes, perWriteGlm }
  }

  static explorerTx(txHash: string): string {
    return `${BRAGA_EXPLORER}/tx/${txHash}`
  }
}

/**
 * Full, deterministic content fingerprint to detect real changes. Covers EVERYTHING an Arkiv
 * update replaces — payload, attributes (type-preserving via stableStringify, so number 1 ≠ string
 * "1"), contentType, and expiration — so a change to any of them is seen. Full sha256 (no truncation).
 */
function hashContent(record: SinkRecord, contentType: string, expiresIn: number): string {
  const attributes = record.attributes
    .filter((a) => a.key !== 'contentHash')
    .map((a) => ({ key: a.key, value: a.value }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  const fingerprint = stableStringify({ contentType, expiresIn, attributes, payload: record.payload })
  return createHash('sha256').update(fingerprint).digest('hex')
}

/** Ensure payload is a JSON object/array (jsonToPayload expects one). Wrap primitives. */
function toJsonObject(payload: unknown): object {
  if (payload && typeof payload === 'object') {
    return JSON.parse(JSON.stringify(payload, bigintReplacer))
  }
  return { value: payload }
}
