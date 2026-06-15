import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Cursor, CursorStore, Hex } from '../types.js'

/**
 * File-backed cursor store. The cursor is what makes the worker resume EXACTLY where it
 * stopped after a restart/crash — it persists the last processed block, a small window of
 * block hashes (for reorg detection), and any in-progress reorg recovery boundary.
 *
 * It's a derived artifact: deleting `.arkiv-sync/` just forces a re-index from the configured
 * start block. The chain remains the source of truth.
 */
export class FileCursorStore implements CursorStore {
  constructor(private readonly dir: string = '.arkiv-sync') {}

  private file(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '_')
    return path.join(this.dir, `${safe}.json`)
  }

  async load(id: string): Promise<Cursor | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(id), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = JSON.parse(raw) as {
      chainId: number
      lastProcessedBlock: string
      blockHashes: Record<string, Hex>
      reorgRecoverUntil?: string | null
    }
    return {
      chainId: parsed.chainId,
      lastProcessedBlock: BigInt(parsed.lastProcessedBlock),
      blockHashes: parsed.blockHashes ?? {},
      reorgRecoverUntil:
        parsed.reorgRecoverUntil != null ? BigInt(parsed.reorgRecoverUntil) : undefined,
    }
  }

  async save(id: string, cursor: Cursor): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const serializable = {
      chainId: cursor.chainId,
      lastProcessedBlock: cursor.lastProcessedBlock.toString(),
      blockHashes: cursor.blockHashes,
      reorgRecoverUntil: cursor.reorgRecoverUntil != null ? cursor.reorgRecoverUntil.toString() : null,
    }
    // Write-then-rename for atomicity: a crash mid-write can't corrupt the cursor.
    const target = this.file(id)
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, JSON.stringify(serializable, null, 2), 'utf8')
    await fs.rename(tmp, target)
  }
}

/** In-memory cursor store — for tests. */
export class MemoryCursorStore implements CursorStore {
  private map = new Map<string, Cursor>()
  async load(id: string): Promise<Cursor | null> {
    return this.map.get(id) ?? null
  }
  async save(id: string, cursor: Cursor): Promise<void> {
    this.map.set(id, { ...cursor, blockHashes: { ...cursor.blockHashes } })
  }
}
