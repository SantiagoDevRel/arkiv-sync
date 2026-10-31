import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ArkivSink, EvmSource, Indexer, MemoryCursorStore, createArkivReader, silentLogger, days, quoteValue, scrubSecrets } from '../dist/index.js'
import { parseAbi } from 'viem'

// A committed fixed source window makes reseeding deterministic even after a testnet reset.
const window = JSON.parse(readFileSync(new URL('./seed-window.json', import.meta.url), 'utf8'))
const key = process.env.TEST_SYNC_PRIVATE_KEY ?? process.env.PRIVATE_KEY
const accessKey = process.env.ARKIV_ACCESS_KEY_A ?? process.env.ARKIV_ACCESS_KEY
if (!key || !accessKey) throw new Error('Configure a funded local testnet signer and ARKIV_ACCESS_KEY. Never paste their values into chat.')
try {
  const sink = new ArkivSink({ privateKey: key, accessKey, logger: silentLogger, batchSize: 3 })
  if (process.env.TEST_SYNC_ADDRESS) assert.equal(sink.address.toLowerCase(), process.env.TEST_SYNC_ADDRESS.toLowerCase())
  const source = new EvmSource({ chain: window.chain, addresses: [window.contract],
    events: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']), logger: silentLogger })
  const hashes = []
  const replay = async () => {
    const worker = new Indexer({ source, sink, map: e => ({ attributes: {
      from: String(e.args.from).toLowerCase(), to: String(e.args.to).toLowerCase(), value: String(e.args.value),
    } }), expirationSeconds: days(7), fromBlock: BigInt(window.block), endBlock: BigInt(window.block),
      confirmations: 6, reorgWindow: 2, cursorStore: new MemoryCursorStore(), cursorLabel: 'rabdi-demo-seed-v1',
      logger: silentLogger, onActivity: activity => { if (activity.kind === 'write' && activity.txHash) hashes.push(activity.txHash) } })
    await worker.init()
    return worker.runOnce()
  }
  const first = await replay()
  assert(first.processed > 0, 'fixed source window must contain real events')
  const second = await replay()
  assert.equal(second.written, 0, 'identical replay must not write')
  const reader = createArkivReader({ accessKey })
  const rows = await reader.queryAll(`contract = ${quoteValue(window.contract)} AND block = u64(${window.block})`,
    { owner: sink.address, maxResults: 20, limit: 10 })
  assert(rows.length >= first.processed, 'Rabdi query must observe the real source events')
  console.log(JSON.stringify({ status: 'PASS', chainId: 7794095, owner: sink.address, window,
    firstWrites: first.written, replayWrites: second.written, queried: rows.length,
    txHashes: [...new Set(hashes)], entities: rows.map(row => ({ key: row.key, eventId: row.attributes.event_id, expiresAtBlock: row.expiresAtBlock })) }))
} catch (error) {
  console.error(scrubSecrets(error))
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
