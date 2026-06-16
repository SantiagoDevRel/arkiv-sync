/**
 * Arkiv Sync — point it at any contract on any EVM chain and turn its on-chain events into a
 * queryable Arkiv database. Library-first: this module is the engine. The CLI, the skill, and
 * the template all sit on top of it.
 */

// Declarative config — the main entry point for most users.
export {
  defineConfig,
  createIndexer,
  quickCheck,
  normalizeAddresses,
  type ArkivSyncConfig,
  type IndexerOverrides,
  type QuickCheckResult,
} from './config.js'

// Core engine (for programmatic / advanced use).
export { Indexer, type IndexerOptions, type TickResult, type IndexerActivity } from './core/indexer.js'
export { FileCursorStore, MemoryCursorStore } from './core/cursor.js'
export { detectReorg, pruneCursorWindow, truncateAbove, type ReorgResult } from './core/reorg.js'

// Source (read side) — swap/extend per chain.
export { EvmSource, type EvmSourceOptions } from './source/evmSource.js'
export { SOURCE_CHAINS, resolveSourceChain, type SourceChainDef } from './source/chains.js'
export { buildReadTransport } from './source/rpcPool.js'

// Sink (write side) — Arkiv today, swappable by design.
export {
  ArkivSink,
  type ArkivSinkOptions,
  type ArkivNetwork,
  BRAGA_NETWORK,
  assertWritableChain,
} from './sink/arkivSink.js'
export {
  createArkivReader,
  type ArkivReader,
  type DecodedEntity,
  type QueryParams,
  type ArkivReaderOptions,
} from './sink/arkivQuery.js'

// Safe predicate builders — for consumers composing queries from (untrusted) values.
export { quoteValue, assertSafePredicate, assertSafeOwner } from './sink/predicate.js'

// Helpers.
export { seconds, minutes, hours, days, weeks, describeSeconds } from './time.js'
export { createLogger, silentLogger } from './log.js'
export { eventId } from './util.js'

// Types.
export type {
  Hex,
  NormalizedEvent,
  BlockHeader,
  SourceAdapter,
  Sink,
  SinkRecord,
  WriteResult,
  WriteOp,
  WriteProgress,
  EventMapper,
  MappedEntity,
  Cursor,
  CursorStore,
  Logger,
  LogLevel,
} from './types.js'
