import type { BlockHeader, Cursor } from '../types.js'

export interface ReorgResult {
  reorged: boolean
  /** Highest block whose stored hash still matches the live chain. Re-derive from ancestor+1. */
  ancestor: bigint
  /** Stored block numbers that were orphaned by the reorg (block > ancestor). */
  orphanedBlocks: bigint[]
}

const descBn = (a: bigint, b: bigint) => (a < b ? 1 : a > b ? -1 : 0)
const ascBn = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Detect a chain reorganization by comparing the block hashes we recorded against what the
 * chain reports now, walking from the tip downward until a stored hash still matches (the
 * common ancestor). Everything above the ancestor was orphaned and must be re-derived.
 *
 * `getHeader` is injected so this is pure + unit-testable. IMPORTANT: `getHeader` must throw on a
 * transient RPC error (so the caller retries) and return null ONLY for a genuinely absent block —
 * otherwise a momentary RPC blip would be misread as a reorg. In the common no-reorg case this
 * does exactly ONE header fetch (the tip matches → early return).
 */
export async function detectReorg(
  cursor: Cursor,
  getHeader: (blockNumber: bigint) => Promise<BlockHeader | null>,
): Promise<ReorgResult> {
  const blockNums = Object.keys(cursor.blockHashes).map((n) => BigInt(n)).sort(descBn)
  if (blockNums.length === 0) {
    return { reorged: false, ancestor: cursor.lastProcessedBlock, orphanedBlocks: [] }
  }

  const orphaned: bigint[] = []
  for (const n of blockNums) {
    const stored = cursor.blockHashes[n.toString()]
    const header = await getHeader(n)
    if (header && stored && header.hash.toLowerCase() === stored.toLowerCase()) {
      return { reorged: orphaned.length > 0, ancestor: n, orphanedBlocks: orphaned.sort(ascBn) }
    }
    orphaned.push(n)
  }

  // No stored hash matched → the reorg is deeper than our recorded window. Re-derive from below
  // the lowest block we have; reconciliation (query-based) cleans up orphans at any depth.
  const lowest = blockNums[blockNums.length - 1]!
  return { reorged: true, ancestor: lowest - 1n, orphanedBlocks: orphaned.sort(ascBn) }
}

/** Drop recorded block hashes below `keepFrom`, keeping the detection window bounded. */
export function pruneCursorWindow(cursor: Cursor, keepFrom: bigint): void {
  for (const k of Object.keys(cursor.blockHashes)) {
    if (BigInt(k) < keepFrom) delete cursor.blockHashes[k]
  }
}

/** Forget recorded block hashes above `ancestor` (used when rolling back a reorg). */
export function truncateAbove(cursor: Cursor, ancestor: bigint): void {
  for (const k of Object.keys(cursor.blockHashes)) {
    if (BigInt(k) > ancestor) delete cursor.blockHashes[k]
  }
}
