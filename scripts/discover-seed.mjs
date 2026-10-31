import { EvmSource, silentLogger } from '../dist/index.js'
const contract = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'
const source = new EvmSource({ chain: 'sepolia', addresses: [contract],
  events: (await import('viem')).parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
  logger: silentLogger })
await source.preflight()
const head = await source.getHeadBlock()
const events = await source.getEvents(head - 206n, head - 6n)
const counts = new Map()
for (const event of events) counts.set(event.blockNumber, (counts.get(event.blockNumber) ?? 0) + 1)
const block = [...counts].find(([, count]) => count >= 1 && count <= 3)?.[0]
if (!block) throw new Error('No small confirmed source block found; choose an explicit source window.')
console.log(JSON.stringify({ chain: 'sepolia', contract, block: block.toString() }))
process.exit(0)
