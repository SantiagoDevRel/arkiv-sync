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
import type { Chain } from 'viem'
import type { Hex, Logger, Sink, SinkRecord, WriteProgress, WriteResult } from '../types.js'
import { bigintReplacer, stableStringify, short, scrubSecrets } from '../util.js'
import { quoteValue, scopeToOwner } from './predicate.js'

const BATCH_SIZE = 50 // entities per mutateEntities transaction (default; tunable up to MAX_OPS_PER_TX)
const MAX_OPS_PER_TX = 1000 // Arkiv hard cap: a mutateEntities tx with >1000 operations is rejected (measured on Braga)
const FIND_CONCURRENCY = 8 // parallel existence checks

/**
 * The Arkiv network the SINK writes to. Braga (testnet) today; this seam is what makes the eventual
 * Arkiv-mainnet switch a CONFIG change (pass a different ArkivNetwork) rather than a code edit — the
 * chain object drives signing (EIP-155 chainId), the explorer/faucet are derived from it, and
 * `isTestnet` gates the safety rails. Decoupled from the SOURCE chain entirely.
 */
export interface ArkivNetwork {
  /** viem/Arkiv chain object — drives the signed chainId. */
  chain: Chain
  /** Human label (also the sink `name`). */
  name: string
  /** A testnet? Writing to a NON-testnet network requires an explicit allowMainnet opt-in. */
  isTestnet: boolean
  /** Explorer base URL for tx links. */
  explorerUrl: string
  /** Faucet URL (testnets only). */
  faucetUrl?: string
}

/** Default sink network: Braga testnet. */
export const BRAGA_NETWORK: ArkivNetwork = {
  chain: braga as unknown as Chain,
  name: 'arkiv:braga',
  isTestnet: true,
  explorerUrl: 'https://explorer.braga.hoodi.arkiv.network',
  faucetUrl: 'https://braga.hoodi.arkiv.network/faucet/',
}

/** Well-known EVM mainnet chain ids — NEVER a valid Arkiv sink, even with allowMainnet (defense
 *  against pointing the writer at Ethereum/Base/BSC/etc. by misconfig). */
const KNOWN_MAINNETS = new Set([
  1, 10, 25, 56, 100, 137, 204, 250, 324, 1101, 1284, 5000, 8453, 34443, 42161, 42220, 43114, 59144, 81457,
  534352, 7777777, 1313161554,
])

export interface ArkivSinkOptions {
  /** A 0x + 64-hex private key (from .env). Signs locally; never leaves the machine. On a testnet
   *  network this MUST be a throwaway burner. */
  privateKey: string
  /** Override the network RPC. Default = the SDK's default for the configured network. */
  rpcUrl?: string
  logger: Logger
  /** Arkiv network to write to. Default: Braga testnet. */
  network?: ArkivNetwork
  /** Explicitly allow writing to a NON-testnet Arkiv network (REAL funds at risk). Also settable via
   *  ARKIV_ALLOW_MAINNET=1. Default false. A known EVM mainnet id is refused regardless. */
  allowMainnet?: boolean
  /** Entities per mutateEntities transaction. Default 50; **clamped to 1000** (Arkiv rejects a tx with
   *  >1000 operations). Larger = higher throughput per wallet (≈ batchSize/blockTime) but a bigger
   *  atomic blast radius if the tx fails. ~150–500 ev/s per wallet at batchSize 1000. */
  batchSize?: number
}

/**
 * Decide whether the sink may sign on `actualChainId`, given the configured network + opt-in. Pure +
 * exported so the policy is unit-testable. Fail-closed with an actionable message.
 */
export function assertWritableChain(actualChainId: number, network: ArkivNetwork, allowMainnet: boolean): void {
  if (KNOWN_MAINNETS.has(actualChainId)) {
    throw new Error(
      `chainId ${actualChainId} is a known EVM mainnet — Arkiv Sync never signs there. The sink must ` +
        `be an Arkiv network (Braga testnet by default).`,
    )
  }
  if (actualChainId !== network.chain.id) {
    throw new Error(
      `The Arkiv RPC reports chainId ${actualChainId}, but the configured network "${network.name}" is ` +
        `chainId ${network.chain.id}. Point ARKIV_RPC_URL at the right network, or pass the matching \`network\`.`,
    )
  }
  if (!network.isTestnet && !allowMainnet) {
    throw new Error(
      `Refusing to write to non-testnet Arkiv network "${network.name}" (chainId ${network.chain.id}) without ` +
        `an explicit opt-in. Set allowMainnet: true (or ARKIV_ALLOW_MAINNET=1) — REAL funds at risk.`,
    )
  }
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
  readonly name: string
  private readonly network: ArkivNetwork
  private readonly allowMainnet: boolean
  private readonly batchSize: number
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
    this.network = opts.network ?? BRAGA_NETWORK
    this.allowMainnet = opts.allowMainnet ?? process.env.ARKIV_ALLOW_MAINNET === '1'
    // Guard NaN/0/negatives/floats, and CLAMP to Arkiv's 1000-ops-per-tx cap (a larger batch would make
    // every write tx fail with "number of operations is greater than 1000").
    const wantedBatch = Number.isInteger(opts.batchSize) && (opts.batchSize as number) > 0 ? (opts.batchSize as number) : BATCH_SIZE
    this.batchSize = Math.min(wantedBatch, MAX_OPS_PER_TX)
    this.name = this.network.name
    this.account = privateKeyToAccount(key)
    const transport = http(opts.rpcUrl) // undefined → SDK uses the network's default RPC
    this.pub = createPublicClient({ chain: this.network.chain, transport })
    this.wallet = createWalletClient({ chain: this.network.chain, account: this.account, transport })
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
    // Verify the RPC serves the CONFIGURED Arkiv network BEFORE signing anything — never an EVM
    // mainnet, never a non-testnet network without an explicit opt-in, and the chainId must match.
    let chainId: number
    try {
      chainId = await this.pub.getChainId()
    } catch (err) {
      throw new Error(`Couldn't reach the Arkiv RPC for "${this.network.name}". (${scrubSecrets((err as Error).message)})`)
    }
    assertWritableChain(chainId, this.network, this.allowMainnet)
    if (!this.network.isTestnet) {
      this.log.warn(`⚠ writing to NON-TESTNET Arkiv network "${this.network.name}" (chainId ${chainId}) — REAL funds at risk.`)
    }

    const balance = await this.pub.getBalance({ address: this.account.address })
    this.startBalance = balance
    if (balance === 0n) {
      const fund = this.network.faucetUrl
        ? `\n  → Fund this address at the faucet: ${this.network.faucetUrl}`
        : `\n  → Fund this address with the network's gas token.`
      throw new Error(
        `Wallet ${this.address} has 0 balance on ${this.network.name}, so it can't write.${fund}\n` +
          `  → Then run the command again.${this.network.isTestnet ? ' (This key is a throwaway testnet burner.)' : ''}`,
      )
    }
    const glm = Number(formatEther(balance))
    if (glm < 0.01 && this.network.faucetUrl) {
      this.log.warn(
        `wallet ${short(this.address)} balance is low (${glm}). Top up at ${this.network.faucetUrl} if writes start failing.`,
      )
    }
    this.log.info(`sink ready: ${this.name}, wallet ${short(this.address)}, balance ${glm}`)
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

  /** ONE paged lookup of OUR existing entities for a sync + block range → Map<eventId,{key,contentHash}>.
   *  Returns null (caller falls back to bounded per-event lookups) when the range holds FAR more
   *  entities than this batch, so a polluted/dense same-sync range can't blow up memory with an
   *  unbounded scan. */
  private async findExistingByRange(
    sync: string,
    fromBlock: number,
    toBlock: number,
    maxRows: number,
  ): Promise<Map<string, { key: Hex; contentHash?: string }> | null> {
    const predicate = scopeToOwner(
      `sync = ${quoteValue(sync)} && block >= ${fromBlock} && block <= ${toBlock}`,
      this.account.address,
    )
    const map = new Map<string, { key: Hex; contentHash?: string }>()
    let cursor: string | undefined
    let scanned = 0
    do {
      const res = await this.pub.query(predicate, {
        includeData: { attributes: true, metadata: false, payload: false },
        resultsPerPage: 200,
        cursor,
      })
      scanned += res.entities.length
      if (scanned > maxRows) return null // range far larger than the batch → bail to per-event (bounded memory)
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
    if (!Number.isInteger(expiresIn) || expiresIn < 2) {
      throw new Error(
        `expiresInSeconds must be an integer >= 2 (Arkiv TTL is in SECONDS, ~2s block granularity). ` +
          `Got ${expiresIn}. Use the time helpers: days()/hours()/minutes(), never milliseconds.`,
      )
    }
    // Normalize ONCE, then hash + serialize the SAME object — so the content hash always reflects the
    // exact bytes stored (no representation drift that could skip a real change as a no-op).
    const jsonPayload = toJsonObject(record.payload)
    const contentHash = hashContent(record.attributes, jsonPayload, contentType, expiresIn)
    const attributes: Attribute[] = [...record.attributes, { key: 'contentHash', value: contentHash }]
    const payload = jsonToPayload(jsonPayload)
    return { contentHash, attributes, payload, contentType, expiresIn }
  }

  /**
   * Single-record write (create-or-skip-or-update). This is the FALLBACK path — the indexer hot path
   * calls writeBatch(), which packs many records into one `mutateEntities` tx (up to 1000 ops). Never
   * loop write() over a set you already have: that is one signed tx + one nonce round-trip PER record.
   */
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

  /** Batched upsert — the HOT PATH. One `mutateEntities` transaction per chunk of `batchSize` records
   *  (default 50, clamped to Arkiv's 1000-ops-per-tx cap). Atomic + dedup-safe; the ONLY Arkiv write
   *  path for 2+ records — one nonce per chunk, never one signed tx per record. */
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

      let existingMap: Map<string, { key: Hex; contentHash?: string }> | null = null
      if (sameSync && allBlocks) {
        const lo = blockNums.reduce((a, b) => (b < a ? b : a), blockNums[0]!)
        const hi = blockNums.reduce((a, b) => (b > a ? b : a), blockNums[0]!)
        // Bound the bulk scan to a few× the batch; a far-larger range returns null → per-event fallback.
        existingMap = await this.findExistingByRange(syncId, lo, hi, Math.max(unique.length * 3, 2000))
      }
      if (!existingMap) {
        existingMap = new Map()
        const found = await mapLimit(prepared, FIND_CONCURRENCY, (p) => this.findByEventId(p.record.eventId))
        prepared.forEach((p, i) => {
          const f = found[i]
          if (f) existingMap!.set(p.record.eventId, f)
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

      for (let start = 0; start < ops.length; start += this.batchSize) {
        const chunk = ops.slice(start, start + this.batchSize)
        const params: MutateEntitiesParameters = {}
        const cc = chunk.filter((o) => o.kind === 'create')
        const cu = chunk.filter((o) => o.kind === 'update')
        if (cc.length) params.creates = cc.map((o) => o.params as never)
        if (cu.length) params.updates = cu.map((o) => o.params as never)
        const r = (await this.wallet.mutateEntities(params)) as {
          txHash?: string
          createdEntities?: Hex[]
          updatedEntities?: Hex[]
        }
        // mutateEntities returns the per-entity keys (createdEntities/updatedEntities, in the order we
        // passed them), so batched writes surface a REAL `key`, not just the tx hash.
        const created = r.createdEntities ?? []
        const updated = r.updatedEntities ?? []
        let ci = 0
        let ui = 0
        this.writes += chunk.length
        for (const o of chunk) {
          const key = o.kind === 'create' ? created[ci++] : updated[ui++]
          resultById.set(o.id, { op: o.kind, key, txHash: r.txHash })
          onWritten?.({ eventId: o.id, op: o.kind, key, txHash: r.txHash })
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
    for (let i = 0; i < stale.length; i += this.batchSize) {
      const chunk = stale.slice(i, i + this.batchSize)
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

  /** Explorer tx URL for the default (Braga) network. For a custom network use `explorerTxUrl`. */
  static explorerTx(txHash: string): string {
    return `${BRAGA_NETWORK.explorerUrl}/tx/${txHash}`
  }

  /** Explorer tx URL for THIS sink's configured network. */
  explorerTxUrl(txHash: string): string {
    return `${this.network.explorerUrl}/tx/${txHash}`
  }
}

/**
 * Full, deterministic content fingerprint to detect real changes. Covers EVERYTHING an Arkiv
 * update replaces — payload, attributes (type-preserving via stableStringify, so number 1 ≠ string
 * "1"), contentType, and expiration — so a change to any of them is seen. Full sha256 (no truncation).
 */
function hashContent(rawAttributes: Attribute[], payloadJson: unknown, contentType: string, expiresIn: number): string {
  const attributes = rawAttributes
    .filter((a) => a.key !== 'contentHash')
    .map((a) => ({ key: a.key, value: a.value }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  // Hash the NORMALIZED payload (toJsonObject output = exactly what gets serialized + stored), not the
  // raw pre-normalization object — a Date/custom-toJSON value could otherwise hash one way and store
  // another, so a genuine change would be wrongly skipped as a no-op.
  const fingerprint = stableStringify({ contentType, expiresIn, attributes, payload: payloadJson })
  return createHash('sha256').update(fingerprint).digest('hex')
}

/** Ensure payload is a JSON object/array (jsonToPayload expects one). Wrap primitives. */
function toJsonObject(payload: unknown): object {
  if (payload && typeof payload === 'object') {
    return JSON.parse(JSON.stringify(payload, bigintReplacer))
  }
  // Wrap a primitive; coerce a root bigint so JSON.stringify (inside jsonToPayload) never throws.
  return { value: typeof payload === 'bigint' ? payload.toString() : payload }
}
