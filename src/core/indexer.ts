import type {
  Cursor,
  CursorStore,
  EventMapper,
  Logger,
  NormalizedEvent,
  Sink,
  SinkRecord,
  SourceAdapter,
  WriteProgress,
} from '../types.js'
import { sleep, scrubSecrets } from '../util.js'
import { detectReorg, pruneCursorWindow, truncateAbove } from './reorg.js'

/** Attribute keys the indexer sets itself — a mapper may not override them. */
const RESERVED_ATTRS = new Set(['eventId', 'contentHash', 'chainId', 'contract', 'event', 'block', 'sync'])

/**
 * Observability callback payload — what the worker is doing, JSON-safe. Lets a UI/dashboard show the
 * two sides live (events read from the chain → entities written to Arkiv) and the lag in between.
 */
export type IndexerActivity =
  | {
      kind: 'source'
      fromBlock: string
      toBlock: string
      count: number
      events: Array<{ eventId: string; event: string; block: number; tx: string; args: Record<string, string> }>
    }
  | { kind: 'writing'; count: number } // about to write `count` records — UI shows a "writing…" state
  | { kind: 'write'; op: 'create' | 'update' | 'skip'; eventId: string; block: number; key?: string; txHash?: string }
  | {
      kind: 'tick'
      head: string
      safeHead: string
      lastProcessed: string
      lagBlocks: string
      processed: number
      written: number
      reorged: boolean
    }

export interface IndexerOptions {
  source: SourceAdapter
  sink: Sink
  map: EventMapper
  /** Default entity lifetime in SECONDS (use the time helpers, e.g. days(30)). */
  ttlSeconds: number
  cursorStore: CursorStore
  logger: Logger
  /** A short label (e.g. contract name/address) to namespace the cursor file. */
  cursorLabel: string
  /** Blocks to stay behind the head before treating data as safe. Default 5. */
  confirmations?: number
  /** Poll cadence when caught up. Default 12000ms (~Sepolia block time). */
  pollIntervalMs?: number
  /** Where to begin: a block number, or 'latest' (only new events). Default 'latest'. */
  fromBlock?: bigint | number | 'latest'
  /** How many recent blocks to keep hashes for, to catch reorgs. Default confirmations + 6. */
  reorgWindow?: number
  /** Max blocks advanced per tick, to bound the block span during backfill. Default 5000. */
  maxBlocksPerTick?: number
  /**
   * HARD cap on events materialized in one tick — bounds memory regardless of block density. When a
   * tick would exceed it, the block range is SHRUNK (the cursor advances less), never widened.
   * Default 2000.
   */
  maxEventsPerTick?: number
  /** Block step per getLogs fetch while bounding by events. Default 1000. */
  fetchStepBlocks?: number
  /** Stop indexing at this block (inclusive). For fixed-range backfills + the smoke. */
  endBlock?: bigint
  /** Fingerprint of the config (chainId+contracts+events); the cursor is refused if it differs. */
  configFingerprint?: string
  /** Consecutive tick failures before the worker gives up (clean stop, no infinite wedge). Default 12. */
  maxConsecutiveFailures?: number
  /** Optional observability hook — fired with source/write/tick activity (for dashboards/telemetry). */
  onActivity?: (activity: IndexerActivity) => void
}

export interface TickResult {
  head: bigint
  safeHead: bigint
  /** Events seen this tick. */
  processed: number
  /** Entities actually created/updated (skips excluded). */
  written: number
  reorged: boolean
  /** True when the cursor reached the safe head (nothing more to do right now). */
  upToDate: boolean
  /** How many blocks behind the safe head we still are (safeHead − lastProcessed). 0 = caught up. */
  lagBlocks: bigint
}

export class Indexer {
  private readonly source: SourceAdapter
  private readonly sink: Sink
  private readonly map: EventMapper
  private readonly ttlSeconds: number
  private readonly cursorStore: CursorStore
  private readonly log: Logger
  private readonly confirmations: bigint
  private readonly pollIntervalMs: number
  private readonly reorgWindow: bigint
  private readonly maxBlocksPerTick: bigint
  private readonly maxEventsPerTick: number
  private readonly fetchStepBlocks: bigint
  private readonly fromBlock: bigint | number | 'latest'
  private readonly endBlock?: bigint
  private readonly configFingerprint?: string
  private readonly maxConsecutiveFailures: number
  private readonly onActivity?: (a: IndexerActivity) => void
  readonly cursorId: string

  private cursor: Cursor | null = null
  private stopRequested = false
  private initialized = false
  private sawEvents = false
  private hintShown = false
  private reconcileWarned = false

  constructor(opts: IndexerOptions) {
    this.source = opts.source
    this.sink = opts.sink
    this.map = opts.map
    this.ttlSeconds = opts.ttlSeconds
    this.cursorStore = opts.cursorStore
    this.log = opts.logger
    this.confirmations = BigInt(opts.confirmations ?? 5)
    // Clamp the poll interval: a literal 0 (which `?? 12000` would NOT catch) hot-loops the RPC.
    this.pollIntervalMs = Math.max(1000, opts.pollIntervalMs ?? 12_000)
    this.reorgWindow = BigInt(opts.reorgWindow ?? (opts.confirmations ?? 5) + 6)
    this.maxBlocksPerTick = BigInt(opts.maxBlocksPerTick ?? 5000)
    this.maxEventsPerTick = Math.max(1, opts.maxEventsPerTick ?? 2000)
    this.fetchStepBlocks = BigInt(Math.max(1, opts.fetchStepBlocks ?? 1000))
    this.fromBlock = opts.fromBlock ?? 'latest'
    this.endBlock = opts.endBlock
    this.configFingerprint = opts.configFingerprint
    this.maxConsecutiveFailures = Math.max(1, opts.maxConsecutiveFailures ?? 12)
    this.onActivity = opts.onActivity
    this.cursorId = `${opts.source.chainId}-${opts.cursorLabel}`
  }

  /** Preflight source + sink, then load or initialize the cursor. Safe to call once. */
  async init(): Promise<void> {
    if (this.initialized) return
    await this.source.preflight()
    await this.sink.init()

    const loaded = await this.cursorStore.load(this.cursorId)
    if (loaded) {
      // Refuse a cursor built for a different config — otherwise a contract/event change would
      // silently resume the wrong block range and mix data under the same `sync` id.
      if (
        this.configFingerprint &&
        loaded.configFingerprint &&
        loaded.configFingerprint !== this.configFingerprint
      ) {
        const safe = this.cursorId.replace(/[^a-zA-Z0-9_.-]/g, '_')
        throw new Error(
          `Cursor "${this.cursorId}" was built for a DIFFERENT config (contract, events, or chain changed). ` +
            `Reusing it would resume the wrong block range and mix data.\n` +
            `  → Delete .arkiv-sync/${safe}.json to re-index from scratch, or set a distinct \`label\` in your config.`,
        )
      }
      this.cursor = loaded
      // Adopt a fingerprint onto a pre-fingerprint cursor (forward-compatible upgrade).
      if (this.configFingerprint && !loaded.configFingerprint) loaded.configFingerprint = this.configFingerprint
      this.log.info(`resuming ${this.cursorId} from block ${loaded.lastProcessedBlock}`)
    } else {
      let start: bigint
      if (this.fromBlock === 'latest') {
        const head = await this.source.getHeadBlock()
        start = head - this.confirmations
      } else {
        start = BigInt(this.fromBlock)
        // Guard a fromBlock past the chain head — otherwise the worker silently waits forever for
        // blocks that do not exist yet (a common config/copy-paste mistake).
        const head = await this.source.getHeadBlock()
        if (start > head) {
          throw new Error(
            `fromBlock ${start} is beyond the current ${this.source.name} head ${head}. ` +
              `Use a block <= head, or 'latest' to index only new events.`,
          )
        }
      }
      if (start < 0n) start = 0n
      this.cursor = {
        chainId: this.source.chainId,
        lastProcessedBlock: start - 1n,
        blockHashes: {},
        configFingerprint: this.configFingerprint,
      }
      this.log.info(`starting ${this.cursorId} at block ${start}`)
    }
    if (!this.sink.reconcile && !this.reconcileWarned) {
      this.log.warn(`sink "${this.sink.name}" has no reorg reconciliation — orphaned events after a deep reorg may persist until TTL.`)
      this.reconcileWarned = true
    }
    this.initialized = true
  }

  /** Process one batch (reorg check + a bounded forward range). Returns stats. */
  async runOnce(): Promise<TickResult> {
    if (!this.cursor) throw new Error('Indexer.runOnce called before init().')
    const cursor = this.cursor

    const head = await this.source.getHeadBlock()
    let safeHead = head - this.confirmations
    if (this.endBlock !== undefined && this.endBlock < safeHead) safeHead = this.endBlock
    // 1) Reorg check FIRST — even when otherwise idle (caught up), so a reorg of already-processed
    //    blocks is caught promptly (not only once a new block arrives). detectReorg's getBlockHeader
    //    THROWS on an RPC error (→ tick retried) and returns null only for a genuinely-absent block,
    //    so a blip is never misread as a reorg.
    let reorged = false
    let recoverUntil = cursor.reorgRecoverUntil
    const reorg = await detectReorg(cursor, (n) => this.source.getBlockHeader(n))
    if (reorg.reorged) {
      reorged = true
      const oldTip = cursor.lastProcessedBlock
      // Reconcile everything from the ancestor up to the old tip (extend if a reorg hits mid-recovery).
      recoverUntil = recoverUntil !== undefined && recoverUntil > oldTip ? recoverUntil : oldTip
      this.log.warn(`reorg: rolling back to ${reorg.ancestor} (re-deriving up to ${recoverUntil})`)
      cursor.lastProcessedBlock = reorg.ancestor
      truncateAbove(cursor, reorg.ancestor)
    }

    // Idle: nothing safe to (re-)derive and no pending recovery.
    if (safeHead <= cursor.lastProcessedBlock && recoverUntil === undefined) {
      this.maybeHint(true)
      return { head, safeHead, processed: 0, written: 0, reorged, upToDate: true, lagBlocks: 0n }
    }

    // 2) Forward range (bounded per tick by BLOCKS).
    const fromB = cursor.lastProcessedBlock + 1n
    let toB = safeHead
    if (toB - fromB + 1n > this.maxBlocksPerTick) toB = fromB + this.maxBlocksPerTick - 1n

    // A pending recovery can persist while there are no new safe blocks yet (e.g. chain hasn't
    // re-grown). Save the rolled-back cursor + recovery boundary and wait for the next tick.
    if (toB < fromB) {
      cursor.reorgRecoverUntil = recoverUntil
      await this.cursorStore.save(this.cursorId, cursor)
      const lag = safeHead > cursor.lastProcessedBlock ? safeHead - cursor.lastProcessedBlock : 0n
      // A pending reorg recovery means we are NOT actually up to date (orphans still to clean once the
      // chain re-grows) — report it so a driver keeps ticking instead of idling on the poll interval.
      return { head, safeHead, processed: 0, written: 0, reorged, upToDate: recoverUntil === undefined, lagBlocks: lag }
    }

    // Fetch stepping through [fromB, toB], STOPPING early if we'd exceed maxEventsPerTick. This
    // bounds memory by event COUNT (block density is unbounded), SHRINKING the range rather than
    // widening it — the cursor then advances only to the last fully-fetched block.
    const events: NormalizedEvent[] = []
    let effectiveTo = fromB - 1n
    for (let step = fromB; step <= toB; ) {
      const end = step + this.fetchStepBlocks - 1n < toB ? step + this.fetchStepBlocks - 1n : toB
      const chunk = await this.source.getEvents(step, end)
      for (const e of chunk) events.push(e)
      effectiveTo = end
      step = end + 1n
      if (events.length >= this.maxEventsPerTick) break
    }
    toB = effectiveTo
    events.sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    )
    if (events.length) this.sawEvents = true

    if (this.onActivity && events.length) {
      this.onActivity({
        kind: 'source',
        fromBlock: fromB.toString(),
        toBlock: toB.toString(),
        count: events.length,
        events: events.slice(0, 100).map((e) => ({
          eventId: e.eventId,
          event: e.eventName,
          block: Number(e.blockNumber),
          tx: e.transactionHash,
          args: Object.fromEntries(
            Object.entries(e.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : String(v)]),
          ),
        })),
      })
    }

    const canonical = new Set<string>()
    const records: SinkRecord[] = []
    const removedIds: string[] = []
    for (const e of events) {
      canonical.add(e.eventId)
      if (e.removed) {
        removedIds.push(e.eventId)
        continue
      }
      const rec = this.buildRecord(e)
      if (rec) records.push(rec)
    }

    const written = await this.writeRecords(records)
    for (const id of removedIds) await this.sink.delete(id)

    // 3) Reorg reconciliation — delete orphaned events in the re-derived range. Correct across tick
    //    boundaries AND at any reorg depth (query-based, not window-bound).
    if (recoverUntil !== undefined) {
      const recoTo = toB < recoverUntil ? toB : recoverUntil
      if (recoTo >= fromB && this.sink.reconcile) {
        // Scope deletion to THIS indexer's own records (sync = cursorId).
        await this.sink.reconcile(fromB, recoTo, canonical, { sync: this.cursorId })
      }
      if (toB >= recoverUntil) recoverUntil = undefined
    }
    cursor.reorgRecoverUntil = recoverUntil

    // 4) Advance cursor + refresh the reorg window (block hashes), fetched in PARALLEL. A header
    //    fetch error throws here → the tick aborts BEFORE saving, so the cursor never advances on a
    //    partial window (the start() loop retries with backoff).
    cursor.lastProcessedBlock = toB
    const windowStart = toB - this.reorgWindow + 1n
    const lo = windowStart > 0n ? windowStart : 0n
    // Only fetch headers we don't already have — the window slides, so most are cached from the
    // prior tick (detectReorg already validated they're still canonical). Bounds RPC per tick.
    const nums: bigint[] = []
    for (let b = lo; b <= toB; b++) if (cursor.blockHashes[b.toString()] === undefined) nums.push(b)
    const headers = await Promise.all(nums.map((b) => this.source.getBlockHeader(b)))
    nums.forEach((b, i) => {
      const h = headers[i]
      if (h) cursor.blockHashes[b.toString()] = h.hash
    })
    pruneCursorWindow(cursor, lo)
    await this.cursorStore.save(this.cursorId, cursor)

    const upToDate = toB >= safeHead
    const lagBlocks = safeHead > toB ? safeHead - toB : 0n
    this.onActivity?.({
      kind: 'tick',
      head: head.toString(),
      safeHead: safeHead.toString(),
      lastProcessed: toB.toString(),
      lagBlocks: lagBlocks.toString(),
      processed: events.length,
      written,
      reorged,
    })
    this.maybeHint(upToDate)
    return { head, safeHead, processed: events.length, written, reorged, upToDate, lagBlocks }
  }

  /** Run until stop() is called. Transient tick errors are logged + retried (zero-friction). */
  async start(): Promise<void> {
    await this.init()
    this.stopRequested = false
    let backoff = 1000
    let failures = 0
    let lagWarned = false
    this.log.info(`indexing… (poll ${this.pollIntervalMs}ms, ${this.confirmations} confirmations)`)
    while (!this.stopRequested) {
      try {
        const r = await this.runOnce()
        backoff = 1000
        failures = 0
        if (r.written > 0 || r.reorged) {
          this.log.info(`block ${r.safeHead}: +${r.written} written${r.reorged ? ' (after reorg)' : ''}`)
        }
        // Lag observability: warn (once) when writes can't keep up with emission.
        if (r.lagBlocks > this.maxBlocksPerTick * 2n) {
          if (!lagWarned) {
            this.log.warn(`falling behind: ${r.lagBlocks} blocks behind the safe head — writes are slower than the chain emits.`)
            lagWarned = true
          }
        } else {
          lagWarned = false
        }
        await sleep(r.upToDate ? this.pollIntervalMs : 250)
      } catch (err) {
        failures++
        this.log.error(`tick failed (${failures}/${this.maxConsecutiveFailures}), retrying in ${backoff}ms`, scrubSecrets(err))
        if (failures >= this.maxConsecutiveFailures) {
          // Don't wedge forever (e.g. an unsplittable dense block or a dead RPC). Stop cleanly so an
          // orchestrator can restart/intervene instead of an invisible infinite-retry loop.
          this.log.error(`giving up after ${failures} consecutive failures — stopping. Check the RPC, contract, and config.`)
          this.stopRequested = true
          break
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
    this.log.info('indexer stopped.')
  }

  stop(): void {
    this.stopRequested = true
  }

  private async writeRecords(records: SinkRecord[]): Promise<number> {
    if (records.length === 0) return 0
    // Stream writes LIVE (per batch as each tx commits) so a UI doesn't look frozen during the
    // signing window, and the write rate is real-time rather than one burst at the end.
    let onWritten: WriteProgress | undefined
    let blockOf: Map<string, number> | undefined
    const emittedIds = new Set<string>()
    if (this.onActivity) {
      blockOf = new Map(records.map((r) => [r.eventId, Number(r.attributes.find((a) => a.key === 'block')?.value ?? 0)]))
      this.onActivity({ kind: 'writing', count: records.length })
      onWritten = (w) => {
        emittedIds.add(w.eventId)
        this.onActivity!({ kind: 'write', op: w.op, eventId: w.eventId, block: blockOf!.get(w.eventId) ?? 0, key: w.key, txHash: w.txHash })
      }
    }
    const results = this.sink.writeBatch
      ? await this.sink.writeBatch(records, onWritten)
      : await sequential(records, (r) => this.sink.write(r, onWritten))
    // Backfill: emit a write activity for any record the sink did NOT stream via onWritten (sinks
    // that ignore the callback, or deduped positions) — guarantees exactly one write activity per record.
    if (this.onActivity && blockOf) {
      records.forEach((rec, i) => {
        if (emittedIds.has(rec.eventId)) return
        const res = results[i]
        if (!res) return
        emittedIds.add(rec.eventId)
        this.onActivity!({ kind: 'write', op: res.op, eventId: rec.eventId, block: blockOf!.get(rec.eventId) ?? 0, key: res.key, txHash: res.txHash })
      })
    }
    return results.filter((r) => r.op !== 'skip').length
  }

  private maybeHint(upToDate: boolean): void {
    if (upToDate && !this.sawEvents && !this.hintShown) {
      this.hintShown = true
      this.log.info(
        'caught up but 0 events matched so far — if you expected some, double-check the event signature(s) ' +
          'match the contract exactly (indexed keywords included) and the contract address/chain are right.',
      )
    }
  }

  private buildRecord(e: NormalizedEvent): SinkRecord | null {
    const mapped = this.map(e)
    if (mapped === null) return null

    const userAttrs = mapped.attributes ?? {}
    const attributes: SinkRecord['attributes'] = [
      { key: 'eventId', value: e.eventId },
      { key: 'chainId', value: e.chainId },
      { key: 'contract', value: e.address },
      { key: 'event', value: e.eventName },
      { key: 'block', value: Number(e.blockNumber) },
      // Identifies THIS indexer instance, so reorg reconciliation only deletes our own records
      // (two indexers sharing one wallet must not clobber each other in an overlapping block range).
      { key: 'sync', value: this.cursorId },
    ]
    for (const [key, raw] of Object.entries(userAttrs)) {
      if (RESERVED_ATTRS.has(key)) {
        throw new Error(
          `Mapper attribute "${key}" is reserved by Arkiv Sync (${[...RESERVED_ATTRS].join(', ')}). Rename it.`,
        )
      }
      // Coerce bigint → string defensively (Arkiv attribute values are string|number).
      const value = typeof raw === 'bigint' ? (raw as bigint).toString() : raw
      attributes.push({ key, value })
    }

    const payload =
      mapped.data ?? {
        event: e.eventName,
        chainId: e.chainId,
        contract: e.address,
        block: Number(e.blockNumber),
        blockHash: e.blockHash,
        tx: e.transactionHash,
        logIndex: e.logIndex,
        args: e.args,
      }

    return {
      eventId: e.eventId,
      attributes,
      payload,
      expiresInSeconds: mapped.ttlSeconds ?? this.ttlSeconds,
    }
  }
}

async function sequential<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (const it of items) out.push(await fn(it))
  return out
}
