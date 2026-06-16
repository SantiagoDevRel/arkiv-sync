---
name: arkiv-sync
description: Turn any smart contract's on-chain events into a queryable Arkiv database — a chain→Arkiv indexer built on the `arkiv-sync` npm library. Use when a builder wants to "index a contract", "mirror events into a database", "build a subgraph-like feed", "track Transfers/Swaps/Mints", "make on-chain activity queryable", build a leaderboard/activity-feed/notifications/analytics from EVM events, or sync any EVM chain (Sepolia v1) into Arkiv (Braga testnet) via `@arkiv-network/sdk`. Trigger keywords — arkiv-sync, indexer, index events, getLogs, eth_getLogs, event listener, subgraph alternative, on-chain to database, reorg handling, idempotent indexing, queryable events, contract events to Arkiv, leaderboard from events, activity feed, viem getLogs to Arkiv, Sepolia indexer, Braga. Do NOT activate for generic non-EVM data ingestion, or for storing app state directly on Arkiv with no chain source (use arkiv-best-practices / arkiv-agent-state for that). This skill DECIDES defaults — confirmations, reorg re-derivation, idempotency key, cursor persistence, RPC rotation, TTL — so an LLM wiring an indexer doesn't re-improvise the hard parts.
license: MIT
metadata:
  arkiv.skill-version: "1.0.0"
  arkiv.npm-package: "arkiv-sync"
  arkiv.sdk-package: "@arkiv-network/sdk"
  arkiv.sdk-range: ">=0.6.5 <0.7.0"
  arkiv.sdk-verified: "0.6.8"
  arkiv.network-fingerprint: "braga:60138453102"
  arkiv.source-chains: "ethereum:1, sepolia:11155111, base:8453, base-sepolia:84532, bsc:56, bsc-testnet:97 (mainnets are READ-ONLY; sink stays Braga)"
  arkiv.surface: "defineConfig, createIndexer, quickCheck, normalizeAddresses, Indexer, EvmSource, ArkivSink, createArkivReader, SOURCE_CHAINS, resolveSourceChain, FileCursorStore, MemoryCursorStore, detectReorg, seconds, minutes, hours, days, weeks, describeSeconds, eventId, createLogger, silentLogger, NormalizedEvent, EventMapper, MappedEntity, Sink, SourceAdapter, QueryParams, DecodedEntity"
  arkiv.internal-deps: "viem(getLogs, parseAbiItem, fallback) + @arkiv-network/sdk(createEntity, updateEntity, mutateEntities, query) are used INTERNALLY by arkiv-sync and are NOT re-exported — import them from their own packages if you need them directly."
  arkiv.last-verified-at: "2026-06-15"
  arkiv.evidence: "engine verified end-to-end on live Sepolia→Braga (smoke) + 19 unit tests (dedup/resume/reorg/reconcile-scope/deep-reorg/event-cap/fingerprint/predicate-injection/file-cursor/chain-policy/fromBlock-guard/coercers); 3-model adversarial audit (claude + codex + agy)"
---

# arkiv-sync

Use this skill to build an **indexer**: point it at any contract on any EVM chain (6 chains built in — see below) and its on-chain **events** become a **queryable Arkiv database**. The chain is the source of truth; Arkiv is a **derived view** (re-derivable), which is what makes reorgs and restarts safe. It's the always-on runtime an MCP can't be — a worker that watches the chain and writes each event as a queryable, expiring Arkiv entity.

Arkiv is a **queryable database on Ethereum**. Lead with that (the comparison is Supabase/Postgres). **Never** call it "decentralized database", "trustless", or "permanent" — there is no permanence primitive; TTLs expire.

## Ground rules (read before writing code)

- **Network facts are MUTABLE — verify at https://docs.arkiv.network.** Testnet entities do NOT migrate between networks. Current as of 2026-06-15:
  - Sink (Arkiv): **Braga** · chainId `60138453102` · gas token GLM · RPC `https://braga.hoodi.arkiv.network/rpc` · Faucet `https://braga.hoodi.arkiv.network/faucet/` · Explorer `https://explorer.braga.hoodi.arkiv.network`. **Braga decommissions ~Sep 2026** — the sink is a swappable adapter; don't couple a long-lived app to Braga.
  - Source (EVM): **6 built-in chains** by string key — `ethereum`(1) · `sepolia`(11155111) · `base`(8453) · `base-sepolia`(84532) · `bsc`(56) · `bsc-testnet`(97), each with a public RPC pool (no signup) + rotation/fallback. **Mainnets are READ-ONLY** (reading logs signs nothing); the sink always stays Braga. A custom viem chain def is only needed for a chain *outside* these built-ins.
- **Node 20–22 LTS, pinned `<24`.** Node 24 silently hangs Arkiv entity updates — the tx lands but the promise never resolves (arkiv-sdk-js issue #14).
- **`expiresIn` / TTL is in SECONDS, not milliseconds.** Use the `days()/hours()/minutes()` helpers. A 30-day TTL is `days(30)`, never `30*24*3600*1000`.
- **Arkiv update is FULL-REPLACE.** arkiv-sync builds the COMPLETE entity from each event, so replace is always correct; never send a partial.
- **NEVER use `.orderBy()`** — Arkiv has no functional server-side ordering (removed in SDK 0.7.0, PR #70). `createArkivReader` sorts the fetched page client-side; sort/paginate in JS.
- **Entities are PUBLIC and the store is SHARED.** Every read MUST be owner-scoped — arkiv-sync does this and is injection-safe (owner clause first, values validated). On-chain event data is already public, so mirroring it is fine; never add secrets/PII.
- **viem IS a direct dependency here** (the one exception to "never install viem separately for Arkiv"): the SOURCE reads a non-Arkiv chain, so it needs a plain viem client. Pin viem to the SDK's range to keep a single instance.

## The hard parts are already in the engine (don't re-implement them)

- **Reorgs:** indexes only `head − confirmations` (default is per-chain: Sepolia 6 · ETH 24 · Base 40 · BSC 75; override in config); tracks recent block hashes; on a reorg it rolls back to the common ancestor and **re-derives**, deleting orphaned events via a block-range reconciliation that is **query-based, at any depth**. Reorg *detection* covers the recent `reorgWindow` blocks (cached hashes).
- **Idempotency:** every event's key is `chainId:txHash:logIndex`; writes are create-or-skip by content hash, so restarts and overlaps never duplicate.
- **Cursor:** persisted atomically to `.arkiv-sync/` — the worker resumes exactly where it stopped.
- **RPC rotation:** a `fallback` transport over a public pool; a throttled/dead endpoint is skipped silently. Set `SEPOLIA_RPC_URL` for your own.
- **Preflight:** checks the Braga wallet's GLM balance and prints the faucet link instead of a cryptic "insufficient funds". Cost is measured live per run (`spendReport()` / `quickCheck().spent`); historically tiny on Braga (well under 1e-6 GLM/write) — gas is mutable, verify.
- **Load guards:** poll cadence defaults to `12000`ms (a `0` is clamped to 1000, so it can't hot-loop); `maxEventsPerTick` caps per-tick memory (default 2000 — a dense block shrinks the range instead of OOMing); after `maxConsecutiveFailures` (12) the worker stops cleanly instead of wedging on a dead RPC.

## Requirements (tell the user up front)

1. **Node 20–22** (`node -v`; not 24).
2. A **throwaway testnet wallet** funded with GLM on the Braga faucet → its `PRIVATE_KEY` in `.env` (gitignored; signs locally via viem, never leaves the machine; **never a key with real funds**).
3. The target: **contract address + chain + event signature(s)**.

## Natural language → config

A request like *"index USDC Transfers on Sepolia into a leaderboard"* becomes one `arkiv.config.ts`:

```ts
import { defineConfig, days, type NormalizedEvent } from 'arkiv-sync'

export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xCONTRACT…',
    events: ['Transfer(address indexed from, address indexed to, uint256 value)'], // "event " prefix optional
    fromBlock: 'latest',   // or a block number to backfill history
    // confirmations defaults per-chain (Sepolia 6 · ETH 24 · Base 40 · BSC 75); set a number to override
  },
  ttlSeconds: days(30),
  map: (e: NormalizedEvent) => ({
    // `attributes` are QUERYABLE fields; values are string|number (coerce bigint with String()).
    attributes: {
      from: String(e.args.from).toLowerCase(),
      to: String(e.args.to).toLowerCase(),
      value: String(e.args.value), // uint256 → string (exceeds JS safe-int)
    },
    // `data` overrides the stored payload (defaults to `{ event, chainId, contract, block, blockHash, tx, logIndex, args }` — decoded args under `.args`).
    // return null instead of an object to SKIP an event.
    // return `ttlSeconds` (in seconds, e.g. hours(6)) to override the default TTL for THIS event.
  }),
})
```

Then: `npm install` → copy `.env.example` to `.env` and add `PRIVATE_KEY` → `npm start`. The worker indexes 24/7; Ctrl-C stops gracefully.

The indexer always adds system attributes — `eventId, chainId, contract, event, block, sync` (plus `contentHash`, added by the sink) — so don't set those in `map`: a `map` that returns any reserved key **throws at runtime**. Rename a colliding event arg (e.g. a Uniswap V2 `Sync` arg → `syncReserves`). Add your own queryable fields on top.

## Reading the derived database

```ts
import { createArkivReader } from 'arkiv-sync'
const reader = createArkivReader()
const rows = await reader.query('event = "Transfer"', {
  owner: indexerAddress,              // your indexer wallet's REAL 0x+40hex address (e.g. sink.address) — a bad/placeholder format throws; always owner-scope (shared public store)
  limit: 25,
  sortBy: 'block', sortDir: 'desc',   // client-side sort (no server orderBy)
})
// rows[i] = { key, owner, attributes: {from,to,value,block,…}, data, expiresAtBlock }
```
Arkiv predicate operators: `=`, `!=`, numeric `>`/`>=`/`<`/`<=`, combined with `&&`/`||`. String values use double quotes (`event = "Transfer"`); arkiv-sync rejects values containing quotes/comment tokens.

## Idea catalogue (what to build on top)

- **Leaderboards / rankings** — index a score/volume event; query top-N (sort client-side).
- **Activity feeds** — index Transfer/Mint/Swap; query recent by `block desc`.
- **Notifications / webhooks** — a second worker tails the Arkiv feed (or the indexer's writes) and pings users.
- **Analytics dashboards** — aggregate attributes (counts, sums) over a TTL window.
- **AI agent triggers** — index an on-chain event and let an agent react (this is *ephemeral coordination state*, not "memory").
- **Registry / RWA mirrors** — mirror a registry contract's events to a queryable, time-scoped view.
- **DeFi position trackers** — index Deposit/Withdraw/Borrow to reconstruct positions.

## Common pitfalls (and what the engine does)

- *0 events appear* → the event signature must match the contract EXACTLY, `indexed` keywords included (decoding is strict). The engine logs a hint when it's caught up with 0 matches.
- *"insufficient funds"* → the wallet has no GLM; the preflight catches this and prints the faucet link.
- *Duplicates after restart* → won't happen; idempotency is by `chainId:txHash:logIndex` + content hash.
- *High-traffic contract lags* → writes are batched into one `mutateEntities` tx per ~50 events; reads are pooled.
- *Multichain* → use a built-in key directly (`chain: 'base'`, `chain: 'bsc'`, …, one of the 6 above); only a chain *outside* the built-ins needs a viem chain definition + `rpcUrls` as `source.chain`. The core is unchanged (adapter pattern); mainnets are read-only and the sink stays Braga.
