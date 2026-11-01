import { rejectBrowserRequest } from '../shared/request-guard.js'
// Read-only: query the DERIVED Arkiv database back out — the headline verb ("queryable database").
// No writes, nonce or GLM. Request checks protect the server read key. Owner-scoped to the demo burner (its address is
// public; the key is not). Demonstrates that the indexed events are a real queryable view.
import { createArkivReader, SOURCE_CHAINS, quoteValue } from 'arkiv-sync'

export default async function handler(req, res) {
  if (rejectBrowserRequest(req, res)) return
  const url = new URL(req.url, 'http://localhost')
  const contract = (url.searchParams.get('contract') || '').trim().toLowerCase()
  const chain = url.searchParams.get('chain') || ''
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('Invalid contract address.')
    const owner = process.env.ARKIV_DEMO_OWNER
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? '')) throw new Error('Demo owner is not configured.')
    if (!SOURCE_CHAINS[chain]) throw new Error('Choose a supported source chain.')
    const reader = createArkivReader({ accessKey: process.env.ARKIV_ACCESS_KEY })

    let predicate = `contract = ${quoteValue(contract)}`
    const d = SOURCE_CHAINS[chain]
    if (d) predicate += ` AND chain_id = u64(${d.chain.id})`

    const rows = await reader.query(predicate, { owner, limit: 30, sortBy: 'block', sortDir: 'desc' })
    res.end(
      JSON.stringify({
        ok: true,
        owner,
        count: rows.length,
        rows: rows.map((r) => ({ key: r.key, attributes: r.attributes, expiresAtBlock: r.expiresAtBlock })),
      }),
    )
  } catch {
    res.statusCode = 400
    res.end(JSON.stringify({ ok: false, error: 'Could not query Rabdi. Retry the read later.', code: 'RABDI_QUERY_FAILED' }))
  }
}
