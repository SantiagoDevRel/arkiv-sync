import { defineConfig, days, type NormalizedEvent } from 'arkiv-sync'

/**
 * Your indexer config. Point it at any contract + events on any supported EVM chain; each event
 * becomes a queryable Arkiv entity. Ships indexing WETH Transfers on Sepolia so `npm run verify`
 * works out of the box — change `contract`, `events`, and `map` to index your own.
 */
export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH (Sepolia) — replace with yours
    events: [
      // Human signatures; the leading "event " is optional. Must match the contract exactly
      // (indexed keywords included), or no logs decode.
      'Transfer(address indexed from, address indexed to, uint256 value)',
    ],
    fromBlock: 'latest', // or a block number to backfill history
    confirmations: 5,
  },
  ttlSeconds: days(30),
  map: (e: NormalizedEvent) => ({
    // `attributes` become queryable fields. Values are string|number (coerce bigint with String()).
    attributes: {
      from: String(e.args.from).toLowerCase(),
      to: String(e.args.to).toLowerCase(),
      value: String(e.args.value),
    },
    // Return null instead to SKIP an event. `data: {...}` overrides the stored payload.
  }),
})
