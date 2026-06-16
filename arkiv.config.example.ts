import { defineConfig, days, type NormalizedEvent } from 'arkiv-sync'

/**
 * Your indexer config. Point it at any contract + events on any supported EVM chain.
 * Run `npm start` to begin indexing into your Arkiv (Braga) database.
 *
 * Requirements:
 *   - A `.env` with PRIVATE_KEY = a THROWAWAY testnet key, funded at the Braga faucet:
 *     https://braga.hoodi.arkiv.network/faucet/
 */
export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // ← your contract
    events: [
      // Human signatures; the leading "event " is optional.
      'Transfer(address indexed from, address indexed to, uint256 value)',
    ],
    fromBlock: 'latest', // or a block number to backfill history
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
})
