// Built-in source chains, for the UI's chain selector (read-only; no key involved).
import { SOURCE_CHAINS } from 'arkiv-sync'

export default function handler(req, res) {
  const chains = Object.values(SOURCE_CHAINS).map((d) => ({
    key: d.key,
    chainId: d.chain.id,
    label: d.chain.name,
    isMainnet: d.isMainnet,
  }))
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, chains }))
}
