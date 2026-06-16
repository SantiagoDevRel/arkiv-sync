/**
 * Index Uniswap V2 Swaps into a queryable Arkiv database — a NON-Transfer event with several
 * amounts. Shows the addr()/uint() coercers (no more hand-written String(...).toLowerCase()).
 * Run: `tsx examples/uniswap-v2-swaps.ts` (needs a funded Braga PRIVATE_KEY in .env).
 *
 * Query it back, e.g.:
 *   const rows = await createArkivReader().query('event = "Swap"', { owner: '0xYOUR_WALLET', limit: 25 })
 */
import 'dotenv/config'
import { createIndexer, defineConfig, addr, uint, days, type NormalizedEvent } from '../src/index.js'

const indexer = createIndexer(
  defineConfig({
    source: {
      // Mainnet source is READ-ONLY here (reading logs signs nothing) — the SINK stays Braga testnet.
      chain: 'ethereum',
      contract: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc', // Uniswap V2 USDC/WETH pair
      events: [
        'Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
      ],
      fromBlock: 'latest', // or a block number to backfill history
    },
    ttlSeconds: days(7),
    map: (e: NormalizedEvent) => ({
      attributes: {
        sender: addr(e.args.sender), // validates + lowercases (throws on a bad arg name)
        to: addr(e.args.to),
        amount0In: uint(e.args.amount0In), // uint256 → decimal string (exceeds JS safe int)
        amount1In: uint(e.args.amount1In),
        amount0Out: uint(e.args.amount0Out),
        amount1Out: uint(e.args.amount1Out),
      },
    }),
  }),
)

process.on('SIGINT', () => indexer.stop())
await indexer.start()
