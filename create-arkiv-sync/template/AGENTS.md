# AGENTS.md

Instructions for AI coding assistants (Cursor, GitHub Copilot, Claude Code, Zed, etc.) working in this project.

You are helping a developer run an **Arkiv Sync** indexer: it watches a smart contract's on-chain
events and writes each one to **Arkiv** — a queryable database on Ethereum (Braga testnet) — so the
events become queryable. The chain is the source of truth; Arkiv is a derived, re-derivable view.
Library: [`arkiv-sync`](https://www.npmjs.com/package/arkiv-sync). Human docs: [README.md](./README.md).

## First, ask the developer — you need these to make it work

1. **A funded Braga testnet wallet.** They need a **throwaway testnet** private key holding GLM, from
   the faucet → https://braga.hoodi.arkiv.network/faucet/ . Put it in `.env` as `PRIVATE_KEY=0x…`.
   `.env` is gitignored — **never commit it, never use a key with real funds.** If they don't have one,
   walk them through the faucet first.
2. **What to index:** the **contract address**, the **chain**, and the **event signature(s)** —
   e.g. `Transfer(address indexed from, address indexed to, uint256 value)`. The signatures must
   match the contract EXACTLY, `indexed` keywords included, or nothing decodes. Built-in source
   chains (by string key): `ethereum`, `sepolia`, `base`, `base-sepolia`, `bsc`, `bsc-testnet`
   (mainnets are READ-ONLY — reading logs signs nothing; the sink stays Braga testnet). Set your own
   RPC with `<CHAIN>_RPC_URL` (e.g. `BASE_RPC_URL`) if needed.
3. **What they want to build** (an activity feed, leaderboard, notifications, analytics dashboard,
   an AI-agent trigger…). This shapes `map()` — which fields become queryable `attributes`.

## Configure, then run

Edit `arkiv.config.ts` (`source.contract`, `source.events`, `map`). Then:

```bash
npm install
npm run verify   # bounded end-to-end check: confirms key, funding, RPCs, contract + signatures
npm start        # index 24/7 (Ctrl-C stops gracefully)
```

If `verify` reports 0 events, the event signature almost certainly doesn't match the contract.

## Rules you MUST follow (the library decides the hard parts — don't fight them)

- **Node 20–22, NEVER Node 24** (Node 24 silently hangs Arkiv entity updates).
- **TTL is in SECONDS** — use `days()/hours()/minutes()` from `arkiv-sync`. Never milliseconds.
- **Attribute values must be `string | number`** — coerce bigint with `String()` (e.g. uint256 amounts); put richer structures in `data`.
- **Don't set the reserved attributes** `eventId, contentHash, chainId, contract, event, block, sync` in `map` — the engine sets them, and a `map` that returns any of these **throws at runtime** (rename a colliding event arg, e.g. a `Sync` arg → `syncReserves`).
- **`map()` may return `null` to SKIP an event** (e.g. filter by a field). The `attributes` it returns become extra queryable fields; `data` overrides the stored payload (defaults to the decoded event).
- **Reads are owner-scoped** — always pass `owner` to `createArkivReader().query()` (the Arkiv store is public/shared).
- **No `.orderBy()`** — sort client-side (`sortBy`/`sortDir` sort the fetched page; Arkiv has no server-side ordering).
- Reorgs, idempotency (`chainId:txHash:logIndex`), the cursor, RPC rotation, and the gas preflight are all handled. **Don't reimplement them.**

## Query the derived database

```ts
import { createArkivReader } from 'arkiv-sync'
const reader = createArkivReader()
const rows = await reader.query('event = "Transfer"', {
  owner: '0xYOUR_INDEXER_WALLET',   // the address of the PRIVATE_KEY in .env
  limit: 25, sortBy: 'block', sortDir: 'desc',
})
// rows[i] = { key, owner, attributes: {…}, data, expiresAtBlock }
```

## Never

- Never commit `.env` or echo the private key. **Testnet only** — never a wallet with real funds.
- Never describe Arkiv as "decentralized", "trustless", or "permanent" — it is a **queryable database**, and entities **expire** at their TTL. For AI use cases, the term is "ephemeral coordination state", not "memory".
