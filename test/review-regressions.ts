import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPublicClient, ExpirationTime } from '@arkiv-network/sdk'
import { defineSchema, str } from '@arkiv-network/sdk/schema'
import { prepareGas } from '../src/sink/gas.js'
import { FileWriteJournal } from '../src/sink/journal.js'
import { WriteOperation } from '../src/sink/writeOperation.js'
import { FileCursorStore } from '../src/core/cursor.js'
import { EntityMutationError } from '@arkiv-network/sdk'
import { Fixture, record, OWNER, chain } from './sdk08.js'

const results: { id: string; status: string; error?: string }[] = []
async function regression(id: string, run: () => Promise<void>) {
  try { await run(); results.push({ id, status: 'PASS' }); console.log(`PASS REVIEW ${id}`) }
  catch (error) { const message = (error as Error).message; results.push({ id, status: 'FAIL', error: message }); console.log(`FAIL REVIEW ${id}: ${message.slice(0, 300)}`) }
}
await regression('P1 restart preserves uncertain send lock', async () => {
  const f = new Fixture(), directory = mkdtempSync(path.join(tmpdir(), 'sync-restart-'))
  const input = record('restart-uncertain')
  f.fault = 'broadcast'
  await assert.rejects(f.sink({ journalDirectory: directory } as any).write(input))
  const retained = new Map(f.rows)
  f.fault = undefined
  f.rows.clear() // RPC/index visibility is uncertain, not proof of an absent transaction.
  await assert.rejects(f.sink({ journalDirectory: directory } as any).write(input))
  assert.equal(f.sends, 1, 'restart must never blindly resend an uncertain operation')
  f.rows = retained
  assert.equal((await f.sink({ journalDirectory: directory } as any).write(input)).op, 'skip')
  assert.equal(f.sends, 1, 'lookup reconciliation must recover without a send')
})
await regression('P2 retry consumes a fresh nonce', async () => {
  const f = new Fixture(), original = f.request.bind(f)
  let nonceReads = 0
  f.request = async (method, params) => method === 'eth_getTransactionCount' ? (nonceReads++, '0x8') : original(method, params)
  const pub = createPublicClient({ chain, transport: f.transport })
  const batch = { creates: [{ schema: defineSchema('nonce_test', { value: str() }), values: { value: 'x' }, expiration: ExpirationTime.fromSeconds(120) }] }
  const first = await prepareGas(pub, { address: OWNER, type: 'json-rpc' }, batch, { nonce: 7 })
  const retry = await prepareGas(pub, { address: OWNER, type: 'json-rpc' }, batch, { nonce: 7 }, first.gas)
  assert.equal(first.nonce, 7); assert.equal(retry.nonce, 8); assert.equal(nonceReads, 1)
})
await regression('P2 replacement fits the new state at the attribute limit', async () => {
  const f = new Fixture(), sink = f.sink()
  const attrs = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`field_${i}`, `v${i}`]))
  const created = await sink.write(record('limit-replace', attrs))
  const next = Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== 'field_0'))
  next.renamed = 'new'
  await sink.write(record('limit-replace', next))
  const stored = f.rows.get(created.key as `0x${string}`)!
  assert.equal(stored.attributes.size, 32)
  assert(!stored.attributes.has('field_0')); assert.equal(stored.attributes.get('renamed')?.value, 'new')
})
await regression('P2 actual packed CLI parses and provides help', async () => {
  execFileSync(process.execPath, ['build.mjs'], { stdio: 'pipe' })
  const directory = mkdtempSync(path.join(tmpdir(), 'sync-cli-pack-'))
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', directory], { stdio: 'pipe',
    env: { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' } })
  const unpacked = path.join(directory, 'unpacked'); mkdirSync(unpacked)
  execFileSync('tar', ['-xzf', path.join(directory, 'arkiv-sync-1.0.0.tgz'), '-C', unpacked])
  const cli = path.join(unpacked, 'package/dist/bin/cli.js')
  execFileSync(process.execPath, ['--check', cli], { stdio: 'pipe' })
  // Dependency resolution is certified again after clean installation by pack-candidate.mjs.
  const output = execFileSync(process.execPath, ['dist/bin/cli.js', '--help'], { encoding: 'utf8' })
  assert.match(output, /usage:|Usage:/)
})
await regression('P2 signer queue spans distinct sink objects', async () => {
  const f = new Fixture(), original = f.request.bind(f)
  let active = 0, maxActive = 0
  f.request = async (method, params) => {
    if (method !== 'eth_sendTransaction') return original(method, params)
    active++; maxActive = Math.max(maxActive, active)
    try { await new Promise(resolve => setTimeout(resolve, 30)); return await original(method, params) }
    finally { active-- }
  }
  await Promise.all([f.sink().write(record('queue-a')), f.sink().init(), f.sink().write(record('queue-b'))])
  assert.equal(f.sends, 2); assert.equal(maxActive, 1)
})
await regression('P1 durable hash precedes SDK polling and startup reconciles without send', async () => {
  const f = new Fixture(), directory = mkdtempSync(path.join(tmpdir(), 'sync-hash-recovery-'))
  const store = new FileWriteJournal(directory), sink = f.sink({ journalDirectory: directory })
  const original = f.request.bind(f)
  let lookups = 0
  f.request = async (method, params) => {
    if (method === 'eth_getTransactionReceipt') {
      lookups++
      const [entry] = await store.entries(sink.identity)
      if (lookups <= 2) {
        assert.equal(entry?.state, 'submitted')
        assert.equal(entry?.txHash, (params as any[])[0])
        assert.equal(entry?.attempts, 1)
        assert.equal(entry?.sdkAcknowledged, lookups === 2)
      }
      if (lookups === 2) return null // SDK returned success, later lookup cannot authorize retry.
    }
    return original(method, params)
  }
  await assert.rejects(sink.write(record('hash-recovery')))
  const saved = (await store.entries(sink.identity))[0]!
  assert.equal(saved.state, 'pending'); assert(saved.txHash)
  // A genuinely fresh process restores the persisted lock, hash and consumed attempt budget.
  const child = `
    import assert from 'node:assert/strict';
    import {FileWriteJournal} from ${JSON.stringify(new URL('../src/sink/journal.ts', import.meta.url).href)};
    import {WriteOperation} from ${JSON.stringify(new URL('../src/sink/writeOperation.ts', import.meta.url).href)};
    const entries=await new FileWriteJournal(${JSON.stringify(directory)}).entries(${JSON.stringify(sink.identity)});
    const operation=new WriteOperation(entries[0]);let sends=0;
    await assert.rejects(operation.run({prepare:async()=>({gas:1000000n,gasPrice:1n,nonce:0}),send:async()=>{sends++;throw Error('must not send')},receipt:async()=>null,confirmedRevertHash:()=>undefined}));
    assert.equal(sends,0);assert.equal(operation.attempts,1);assert.equal(operation.txHash,${JSON.stringify(saved.txHash)});
  `
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', child],
    { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME }, stdio: 'pipe' })
  assert.equal((await f.sink({ journalDirectory: directory }).write(record('hash-recovery'))).op, 'skip')
  assert.equal(f.sends, 1)
  assert.equal((await store.entries(sink.identity))[0]?.state, 'confirmed')
  await new FileCursorStore(directory).save('test', { chainId: 11155111, lastProcessedBlock: 1n, blockHashes: {} })
  const files = readdirSync(directory)
  assert(files.includes('test.json') && files.some(name => name.startsWith('writes-')))
})
await regression('P1 durable attempt budget survives reconstruction after two gas reverts', async () => {
  const journal = new FileWriteJournal(mkdtempSync(path.join(tmpdir(), 'sync-attempts-')))
  const entry: any = { id: 'attempt-limit', state: 'idle', attempts: 0, targets: [] }
  let sends = 0, gas = 0n
  const dependencies = {
    prepare: async (previous?: bigint) => ({ gas: previous ? 2n * previous : 1_000_000n, gasPrice: 1n, nonce: sends }),
    send: async (params: any) => { sends++; gas = params.gas; throw new EntityMutationError('reverted', { txHash: ('0x' + 'ab'.repeat(32)) as `0x${string}` }) },
    receipt: async () => ({ status: 'reverted' as const, gasUsed: gas }),
    confirmedRevertHash: (error: unknown) => (error as EntityMutationError).txHash,
  }
  const first = new WriteOperation(entry, snapshot => journal.save('attempt-test', { ...entry, ...snapshot }))
  await assert.rejects(first.run(dependencies))
  const saved = (await journal.entries('attempt-test'))[0]!
  assert.equal(saved.attempts, 2); assert.equal(saved.state, 'failed')
  await assert.rejects(new WriteOperation(saved as any).run(dependencies))
  assert.equal(sends, 2)
})
await regression('P1 a later SDK error cannot erase an already durable broadcast hash', async () => {
  const journal = new FileWriteJournal(mkdtempSync(path.join(tmpdir(), 'sync-broadcast-hash-')))
  const entry: any = { id: 'known-broadcast', state: 'idle', attempts: 0, targets: [] }
  const hash = ('0x' + 'cd'.repeat(32)) as `0x${string}`
  const operation = new WriteOperation(entry, snapshot => journal.save('hash-test', { ...entry, ...snapshot }))
  await assert.rejects(operation.run({
    prepare: async () => ({ gas: 1_000_000n, gasPrice: 1n, nonce: 0 }),
    send: async () => { await operation.broadcast(hash); throw new Error('SDK timeout without attached hash') },
    receipt: async () => null, confirmedRevertHash: () => undefined,
  }))
  assert.equal((await journal.entries('hash-test'))[0]?.txHash, hash)
})
await regression('P1 unsigned preparation failure consumes no durable attempt', async () => {
  const f = new Fixture(), sink = f.sink(), input = record('prepare-recovery')
  f.fault = 'estimate'
  await assert.rejects(sink.write(input))
  f.fault = undefined
  assert.equal((await sink.write(input)).op, 'create')
  assert.equal(f.sends, 1)
})
await regression('P1 a completed operation with missing effects cannot falsely advance', async () => {
  const f = new Fixture(), input = record('expired-completion')
  await f.sink().write(input)
  f.rows.clear()
  await assert.rejects(f.sink().write(input), /new journal generation/)
  assert.equal(f.sends, 1)
})
await regression('P1 contradictory pending hash with zero attempts retains its durable lock', async () => {
  const f = new Fixture(), directory = mkdtempSync(path.join(tmpdir(), 'sync-contradiction-'))
  const input = record('contradictory-admission'), sink = f.sink({ journalDirectory: directory })
  await sink.write(input)
  const filename = path.join(directory, readdirSync(directory).find(name => name.startsWith('writes-'))!)
  const saved = JSON.parse(readFileSync(filename, 'utf8'))
  saved.entries[0].state = 'pending'; saved.entries[0].attempts = 0
  writeFileSync(filename, JSON.stringify(saved))
  const original = f.request.bind(f)
  f.request = async (method, params) => method === 'eth_getTransactionReceipt' ? null : original(method, params)
  f.rows.clear() // Temporary invisibility must not turn contradictory evidence into permission.
  await assert.rejects(f.sink({ journalDirectory: directory }).write(input))
  assert.equal(f.sends, 1)
  const retained = JSON.parse(readFileSync(filename, 'utf8')).entries[0]
  assert.equal(retained.state, 'pending'); assert.equal(retained.attempts, 0)
  assert.equal(retained.txHash, saved.entries[0].txHash)
})
await regression('P2 returning to earlier content is a new durable operation', async () => {
  const f = new Fixture(), directory = mkdtempSync(path.join(tmpdir(), 'sync-content-cycle-'))
  for (const state of ['A', 'B', 'C', 'B']) await f.sink({ journalDirectory: directory }).write(record('content-cycle', { state }))
  assert.equal(f.sends, 4)
  assert.equal([...f.rows.values()][0]!.attributes.get('state')?.value, 'B')
  for (const state of ['C', 'B']) await f.sink({ journalDirectory: directory }).write(record('content-cycle', { state }))
  const history = await new FileWriteJournal(directory).entries(f.sink().identity)
  assert.deepEqual(history.map(entry => entry.sequence), [1, 2, 3, 4, 5, 6])
  assert.equal(new Set(history.map(entry => entry.id)).size, 6)
  assert(history.every(entry => entry.state === 'confirmed' && entry.attempts === 1))
  await f.sink({ journalDirectory: directory }).write(record('content-cycle', { state: 'B' }))
  assert.equal(f.sends, 6, 'replay of the completed current state must skip')
})
await regression('P2 reorg removal and reappearance replay without duplicate sends', async () => {
  const f = new Fixture(), directory = mkdtempSync(path.join(tmpdir(), 'sync-reorg-cycle-'))
  const canonical = record('canonical', { block: 100 }), orphan = record('reappearing', { block: 101 })
  await f.sink({ journalDirectory: directory }).writeBatch([canonical, orphan])
  assert.equal(f.sends, 1)
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.equal(await f.sink({ journalDirectory: directory }).reconcile(100n, 101n, new Set(['canonical']), { sync: 'sync-a' }), 1)
    await f.sink({ journalDirectory: directory }).write(orphan)
    const sends: number = f.sends
    assert.equal((await f.sink({ journalDirectory: directory }).write(orphan)).op, 'skip')
    assert.equal(await f.sink({ journalDirectory: directory }).reconcile(100n, 101n, new Set(['canonical', 'reappearing']), { sync: 'sync-a' }), 0)
    assert.equal(f.sends, sends)
  }
  assert.equal(f.sends, 5); assert.equal(f.rows.size, 2)
})
console.log(JSON.stringify({ reviewRegressions: results }))
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1
