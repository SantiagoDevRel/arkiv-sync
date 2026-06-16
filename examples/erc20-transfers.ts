/**
 * Programmatic usage — the same thing `npm start` does, but in code you control.
 * Indexes WETH transfers on Sepolia into Arkiv. Run with: `tsx examples/erc20-transfers.ts`
 * (needs PRIVATE_KEY in .env).
 */
import 'dotenv/config'
import { createIndexer, defineConfig, days, type NormalizedEvent } from '../src/index.js'

const indexer = createIndexer(
  defineConfig({
    source: {
      chain: 'sepolia',
      contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH (Sepolia)
      events: ['Transfer(address indexed from, address indexed to, uint256 value)'],
      fromBlock: 'latest',
      // confirmations defaults per-chain (Sepolia 6 · ETH 24 · Base 40 · BSC 75) — set a number to override
    },
    ttlSeconds: days(30),
    map: (e: NormalizedEvent) => ({
      attributes: {
        from: String(e.args.from).toLowerCase(),
        to: String(e.args.to).toLowerCase(),
        value: String(e.args.value),
      },
    }),
  }),
)

// Stop cleanly on Ctrl-C.
process.on('SIGINT', () => indexer.stop())

await indexer.start()
