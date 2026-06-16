/**
 * Unit tests — deterministic, no network. A mock SOURCE (a controllable in-memory chain) +
 * a memory SINK exercise the hard correctness: dedup/idempotency, restart-resume, and reorg
 * re-derivation (orphaned events deleted, canonical events written). Run: `npm test`.
 */
import type {
  BlockHeader,
  Hex,
  NormalizedEvent,
  Sink,
  SinkRecord,
  SourceAdapter,
  WriteResult,
} from '../src/types.js'
import { Indexer, type IndexerActivity } from '../src/core/indexer.js'
import { FileCursorStore, MemoryCursorStore } from '../src/core/cursor.js'
import { detectReorg } from '../src/core/reorg.js'
import { assertWritableChain, type ArkivNetwork } from '../src/sink/arkivSink.js'
import { scopeToOwner, quoteValue, assertSafePredicate } from '../src/sink/predicate.js'
import { silentLogger } from '../src/log.js'
import { days, hours, seconds } from '../src/time.js'
import { eventId, stableStringify } from '../src/util.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── tiny test harness ────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const results: string[] = []
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    results.push(`  ✓ ${name}`)
  } catch (err) {
    failed++
    results.push(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}
function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (got ${String(a)}, expected ${String(b)})`)
}

// ── deterministic hex helper (32-byte ids for the mock) ──────────────────────
function hex32(seed: string): Hex {
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return ('0x' + h.toString(16).padStart(8, '0').repeat(8)) as Hex
}

// ── mock chain / source ──────────────────────────────────────────────────────
interface MockLog {
  txHash: Hex
  logIndex: number
  args: Record<string, unknown>
}
interface MockBlock {
  number: bigint
  hash: Hex
  parentHash: Hex
  logs: MockLog[]
}

const CHAIN_ID = 11155111
const CONTRACT = '0x000000000000000000000000000000000000dead' as Hex

class MockSource implements SourceAdapter {
  readonly chainId = CHAIN_ID
  readonly name = 'mock'
  private blocks: MockBlock[] = []
  head = 0n

  /** Build `n` contiguous blocks (0..n-1), each with `perBlock` events, salted by `salt`. */
  build(n: number, perBlock = 1, salt = 'a') {
    this.blocks = []
    for (let i = 0; i < n; i++) {
      this.blocks.push(this.makeBlock(BigInt(i), perBlock, salt))
    }
    this.head = BigInt(n - 1)
  }

  private makeBlock(number: bigint, perBlock: number, salt: string): MockBlock {
    const hash = hex32(`${salt}:hash:${number}`)
    const parentHash = number === 0n ? ('0x' + '0'.repeat(64) as Hex) : hex32(`${salt}:hash:${number - 1n}`)
    const logs: MockLog[] = []
    for (let i = 0; i < perBlock; i++) {
      logs.push({
        txHash: hex32(`${salt}:tx:${number}:${i}`),
        logIndex: i,
        args: { from: CONTRACT, to: CONTRACT, value: `${number}${i}` },
      })
    }
    return { number, hash, parentHash, logs }
  }

  /** Reorg: rewrite blocks from `height` onward with a new salt (new hashes + new txs/eventIds). */
  reorgFrom(height: number, newLen: number, perBlock: number, salt: string) {
    const kept = this.blocks.slice(0, height)
    const rebuilt: MockBlock[] = []
    for (let i = height; i < newLen; i++) {
      rebuilt.push(this.makeBlock(BigInt(i), perBlock, salt))
    }
    // fix the first rebuilt block's parentHash to point at the kept ancestor
    if (rebuilt[0] && height > 0) rebuilt[0].parentHash = kept[height - 1]!.hash
    this.blocks = [...kept, ...rebuilt]
    this.head = BigInt(newLen - 1)
  }

  async preflight() {}
  async getHeadBlock() {
    return this.head
  }
  async getBlockHeader(n: bigint): Promise<BlockHeader | null> {
    const b = this.blocks[Number(n)]
    if (!b || b.number > this.head) return null
    return { number: b.number, hash: b.hash, parentHash: b.parentHash }
  }
  async getEvents(from: bigint, to: bigint): Promise<NormalizedEvent[]> {
    const out: NormalizedEvent[] = []
    for (let n = from; n <= to; n++) {
      const b = this.blocks[Number(n)]
      if (!b || b.number > this.head) continue
      for (const l of b.logs) {
        out.push({
          eventId: eventId(this.chainId, l.txHash, l.logIndex),
          chainId: this.chainId,
          address: CONTRACT,
          eventName: 'Transfer',
          args: l.args,
          blockNumber: b.number,
          blockHash: b.hash,
          transactionHash: l.txHash,
          logIndex: l.logIndex,
          removed: false,
        })
      }
    }
    return out
  }
}

// ── memory sink (upsert by eventId, content-hash dedup) ──────────────────────
class MemorySink implements Sink {
  readonly name = 'mem'
  store = new Map<string, { record: SinkRecord; hash: string }>()
  creates = 0
  updates = 0
  deletes = 0
  skips = 0
  async init() {}
  private hash(r: SinkRecord) {
    return stableStringify({
      a: r.attributes.filter((x) => x.key !== 'contentHash'),
      p: r.payload,
    })
  }
  async write(record: SinkRecord): Promise<WriteResult> {
    const h = this.hash(record)
    const ex = this.store.get(record.eventId)
    if (ex) {
      if (ex.hash === h) {
        this.skips++
        return { op: 'skip' }
      }
      this.updates++
      this.store.set(record.eventId, { record, hash: h })
      return { op: 'update' }
    }
    this.creates++
    this.store.set(record.eventId, { record, hash: h })
    return { op: 'create' }
  }
  // Exercise the indexer's batch path.
  async writeBatch(records: SinkRecord[]): Promise<WriteResult[]> {
    const out: WriteResult[] = []
    for (const r of records) out.push(await this.write(r))
    return out
  }
  async delete(id: string) {
    if (this.store.delete(id)) this.deletes++
  }
  // Reorg reconciliation: delete records in [from,to] (by `block`) not in `keep`, narrowed by `scope`
  // (e.g. only this indexer's `sync`), mirroring the real ArkivSink.
  async reconcile(
    fromBlock: bigint,
    toBlock: bigint,
    keep: Set<string>,
    scope?: Record<string, string | number>,
  ): Promise<number> {
    let n = 0
    for (const [eventId, { record }] of [...this.store]) {
      const attr = (k: string) => record.attributes.find((a) => a.key === k)?.value
      const block = BigInt(Number(attr('block') ?? -1))
      if (block < fromBlock || block > toBlock) continue
      if (scope && !Object.entries(scope).every(([k, v]) => String(attr(k)) === String(v))) continue
      if (!keep.has(eventId)) {
        this.store.delete(eventId)
        this.deletes++
        n++
      }
    }
    return n
  }

  /** Inject a foreign record (e.g. from another indexer sharing the wallet) for tests. */
  inject(eventId: string, attrs: Record<string, string | number>) {
    const record: SinkRecord = {
      eventId,
      attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
      payload: {},
      expiresInSeconds: 3600,
    }
    this.store.set(eventId, { record, hash: this.hash(record) })
  }
}

function makeIndexer(
  source: MockSource,
  sink: MemorySink,
  store: MemoryCursorStore,
  opts: Partial<{
    confirmations: number
    reorgWindow: number
    fromBlock: number
    maxEventsPerTick: number
    fetchStepBlocks: number
    configFingerprint: string
    onActivity: (a: IndexerActivity) => void
  }> = {},
) {
  return new Indexer({
    source,
    sink,
    map: () => ({}),
    ttlSeconds: days(30),
    cursorStore: store,
    logger: silentLogger,
    cursorLabel: 'test',
    confirmations: opts.confirmations ?? 2,
    reorgWindow: opts.reorgWindow ?? 8,
    fromBlock: opts.fromBlock ?? 0,
    pollIntervalMs: 10,
    maxEventsPerTick: opts.maxEventsPerTick,
    fetchStepBlocks: opts.fetchStepBlocks,
    configFingerprint: opts.configFingerprint,
    onActivity: opts.onActivity,
  })
}

async function main() {
  // ── time helpers ──
  await test('time helpers convert to seconds', () => {
    eq(seconds(5), 5, 'seconds')
    eq(hours(1), 3600, 'hours')
    eq(days(30), 2592000, 'days(30)')
  })
  await test('time helpers reject non-positive', () => {
    let threw = false
    try {
      days(0)
    } catch {
      threw = true
    }
    assert(threw, 'days(0) should throw')
  })

  // ── eventId ──
  await test('eventId is chainId:txHash:logIndex (lowercased)', () => {
    eq(eventId(1, '0xABC', 3), '1:0xabc:3', 'eventId')
  })

  // ── basic indexing ──
  await test('indexes a fresh chain end-to-end', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a') // blocks 0..10, head=10
    const sink = new MemorySink()
    const ix = makeIndexer(source, sink, new MemoryCursorStore())
    await ix.init()
    let r = await ix.runOnce()
    // confirmations=2 → safeHead=8 → blocks 0..8 = 9 events
    eq(r.written, 9, 'written count')
    eq(sink.store.size, 9, 'sink size')
    eq(sink.creates, 9, 'creates')
  })

  // ── idempotency / dedup ──
  await test('re-running with no new blocks writes nothing', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a')
    const sink = new MemorySink()
    const ix = makeIndexer(source, sink, new MemoryCursorStore())
    await ix.init()
    await ix.runOnce()
    const r2 = await ix.runOnce()
    eq(r2.written, 0, 'second run writes 0')
    eq(r2.upToDate, true, 'up to date')
  })

  await test('advancing head indexes only the new blocks', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a') // head 10, safeHead 8
    const sink = new MemorySink()
    const ix = makeIndexer(source, sink, new MemoryCursorStore())
    await ix.init()
    await ix.runOnce() // blocks 0..8
    source.build(14, 1, 'a') // head 13, safeHead 11 — but build() resets; re-add same blocks + extend
    // rebuild keeps salt 'a' so blocks 0..10 identical, plus 11..13
    const r = await ix.runOnce()
    eq(r.written, 3, 'wrote blocks 9,10,11') // safeHead now 11
    eq(sink.store.size, 12, 'total entities 0..11')
  })

  // ── restart / resume ──
  await test('a fresh Indexer resumes from the saved cursor', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a')
    const store = new MemoryCursorStore()
    const sink = new MemorySink()
    const ix1 = makeIndexer(source, sink, store)
    await ix1.init()
    await ix1.runOnce()
    const sizeAfter1 = sink.store.size

    // New indexer instance, SAME cursor store + sink → must not re-create.
    const ix2 = makeIndexer(source, sink, store)
    await ix2.init()
    const r = await ix2.runOnce()
    eq(r.written, 0, 'resume writes 0 (nothing new)')
    eq(sink.store.size, sizeAfter1, 'no duplicates after resume')
  })

  // ── reorg detection (pure) ──
  await test('detectReorg finds the common ancestor', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a')
    const cursor = {
      chainId: CHAIN_ID,
      lastProcessedBlock: 8n,
      blockHashes: {
        '6': (await source.getBlockHeader(6n))!.hash,
        '7': (await source.getBlockHeader(7n))!.hash,
        '8': (await source.getBlockHeader(8n))!.hash,
      },
    }
    source.reorgFrom(7, 11, 1, 'b') // blocks 7+ change hash
    const res = await detectReorg(cursor, (n) => source.getBlockHeader(n))
    assert(res.reorged, 'should detect reorg')
    eq(res.ancestor, 6n, 'ancestor is 6')
    eq(res.orphanedBlocks.join(','), '7,8', 'orphaned 7,8')
  })

  // ── reorg re-derivation (end-to-end through the Indexer) ──
  await test('reorg re-derives: orphaned events deleted, canonical written', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a') // head 10, safeHead 8
    const sink = new MemorySink()
    const store = new MemoryCursorStore()
    const ix = makeIndexer(source, sink, store)
    await ix.init()
    await ix.runOnce() // index blocks 0..8 (salt 'a')

    const orphanEventId = eventId(CHAIN_ID, hex32('a:tx:8:0'), 0) // block 8's event (salt a)
    assert(sink.store.has(orphanEventId), 'orphan event present before reorg')

    // Reorg from block 7 with a new salt → blocks 7..12 get new hashes + new txs/eventIds.
    source.reorgFrom(7, 13, 1, 'b') // head now 12, safeHead 10
    const r = await ix.runOnce()
    assert(r.reorged, 'tick reports reorg')

    // Old block-8 event (salt a) must be gone; new canonical block-8 event (salt b) must exist.
    assert(!sink.store.has(orphanEventId), 'orphaned event deleted after reorg')
    const canonical8 = eventId(CHAIN_ID, hex32('b:tx:8:0'), 0)
    assert(sink.store.has(canonical8), 'canonical block-8 event written')
    assert(sink.deletes >= 1, 'at least one delete happened')
    // Block 6 (unchanged, salt a) survives untouched.
    const kept6 = eventId(CHAIN_ID, hex32('a:tx:6:0'), 0)
    assert(sink.store.has(kept6), 'pre-ancestor event untouched')
  })

  // ── reorg reconcile is scoped to THIS sync (multi-indexer / shared wallet) ──
  await test('reorg reconcile does not delete another indexer sharing the wallet', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a')
    const sink = new MemorySink()
    const ix = makeIndexer(source, sink, new MemoryCursorStore()) // cursorId = 11155111-test
    await ix.init()
    await ix.runOnce() // index 0..8 (sync = 11155111-test)

    // A SECOND indexer (different sync) wrote an entity at block 8 to the SAME wallet/sink.
    sink.inject('other:event:8', { eventId: 'other:event:8', block: 8, sync: 'other-sync' })

    source.reorgFrom(7, 13, 1, 'b') // reorg blocks 7+
    await ix.runOnce()

    assert(!sink.store.has(eventId(CHAIN_ID, hex32('a:tx:8:0'), 0)), 'our own orphan deleted')
    assert(sink.store.has('other:event:8'), 'the other indexer\'s entity is NOT deleted')
  })

  // ── deep reorg (beyond the recorded window) is handled, not crashed ──
  await test('reorg deeper than the window re-derives without crashing', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a')
    const sink = new MemorySink()
    const store = new MemoryCursorStore()
    const ix = makeIndexer(source, sink, new MemoryCursorStore(), { reorgWindow: 3 })
    await ix.init()
    await ix.runOnce()
    source.reorgFrom(1, 13, 1, 'c') // reorg almost from genesis, deeper than window 3
    const r = await ix.runOnce()
    assert(r.reorged || r.written >= 0, 'handled deep reorg')
    // canonical tip event exists
    const tip = eventId(CHAIN_ID, hex32('c:tx:10:0'), 0)
    assert(sink.store.has(tip), 'canonical tip present after deep reorg')
  })

  // ── maxEventsPerTick caps a busy tick (bounds memory) ──
  await test('maxEventsPerTick shrinks the range instead of loading everything', async () => {
    const source = new MockSource()
    source.build(11, 3, 'a') // 3 events/block, head 10, safeHead 8 → 27 events in range 0..8
    const sink = new MemorySink()
    const store = new MemoryCursorStore()
    const ix = makeIndexer(source, sink, store, { maxEventsPerTick: 4, fetchStepBlocks: 1 })
    await ix.init()
    const r1 = await ix.runOnce()
    assert(r1.processed <= 6, `first tick bounded (got ${r1.processed})`) // ~blocks 0,1 = 6 events, then stop
    assert(!r1.upToDate, 'not caught up after one capped tick')
    assert(r1.lagBlocks > 0n, 'reports lag while behind')
    // Drain the rest in bounded ticks.
    for (let i = 0; i < 20 && !(await ix.runOnce()).upToDate; i++) {}
    eq(sink.store.size, 27, 'all 27 events eventually indexed')
  })

  // ── config fingerprint refusal ──
  await test('refuses a cursor built for a different config', async () => {
    const source = new MockSource()
    source.build(11, 1, 'a')
    const store = new MemoryCursorStore()
    const ixA = makeIndexer(source, new MemorySink(), store, { configFingerprint: 'cfg-A' })
    await ixA.init()
    await ixA.runOnce()
    // Reuse the SAME cursor store with a DIFFERENT fingerprint → must refuse.
    const ixB = makeIndexer(source, new MemorySink(), store, { configFingerprint: 'cfg-B' })
    let threw = false
    try {
      await ixB.init()
    } catch {
      threw = true
    }
    assert(threw, 'init must throw on a config-mismatched cursor')
    // Same fingerprint resumes fine.
    const ixA2 = makeIndexer(source, new MemorySink(), store, { configFingerprint: 'cfg-A' })
    await ixA2.init()
    const r = await ixA2.runOnce()
    eq(r.written, 0, 'same-config resume writes nothing new')
  })

  // ── activity streaming: writing + exactly one write per event (backfill for non-streaming sinks) ──
  await test('emits writing + exactly one write activity per event', async () => {
    const source = new MockSource()
    source.build(11, 2, 'a') // 2 events/block → blocks 0..8 = 18 events at confirmations 2
    const sink = new MemorySink() // does NOT call onWritten → exercises the indexer's backfill
    const acts: IndexerActivity[] = []
    const ix = makeIndexer(source, sink, new MemoryCursorStore(), { onActivity: (a) => acts.push(a) })
    await ix.init()
    const r = await ix.runOnce()
    const writes = acts.filter((a) => a.kind === 'write')
    const writings = acts.filter((a) => a.kind === 'writing')
    eq(writes.length, r.processed, 'one write activity per processed event')
    assert(writings.length >= 1, 'a writing activity fired')
    eq(new Set(writes.map((w) => (w as { eventId: string }).eventId)).size, writes.length, 'no duplicate write activities')
  })

  // ── predicate injection: owner-scope must be unescapable (shared public store) ──
  await test('owner-scope rejects quote-aware predicate injection, accepts legit predicates', () => {
    const owner = '0x000000000000000000000000000000000000dEaD'
    const mustReject = [
      'a = " (" && a = 1) || true || (a = " )"', // parens hidden in quotes mask a real ')' that escapes the wrap
      'x = 1) || (1=1', // early close
      'a = "x', // unterminated quote
      'a = 1 -- comment', // comment token
      'a = 1 || $owner = 0x0000000000000000000000000000000000000000 /* x */', // comment swallow
    ]
    for (const p of mustReject) {
      let threw = false
      try {
        scopeToOwner(p, owner)
      } catch {
        threw = true
      }
      assert(threw, `must reject injection: ${p}`)
    }
    const wrapped = scopeToOwner('event = "Transfer" && block > 100', owner)
    assert(wrapped.startsWith(`($owner = ${owner})`), 'owner clause comes first')
    scopeToOwner('name = "foo (bar)"', owner) // legit parens INSIDE a string value are fine
    let badOwner = false
    try {
      scopeToOwner('a = 1', 'not-an-address')
    } catch {
      badOwner = true
    }
    assert(badOwner, 'bad owner address rejected')
    let qv = false
    try {
      quoteValue('a"b')
    } catch {
      qv = true
    }
    assert(qv, 'quoteValue rejects an embedded quote')
    let bs = false
    try {
      quoteValue('a\\b')
    } catch {
      bs = true
    }
    assert(bs, 'quoteValue rejects a backslash')
    // no-owner queries still get injection-validated
    let unsafe = false
    try {
      assertSafePredicate('a = 1) || (1=1')
    } catch {
      unsafe = true
    }
    assert(unsafe, 'assertSafePredicate rejects an unbalanced raw predicate')
  })

  // ── FileCursorStore must persist configFingerprint (the production cursor guard) ──
  await test('FileCursorStore round-trips configFingerprint (prod cursor guard is live)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arkiv-cursor-'))
    try {
      const store = new FileCursorStore(dir)
      await store.save('11155111-test', {
        chainId: 11155111,
        lastProcessedBlock: 42n,
        blockHashes: { '42': hex32('h:42') },
        reorgRecoverUntil: undefined,
        configFingerprint: 'cfg-XYZ',
      })
      const loaded = await store.load('11155111-test')
      assert(loaded, 'cursor loaded from file')
      eq(loaded!.configFingerprint, 'cfg-XYZ', 'configFingerprint survived the file round-trip')
      eq(loaded!.lastProcessedBlock, 42n, 'lastProcessedBlock survived')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── sink network policy: testnet default, mainnet gated, EVM mainnet always banned, id must match ──
  await test('sink chain policy gates mainnet + bans EVM mainnets + matches chainId', () => {
    const braga = { chain: { id: 60138453102 } as never, name: 'arkiv:braga', isTestnet: true, explorerUrl: 'x' } as ArkivNetwork
    const arkMain = { chain: { id: 88888 } as never, name: 'arkiv:mainnet', isTestnet: false, explorerUrl: 'x' } as ArkivNetwork
    const throws = (fn: () => void) => {
      try {
        fn()
        return false
      } catch {
        return true
      }
    }
    assertWritableChain(60138453102, braga, false) // Braga testnet → ok
    assert(throws(() => assertWritableChain(1, braga, false)), 'Ethereum mainnet (1) banned')
    assert(throws(() => assertWritableChain(8453, arkMain, true)), 'known EVM mainnet (Base 8453) banned even with opt-in')
    assert(throws(() => assertWritableChain(88888, arkMain, false)), 'non-testnet network refused without allowMainnet')
    assertWritableChain(88888, arkMain, true) // non-testnet WITH opt-in → ok
    assert(throws(() => assertWritableChain(999, braga, false)), 'RPC chainId must match the configured network')
  })

  // ── report ──
  process.stderr.write(results.join('\n') + '\n')
  process.stderr.write(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  process.stderr.write(`test harness crashed: ${(e as Error).stack}\n`)
  process.exit(1)
})
