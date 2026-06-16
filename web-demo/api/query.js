// Read-only: query the DERIVED Arkiv database back out — the headline verb ("queryable database").
// No writes, no nonce, no GLM, no abuse surface. Owner-scoped to the demo burner (its address is
// public; the key is not). Demonstrates that the indexed events are a real queryable view.
import { createArkivReader, SOURCE_CHAINS } from 'arkiv-sync'
import { privateKeyToAccount } from 'viem/accounts'

function ownerAddress() {
  const raw = process.env.PRIVATE_KEY || ''
  const key = raw.startsWith('0x') ? raw : `0x${raw}`
  return privateKeyToAccount(key).address
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const contract = (url.searchParams.get('contract') || '').trim().toLowerCase()
  const chain = url.searchParams.get('chain') || ''
  res.setHeader('content-type', 'application/json')
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('contrato inválido')
    if (!process.env.PRIVATE_KEY) throw new Error('el servidor no tiene PRIVATE_KEY configurada')
    const owner = ownerAddress()
    const reader = createArkivReader({ rpcUrl: process.env.ARKIV_RPC_URL })

    let predicate = `contract = "${contract}"`
    const d = SOURCE_CHAINS[chain]
    if (d) predicate += ` && chainId = ${d.chain.id}` // chainId is stored as a NUMBER (unquoted predicate)

    const rows = await reader.query(predicate, { owner, limit: 30, sortBy: 'block', sortDir: 'desc' })
    res.end(
      JSON.stringify({
        ok: true,
        owner,
        count: rows.length,
        rows: rows.map((r) => ({ key: r.key, attributes: r.attributes, expiresAtBlock: r.expiresAtBlock })),
      }),
    )
  } catch (err) {
    res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
  }
}
