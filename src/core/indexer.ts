import type {
  Cursor,
  CursorStore,
  EventMapper,
  Logger,
  NormalizedEvent,
  Sink,
  SinkRecord,
  SourceAdapter,
} from '../types.js'
import { sleep, scrubSecrets } from '../util.js'
import { detectReorg, pruneCursorWindow, truncateAbove } from './reorg.js'

/** Attribute keys the indexer sets itself — a mapper may not override them. */
const RESERVED_ATTRS = new Set(['eventId', 'contentHash', 'chainId', 'contract', 'event', 'block', 'sync'])

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
  /** Max blocks advanced per tick, to bound memory during backfill. Default 5000. */
  maxBlocksPerTick?: number
  /** Stop indexing at this block (inclusive). For fixed-range backfills + the smoke. */
  endBlock?: bigint
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
  private readonly fromBlock: bigint | number | 'latest'
  private readonly endBlock?: bigint
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
    this.pollIntervalMs = opts.pollIntervalMs ?? 12_000
    this.reorgWindow = BigInt(opts.reorgWindow ?? (opts.confirmations ?? 5) + 6)
    this.maxBlocksPerTick = BigInt(opts.maxBlocksPerTick ?? 5000)
    this.fromBlock = opts.fromBlock ?? 'latest'
    this.endBlock = opts.endBlock
    this.cursorId = `${opts.source.chainId}-${opts.cursorLabel}`
  }

  /** Preflight source + sink, then load or initialize the cursor. Safe to call once. */
  async init(): Promise<void> {
    if (this.initialized) return
    await this.source.preflight()
    await this.sink.init()

    const loaded = await this.cursorStore.load(this.cursorId)
    if (loaded) {
      this.cursor = loaded
      this.log.info(`resuming ${this.cursorId} from block ${loaded.lastProcessedBlock}`)
    } else {
      let start: bigint
      if (this.fromBlock === 'latest') {
        const head = await this.source.getHeadBlock()
        start = head - this.confirmations
      } else {
        start = BigInt(this.fromBlock)
      }
      if (start < 0n) start = 0n
      this.cursor = {
        chainId: this.source.chainId,
        lastProcessedBlock: start - 1n,
        blockHashes: {},
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
      return { head, safeHead, processed: 0, written: 0, reorged, upToDate: true }
    }

    // 2) Forward range (bounded per tick).
    const fromB = cursor.lastProcessedBlock + 1n
    let toB = safeHead
    if (toB - fromB + 1n > this.maxBlocksPerTick) toB = fromB + this.maxBlocksPerTick - 1n

    // A pending recovery can persist while there are no new safe blocks yet (e.g. chain hasn't
    // re-grown). Save the rolled-back cursor + recovery boundary and wait for the next tick.
    if (toB < fromB) {
      cursor.reorgRecoverUntil = recoverUntil
      await this.cursorStore.save(this.cursorId, cursor)
      return { head, safeHead, processed: 0, written: 0, reorged, upToDate: true }
    }

    const events = await this.source.getEvents(fromB, toB)
    events.sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    )
    if (events.length) this.sawEvents = true

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
    const nums: bigint[] = []
    for (let b = lo; b <= toB; b++) nums.push(b)
    const headers = await Promise.all(nums.map((b) => this.source.getBlockHeader(b)))
    nums.forEach((b, i) => {
      const h = headers[i]
      if (h) cursor.blockHashes[b.toString()] = h.hash
    })
    pruneCursorWindow(cursor, lo)
    await this.cursorStore.save(this.cursorId, cursor)

    const upToDate = toB >= safeHead
    this.maybeHint(upToDate)
    return { head, safeHead, processed: events.length, written, reorged, upToDate }
  }

  /** Run until stop() is called. Transient tick errors are logged + retried (zero-friction). */
  async start(): Promise<void> {
    await this.init()
    this.stopRequested = false
    let backoff = 1000
    this.log.info(`indexing… (poll ${this.pollIntervalMs}ms, ${this.confirmations} confirmations)`)
    while (!this.stopRequested) {
      try {
        const r = await this.runOnce()
        backoff = 1000
        if (r.written > 0 || r.reorged) {
          this.log.info(`block ${r.safeHead}: +${r.written} written${r.reorged ? ' (after reorg)' : ''}`)
        }
        await sleep(r.upToDate ? this.pollIntervalMs : 250)
      } catch (err) {
        this.log.error(`tick failed, retrying in ${backoff}ms`, scrubSecrets(err))
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
    const results = this.sink.writeBatch
      ? await this.sink.writeBatch(records)
      : await sequential(records, (r) => this.sink.write(r))
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
