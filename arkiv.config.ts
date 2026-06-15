import { defineConfig, days, type NormalizedEvent } from './src/index.js'

/**
 * Demo config — index WETH `Transfer` events on Sepolia into a queryable Arkiv database.
 * `npm start` runs this. Change `contract`, `events`, and `map` to index anything else.
 *
 * WETH is a high-traffic Sepolia contract, so you'll see entities appear quickly.
 * `fromBlock: 'latest'` indexes only NEW transfers; set a block number to backfill history.
 */
export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH (Sepolia)
    events: ['Transfer(address indexed from, address indexed to, uint256 value)'],
    fromBlock: 'latest',
    confirmations: 5,
  },
  ttlSeconds: days(30),
  map: (e: NormalizedEvent) => ({
    // These become queryable attributes on the Arkiv entity.
    attributes: {
      from: String(e.args.from).toLowerCase(),
      to: String(e.args.to).toLowerCase(),
      value: String(e.args.value), // uint256 → string (can exceed JS safe-int range)
    },
    // The stored payload defaults to the full decoded event; we keep that here.
  }),
})
