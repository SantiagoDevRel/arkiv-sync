import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Hex } from 'viem'
import type { WriteState } from './writeOperation.js'

export interface JournalTarget {
  kind: 'upsert' | 'delete' | 'extend'
  key?: Hex
  eventId?: string
  sync?: string
  contentHash?: string
  minLifetime?: string
  expiresAt?: string
}
export interface JournalEntry {
  id: string
  state: WriteState
  attempts: number
  txHash?: Hex
  gas?: string
  nonce?: number
  sdkAcknowledged?: boolean
  result?: unknown
  targets: JournalTarget[]
}
export interface WriteJournal {
  entries(namespace: string): Promise<JournalEntry[]>
  save(namespace: string, entry: JournalEntry): Promise<void>
}

/** Durable operation state beside the source checkpoint. Never contains signer/RPC secrets.
 * One process-wide signer queue protects read/modify/write. Across processes use one writer/key. */
export class FileWriteJournal implements WriteJournal {
  constructor(readonly directory = '.arkiv-sync') {}
  private file(namespace: string): string {
    return path.join(this.directory, `writes-${createHash('sha256').update(namespace).digest('hex')}.json`)
  }
  async entries(namespace: string): Promise<JournalEntry[]> {
    let text: string
    try { text = await fs.readFile(this.file(namespace), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const parsed = JSON.parse(text)
    if (parsed.version !== 1 || parsed.namespace !== namespace || !Array.isArray(parsed.entries)) throw new Error('Invalid write journal; reconcile before continuing.')
    for (const entry of parsed.entries) {
      if (!entry.id || !Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > 2 || !Array.isArray(entry.targets) ||
          !['idle', 'sending', 'submitted', 'confirmed', 'pending', 'uncertain', 'failed', 'retryable'].includes(entry.state)) throw new Error('Invalid journal operation; refusing writes.')
    }
    return parsed.entries
  }
  async save(namespace: string, entry: JournalEntry): Promise<void> {
    const entries = await this.entries(namespace)
    const index = entries.findIndex(value => value.id === entry.id)
    if (index < 0) entries.push(structuredClone(entry)); else entries[index] = structuredClone(entry)
    await fs.mkdir(this.directory, { recursive: true })
    const filename = this.file(namespace), temporary = `${filename}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ version: 1, namespace, entries })); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(temporary, filename)
    // Persist the rename on systems supporting directory fsync; unsupported Windows directory
    // handles do not weaken the completed file fsync + atomic rename.
    let directory
    try { directory = await fs.open(this.directory, 'r'); await directory.sync() }
    catch (error) { if (process.platform !== 'win32') throw error }
    finally { await directory?.close() }
  }
}

/** Explicitly ephemeral implementation for deterministic tests. Never the production default. */
export class MemoryWriteJournal implements WriteJournal {
  private values = new Map<string, Map<string, JournalEntry>>()
  async entries(namespace: string): Promise<JournalEntry[]> { return structuredClone([...this.values.get(namespace)?.values() ?? []]) }
  async save(namespace: string, entry: JournalEntry): Promise<void> {
    const values = this.values.get(namespace) ?? new Map<string, JournalEntry>()
    values.set(entry.id, structuredClone(entry)); this.values.set(namespace, values)
  }
}
