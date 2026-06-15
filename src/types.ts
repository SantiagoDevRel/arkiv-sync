/**
 * Arkiv Sync — shared types.
 *
 * The mental model: a SOURCE (any EVM chain) emits on-chain EVENTS; Arkiv Sync
 * normalizes each event and writes it to a SINK (Arkiv) as a queryable entity.
 * Arkiv is a DERIVED VIEW — the chain is the source of truth, so the whole view
 * can always be re-derived (this is what makes reorgs and restarts safe).
 *
 * Two seams keep it multichain + multi-sink:
 *   - SourceAdapter: where events come from (Sepolia today; Base/Arbitrum = a new adapter).
 *   - Sink:          where the derived view lives (Arkiv today; swappable by design,
 *                    because Braga will be decommissioned).
 */

export type Hex = `0x${string}`

/** A single on-chain event, normalized to a chain-agnostic shape. */
export interface NormalizedEvent {
  /** Idempotency key: `${chainId}:${transactionHash}:${logIndex}` — globally unique per log. */
  eventId: string
  chainId: number
  /** Emitting contract address (lowercased). */
  address: Hex
  /** Decoded event name, e.g. "Transfer". */
  eventName: string
  /** Decoded, named arguments. BigInts are kept as bigint; callers serialize them. */
  args: Record<string, unknown>
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  logIndex: number
  /** True if the node flagged this log as removed (reorg). */
  removed: boolean
}

/** A block header — the minimum the reorg detector needs. */
export interface BlockHeader {
  number: bigint
  hash: Hex
  parentHash: Hex
}

/**
 * SourceAdapter: reads events from one chain. Implementations hide RPC choice,
 * rotation, and decoding. The core indexer only ever talks to this interface, so
 * adding a chain = writing one adapter + a config entry; the core never changes.
 */
export interface SourceAdapter {
  readonly chainId: number
  readonly name: string
  /** Latest block number the chain knows about. */
  getHeadBlock(): Promise<bigint>
  /** Header for one block (for reorg continuity checks). Null if not found. */
  getBlockHeader(blockNumber: bigint): Promise<BlockHeader | null>
  /** Normalized events for the configured contract(s)+events in [fromBlock, toBlock]. */
  getEvents(fromBlock: bigint, toBlock: bigint): Promise<NormalizedEvent[]>
  /** Verify connectivity + that the RPC actually serves this chainId. Throws a human error if not. */
  preflight(): Promise<void>
}

/** What a Sink stores for one event. Attribute values are string|number (Arkiv constraint). */
export interface SinkRecord {
  eventId: string
  attributes: { key: string; value: string | number }[]
  /** Decoded payload (JSON-serializable). */
  payload: unknown
  contentType?: string
  /** Lifetime in SECONDS before the sink may delete it. Arkiv expiry is in seconds. */
  expiresInSeconds: number
}

export type WriteOp = 'create' | 'update' | 'skip'

export interface WriteResult {
  op: WriteOp
  /** Sink-native id for the stored record (Arkiv entity key). */
  key?: string
  /** On-chain tx hash of the write, if the sink is on-chain. */
  txHash?: string
  /** Cost of the write in wei, if measurable. */
  costWei?: bigint
}

/**
 * Sink: where the derived view is written. Arkiv today; the interface is deliberately
 * small so a Postgres/SQLite/file sink is a drop-in replacement (Braga is temporary).
 */
export interface Sink {
  readonly name: string
  /** Preflight: connectivity + (for on-chain sinks) a funded-wallet balance check. Throws human errors. */
  init(): Promise<void>
  /** Idempotent write: create if new, full-replace if the eventId exists and changed, else skip. */
  write(record: SinkRecord): Promise<WriteResult>
  /**
   * Optional batched write — one transaction for many records (huge throughput + cost win on
   * busy contracts). If absent, the indexer falls back to write() per record.
   */
  writeBatch?(records: SinkRecord[]): Promise<WriteResult[]>
  /** Remove the record for an orphaned event (used when a reorg drops a log). */
  delete(eventId: string): Promise<void>
  /**
   * Optional reorg reconciliation: delete the sink's own records in block range [fromBlock,toBlock]
   * whose eventId is NOT in `keep` (the canonical set just re-derived). Returns how many were
   * deleted. This is what removes orphaned events after a reorg, at ANY depth. A sink that can't
   * support it (no block-range query) may omit it — the indexer warns that reorg cleanup is limited.
   */
  reconcile?(fromBlock: bigint, toBlock: bigint, keep: Set<string>): Promise<number>
  /** Optional: per-write cost accounting summary, for the cost/event metric. */
  costSummary?(): { writes: number; totalWei: bigint } | undefined
}

/**
 * EventMapper: the only thing an app author writes per event — how to shape an entity.
 * Return null to SKIP an event. The indexer always adds the system attributes
 * (eventId, chainId, contract, event, block); `attributes` here are extra, queryable
 * fields (e.g. from/to for a Transfer). `data` overrides the stored payload (defaults to args).
 */
export type MappedEntity = {
  attributes?: Record<string, string | number>
  data?: unknown
  /** Override the default TTL for this specific event, in seconds. */
  ttlSeconds?: number
} | null

export type EventMapper = (event: NormalizedEvent) => MappedEntity

/** Persisted indexing position, so the worker resumes exactly where it stopped. */
export interface Cursor {
  chainId: number
  /** Highest block fully processed and written. */
  lastProcessedBlock: bigint
  /** Recent blockNumber→hash, for reorg continuity. Kept to a bounded window. */
  blockHashes: Record<string, Hex>
  /**
   * If set, the indexer is recovering from a reorg and must reconcile (delete orphaned events in)
   * every re-derived block up to and including this block. Persisted so recovery survives a restart
   * and spans as many ticks as a deep reorg needs.
   */
  reorgRecoverUntil?: bigint
}

export interface CursorStore {
  load(id: string): Promise<Cursor | null>
  save(id: string, cursor: Cursor): Promise<void>
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}
