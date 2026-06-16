// Resolve a contract's event signatures from its ABI (Sourcify, keyless, multichain), with
// standard ERC events as fallbacks. Read-only; no key involved.
import { SOURCE_CHAINS } from 'arkiv-sync'

function chainIdOf(chainKey) {
  const d = SOURCE_CHAINS[chainKey]
  return d ? d.chain.id : 11155111
}

function sigFromAbiEvent(ev) {
  const params = (ev.inputs ?? []).map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name || ''}`.trim())
  return `${ev.name}(${params.join(', ')})`
}

const STANDARD_EVENTS = [
  { label: 'Transfer (ERC-20)', signature: 'Transfer(address indexed from, address indexed to, uint256 value)' },
  { label: 'Approval (ERC-20)', signature: 'Approval(address indexed owner, address indexed spender, uint256 value)' },
  { label: 'Transfer (ERC-721 NFT)', signature: 'Transfer(address indexed from, address indexed to, uint256 indexed tokenId)' },
  { label: 'ApprovalForAll (ERC-721/1155)', signature: 'ApprovalForAll(address indexed owner, address indexed operator, bool approved)' },
  { label: 'TransferSingle (ERC-1155)', signature: 'TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)' },
]

async function fetchAbiEvents(address, chainId) {
  const out = []
  const seen = new Set()
  const add = (label, signature, source) => {
    if (seen.has(signature)) return
    seen.add(signature)
    out.push({ label, signature, source })
  }
  try {
    const u = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi`
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) })
    if (r.ok) {
      const j = await r.json()
      for (const item of j?.abi ?? []) {
        if (item.type === 'event') add(item.name, sigFromAbiEvent(item), 'abi')
      }
    }
  } catch {
    /* not verified / unreachable — fall through to standards */
  }
  if (process.env.ETHERSCAN_API_KEY) {
    try {
      const u = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${process.env.ETHERSCAN_API_KEY}`
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) })
      const j = await r.json()
      if (j.status === '1') {
        for (const item of JSON.parse(j.result)) {
          if (item.type === 'event') add(item.name, sigFromAbiEvent(item), 'abi')
        }
      }
    } catch {
      /* ignore */
    }
  }
  for (const s of STANDARD_EVENTS) add(s.label, s.signature, 'standard')
  return out
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const address = url.searchParams.get('address') || ''
  const chain = url.searchParams.get('chain') || 'sepolia'
  res.setHeader('content-type', 'application/json')
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.statusCode = 400
    return res.end(JSON.stringify({ ok: false, error: 'invalid address' }))
  }
  try {
    const events = await fetchAbiEvents(address, chainIdOf(chain))
    res.end(JSON.stringify({ ok: true, events }))
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
  }
}
