import { createHash } from 'node:crypto'
import { parseAbiItem, type AbiEvent } from 'viem'
import type { CursorStore, EventMapper, Hex, Logger, Sink, SourceAdapter } from './types.js'
import { days } from './time.js'
import { createLogger } from './log.js'
import { EvmSource } from './source/evmSource.js'
import type { SourceChainDef } from './source/chains.js'
import { ArkivSink } from './sink/arkivSink.js'
import { createArkivReader, type DecodedEntity } from './sink/arkivQuery.js'
import { FileCursorStore, MemoryCursorStore } from './core/cursor.js'
import { Indexer, type IndexerActivity } from './core/indexer.js'

/**
 * The declarative config — the ONLY thing most users write. Point it at a contract + events,
 * say how to shape each event, and you have a queryable Arkiv database. Adding another contract
 * or chain is just another config; the engine never changes.
 */
export interface ArkivSyncConfig {
  source: {
    /** 'sepolia' (built-in) or a chain definition for any other EVM chain. */
    chain: string | SourceChainDef
    /** Contract address(es) to index. */
    contract: string | string[]
    /**
     * Human event signatures to decode, e.g.
     *   'Transfer(address indexed from, address indexed to, uint256 value)'
     * The leading "event " keyword is optional.
     */
    events: string[]
    /** Where to begin: a block number, or 'latest' (only new events). Default 'latest'. */
    fromBlock?: bigint | number | 'latest'
    /** Stay this many blocks behind the head before treating data as final. Default 5. */
    confirmations?: number
    /** Poll cadence when caught up (ms). Default 12000. */
    pollIntervalMs?: number
    /** Max blocks per getLogs request (auto-splits on RPC limits). Default 2000. */
    batchSize?: number
    /** Hard cap on events processed per tick — bounds memory under busy contracts. Default 2000. */
    maxEventsPerTick?: number
    /** Your own RPC URL(s). If unset, a public pool with rotation is used. */
    rpcUrls?: string[]
  }
  /** Default entity TTL in SECONDS — use the time helpers (e.g. days(30)). Default days(30). */
  ttlSeconds?: number
  /**
   * Map each event → entity. Return null to SKIP. Omit to index every event raw.
   * `attributes` become queryable fields; `data` overrides the stored payload.
   */
  map?: EventMapper
  /** Override the sink. Default: Arkiv (Braga), signing locally with PRIVATE_KEY from env. */
  sink?: Sink
  /** Cursor namespace label. Default: derived from the first contract address. */
  label?: string
  logger?: Logger
}

/** Identity helper that gives full type-checking + editor autocomplete on a config object. */
export function defineConfig(config: ArkivSyncConfig): ArkivSyncConfig {
  return config
}

export interface IndexerOverrides {
  fromBlock?: bigint | number | 'latest'
  endBlock?: bigint
  confirmations?: number
  reorgWindow?: number
  cursorStore?: CursorStore
  /** Reuse an already-built source/sink instead of constructing from config (avoids double init). */
  source?: SourceAdapter
  sink?: Sink
  /** Observability hook — source/write/tick activity (for dashboards/telemetry). */
  onActivity?: (a: IndexerActivity) => void
}

function parseEvents(signatures: string[]): AbiEvent[] {
  if (!signatures?.length) throw new Error('config.source.events is empty — list at least one event signature.')
  return signatures.map((sig) => {
    const normalized = sig.trim().startsWith('event ') ? sig.trim() : `event ${sig.trim()}`
    let item
    try {
      item = parseAbiItem(normalized)
    } catch {
      throw new Error(`Could not parse event signature "${sig}". Example: 'Transfer(address indexed from, address indexed to, uint256 value)'.`)
    }
    if (item.type !== 'event') throw new Error(`"${sig}" is not an event signature.`)
    return item as AbiEvent
  })
}

export function normalizeAddresses(contract: string | string[]): Hex[] {
  const list = Array.isArray(contract) ? contract : [contract]
  if (!list.length) throw new Error('config.source.contract is required (a contract address).')
  return list.map((a) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.trim())) {
      throw new Error(`"${a}" is not a valid contract address (expected 0x + 40 hex chars).`)
    }
    return a.trim().toLowerCase() as Hex
  })
}

function buildSource(config: ArkivSyncConfig, logger: Logger): EvmSource {
  return new EvmSource({
    chain: config.source.chain,
    addresses: normalizeAddresses(config.source.contract),
    events: parseEvents(config.source.events),
    rpcUrls: config.source.rpcUrls ?? envRpcUrls(),
    batchSize: config.source.batchSize,
    logger,
  })
}

function buildSink(config: ArkivSyncConfig, logger: Logger): Sink {
  if (config.sink) return config.sink
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'PRIVATE_KEY is not set. Copy .env.example to .env and add a THROWAWAY testnet key ' +
        'funded at https://braga.hoodi.arkiv.network/faucet/ — or pass a custom `sink` in config.',
    )
  }
  return new ArkivSink({ privateKey, rpcUrl: process.env.ARKIV_RPC_URL, logger })
}

/**
 * Build a ready-to-run Indexer from a declarative config. The CLI calls this; you can too.
 * `overrides` lets advanced callers pin the range (fixed backfill), confirmations, or cursor store.
 */
export function createIndexer(config: ArkivSyncConfig, overrides: IndexerOverrides = {}): Indexer {
  const logger = config.logger ?? createLogger()
  const source = overrides.source ?? buildSource(config, logger)
  const sink = overrides.sink ?? buildSink(config, logger)
  const map: EventMapper = config.map ?? (() => ({}))
  const label = config.label ?? normalizeAddresses(config.source.contract)[0]!

  return new Indexer({
    source,
    sink,
    map,
    ttlSeconds: config.ttlSeconds ?? days(30),
    cursorStore: overrides.cursorStore ?? new FileCursorStore(),
    logger,
    cursorLabel: label,
    confirmations: overrides.confirmations ?? config.source.confirmations,
    pollIntervalMs: config.source.pollIntervalMs,
    fromBlock: overrides.fromBlock ?? config.source.fromBlock,
    reorgWindow: overrides.reorgWindow,
    endBlock: overrides.endBlock,
    maxEventsPerTick: config.source.maxEventsPerTick,
    configFingerprint: computeConfigFingerprint(config),
    onActivity: overrides.onActivity,
  })
}

/** Stable fingerprint of what defines a cursor's data: chain + contracts + event signatures. */
function computeConfigFingerprint(config: ArkivSyncConfig): string {
  const chain = typeof config.source.chain === 'string' ? config.source.chain : String(config.source.chain.chain.id)
  const contracts = normalizeAddresses(config.source.contract).slice().sort()
  const events = config.source.events.map((s) => s.trim()).slice().sort()
  return createHash('sha256').update(JSON.stringify({ chain, contracts, events })).digest('hex').slice(0, 16)
}

export interface QuickCheckResult {
  ok: boolean
  reason?: string
  /** The source block that was indexed for the check. */
  window?: bigint
  written: number
  queried: number
  sample: DecodedEntity[]
  spent?: { spentGlm: number; writes: number; perWriteGlm: number }
}

/**
 * "Does my setup work?" — a bounded, real end-to-end check: scan recent source blocks for a small
 * batch of events, index exactly that block into Arkiv, then query it back. Uses the DEFAULT Arkiv
 * sink (needs PRIVATE_KEY). Great as a `npm run verify`, a smoke test, and a friction sensor.
 */
export async function quickCheck(
  config: ArkivSyncConfig,
  opts: { scanBlocks?: number; maxEvents?: number } = {},
): Promise<QuickCheckResult> {
  const logger = config.logger ?? createLogger()
  const source = buildSource(config, logger)
  const sink = buildSink(config, logger)
  if (!(sink instanceof ArkivSink)) {
    throw new Error('quickCheck requires the default Arkiv sink (do not pass a custom `sink`).')
  }

  await source.preflight() // needed to scan; the indexer re-checks on init()
  const head = await source.getHeadBlock()
  const scanBlocks = BigInt(opts.scanBlocks ?? 4000)
  const maxEvents = opts.maxEvents ?? 8

  let target: bigint | null = null
  for (let b = head - 6n; b > head - scanBlocks && b >= 0n; b--) {
    const got = await source.getEvents(b, b)
    if (got.length >= 1 && got.length <= maxEvents) {
      target = b
      break
    }
  }
  if (target === null) {
    return { ok: false, reason: `no matching events in the last ${scanBlocks} blocks — check the contract + event signature`, written: 0, queried: 0, sample: [] }
  }
  logger.info(`quickCheck window: block ${target}`)

  // Reuse the SAME source + sink (one init, accurate cost accounting).
  const indexer = createIndexer(config, {
    source,
    sink,
    fromBlock: target,
    endBlock: target,
    confirmations: 0,
    reorgWindow: 2,
    cursorStore: new MemoryCursorStore(),
  })
  await indexer.init()
  let written = 0
  for (let i = 0; i < 20; i++) {
    const r = await indexer.runOnce()
    written += r.written
    if (r.upToDate) break
  }

  const contract = normalizeAddresses(config.source.contract)[0]!
  const reader = createArkivReader({ rpcUrl: process.env.ARKIV_RPC_URL })
  const sample = await reader.query(`contract = "${contract}"`, {
    owner: sink.address,
    limit: 25,
    sortBy: 'block',
    sortDir: 'desc',
  })
  const spent = await sink.spendReport()

  return {
    ok: written >= 1 && sample.length >= 1,
    window: target,
    written,
    queried: sample.length,
    sample,
    spent,
  }
}

/** Pull a single Sepolia RPC override from env (the rest of the pool still applies as fallback). */
function envRpcUrls(): string[] | undefined {
  const url = process.env.SEPOLIA_RPC_URL
  return url ? [url] : undefined
}
