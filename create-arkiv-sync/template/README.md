# my-arkiv-sync

A chain → Arkiv indexer, scaffolded with [`create-arkiv-sync`](https://www.npmjs.com/package/create-arkiv-sync). It points at a smart contract's events and turns them into a **queryable [Arkiv](https://docs.arkiv.network) database**.

## Setup

1. **Node 20–22** (`node -v` — not 24).
2. Install: `npm install`
3. A throwaway **testnet** wallet funded with GLM at the [Braga faucet](https://braga.hoodi.arkiv.network/faucet/). Then:
   ```bash
   cp .env.example .env
   # put its PRIVATE_KEY in .env  (gitignored — never commit it, never use real funds)
   ```
4. Check it works end-to-end: `npm run verify`
5. Start indexing: `npm start`

## Make it yours

Edit `arkiv.config.ts`:

- `source.contract` — the contract address to index
- `source.events` — the event signatures (must match the contract exactly, `indexed` keywords included)
- `source.fromBlock` — `'latest'` for new events only, or a block number to backfill
- `map(event)` — the queryable `attributes` (and optional `data` payload) for each event; return `null` to skip

## Query the derived database

```ts
import { createArkivReader } from 'arkiv-sync'

const reader = createArkivReader()
const rows = await reader.query('event = "Transfer"', {
  owner: '0xYOUR_INDEXER_WALLET', // always owner-scope (the Arkiv store is shared/public)
  limit: 25,
  sortBy: 'block',
  sortDir: 'desc',
})
```

The engine handles RPCs, reorgs, idempotency, and gas for you. See the [`arkiv-sync` docs](https://www.npmjs.com/package/arkiv-sync).
