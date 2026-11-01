import { rejectBrowserRequest } from '../shared/request-guard.js'
// Bounded, streaming indexer run — the serverless replacement for the long-running worker.
// ONE request = ONE time-boxed pass: drive `runOnce()` until caught up OR the budget/cap is hit,
// streaming each onActivity over SSE, then end. No infinite loop → fits Vercel's request model.
//
// Guards (it's testnet, but a public URL must not be abusable):
//   - hard wall-clock budget (under maxDuration) · max writes · max backfill depth · maxEventsPerTick
//   - best-effort single-flight per warm instance (one run at a time; avoids burner nonce contention)
// The burner PRIVATE_KEY lives only in the server env — never sent to the browser.
import { createIndexer, MemoryCursorStore, days, SOURCE_CHAINS, WriteReconciliationRequiredError, storageAttributeName } from 'arkiv-sync'

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const MAX_BACKFILL = 600 // how far back a backfill may scan
const MAX_EVENTS_PER_TICK = 300 // visible chunking + bounded memory
const MAX_WRITES = 1500 // hard cap on entities written per run
const TIME_BUDGET_MS = 45_000 // safely under the 60s function maxDuration

const RESERVED = new Set(['event_id', 'content_hash', 'content_type', 'data', 'chain_id', 'contract', 'event', 'block', 'sync'])

// Module-scoped: shared across requests handled by the SAME warm instance (best-effort only —
// serverless does not share memory across instances; this is a demo, not a distributed lock).
let busy = false
let uncertain = false
const operations = new Map()

async function headOf(chainKey) {
  const d = SOURCE_CHAINS[chainKey]
  const r = await fetch(d.defaultRpcUrls[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(8000),
  })
  const j = await r.json()
  return BigInt(j.result)
}

export default async function handler(req, res) {
  if (rejectBrowserRequest(req, res)) return
  const url = new URL(req.url, 'http://localhost')
  const contract = (url.searchParams.get('contract') || '').trim()
  const event = (url.searchParams.get('event') || '').trim()
  const chain = url.searchParams.get('chain') || 'sepolia'
  const mode = url.searchParams.get('mode') || 'backfill'
  const backfill = Math.max(1, Math.min(MAX_BACKFILL, Number(url.searchParams.get('backfillBlocks')) || 200))

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* client gone */
    }
  }
  res.write(': connected\n\n')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const fail = (message) => {
    send({ kind: 'control', state: 'error', message })
    try {
      res.end()
    } catch {}
  }

  if (process.env.ENABLE_DEMO_WRITES !== '1') return fail('This demo is read-only. Use the CLI for authorized indexing.')
  if (!ADDR_RE.test(contract)) return fail('Invalid contract address.')
  if (!event) return fail('Enter an event signature.')
  if (!SOURCE_CHAINS[chain]) return fail('Choose a supported source chain.')
  if (!process.env.PRIVATE_KEY || !process.env.ARKIV_WRITE_ACCESS_KEY) return fail('The authorized writer is not configured.')
  if (busy || uncertain) return fail('Writer busy or awaiting reconciliation. Check confirmation before retrying.')
  const operationId = JSON.stringify([chain, contract.toLowerCase(), event, mode, backfill])
  if (operations.has(operationId)) return fail('Operation already requested. Check its confirmation before continuing.')
  if (operations.size >= 100) return fail('Operation journal is full; use the continuous CLI worker.')
  operations.set(operationId, 'sending')

  busy = true
  let indexer = null
  let stopped = false
  const stop = () => {
    stopped = true
    try {
      indexer?.stop()
    } catch {}
  }
  req.on('close', stop)

  try {
    let fromBlock = 'latest'
    if (mode === 'backfill') {
      const head = await headOf(chain)
      const back = BigInt(backfill)
      fromBlock = Number(head - back > 0n ? head - back : 0n)
    }

    const config = {
      // Provider diagnostics are untrusted; log fixed fields only.
      logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => console.info({ code: 'INDEXER_ACTIVITY', level })])),
      source: {
        chain,
        contract,
        events: [event],
        fromBlock,
        confirmations: SOURCE_CHAINS[chain].defaultConfirmations,
        pollIntervalMs: 1500,
        maxEventsPerTick: MAX_EVENTS_PER_TICK,
      },
      expirationSeconds: days(7),
      accessKey: process.env.ARKIV_WRITE_ACCESS_KEY,
      sinkBatchSize: 10,
      map: (e) => {
        const attributes = {}
        let n = 0
        for (const [k, v] of Object.entries(e.args ?? {})) {
          if (n++ >= 6) break
          const key = RESERVED.has(storageAttributeName(k)) ? `a_${k}` : k
          // 2000 covers any normal EVM value (address 42 · uint256 ~78 · bytes32 66) without truncating;
          // only a pathological long string/bytes arg is capped (this is a demo display bound). The full
          // event is always in the entity data bytes column regardless.
          attributes[key] = String(v).slice(0, 2000)
        }
        return { attributes }
      },
      label: `vercel-${chain}-${contract.slice(2, 10)}`,
    }

    send({ kind: 'control', state: 'running', contract, event, chain, mode, fromBlock: String(fromBlock) })

    indexer = createIndexer(config, {
      cursorStore: new MemoryCursorStore(),
      onActivity: (a) => {
        if (a.txHash) operations.set(operationId, `submitted:${a.txHash}`)
        if (!stopped) send(a)
      },
    })

    await indexer.init()
    const deadline = Date.now() + TIME_BUDGET_MS
    let written = 0
    while (!stopped && Date.now() < deadline && written < MAX_WRITES) {
      const r = await indexer.runOnce()
      written += r.written
      if (r.upToDate) {
        if (mode === 'backfill') break // backfill complete
        await new Promise((r2) => setTimeout(r2, 1500)) // live: wait for the next block, within budget
      }
    }
    const reason = stopped ? 'client' : written >= MAX_WRITES ? 'cap' : Date.now() >= deadline ? 'budget' : 'done'
    send({ kind: 'control', state: 'stopped', written, reason })
  } catch (err) {
    if (err instanceof WriteReconciliationRequiredError) uncertain = true
    send({ kind: 'control', state: 'error', message: 'Indexing stopped. Check confirmation before continuing.', code: 'INDEXER_RUN_FAILED', txHash: typeof err?.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(err.txHash) ? err.txHash : undefined })
  } finally {
    busy = false
    stop()
    try {
      res.end()
    } catch {}
  }
}
