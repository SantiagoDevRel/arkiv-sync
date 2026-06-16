/**
 * Index ONLY mints (Transfer FROM the zero address) of an ERC-721 collection. Shows two patterns:
 *   1. `map()` returning `null` to SKIP an event (here: anything that isn't a mint), and
 *   2. an `indexed uint256 tokenId` arg.
 * Run: `tsx examples/erc721-mints.ts` (needs a funded Braga PRIVATE_KEY in .env).
 */
import 'dotenv/config'
import { createIndexer, defineConfig, addr, uint, days, type NormalizedEvent } from '../src/index.js'

const ZERO = '0x0000000000000000000000000000000000000000'

const indexer = createIndexer(
  defineConfig({
    source: {
      chain: 'base', // read-only mainnet source; the sink stays Braga testnet
      contract: '0x0000000000000000000000000000000000000000', // ← replace with YOUR ERC-721 contract
      // ERC-721 Transfer differs from ERC-20: tokenId is INDEXED (no `value`).
      events: ['Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'],
      fromBlock: 'latest', // set a block number to backfill historical mints
    },
    ttlSeconds: days(30),
    map: (e: NormalizedEvent) => {
      if (addr(e.args.from) !== ZERO) return null // not a mint → SKIP (nothing is written)
      return {
        attributes: {
          to: addr(e.args.to),
          tokenId: uint(e.args.tokenId),
        },
      }
    },
  }),
)

process.on('SIGINT', () => indexer.stop())
await indexer.start()
