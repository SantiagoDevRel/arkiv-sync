# Arkiv Sync

**Point it at any smart contract on any EVM chain and turn its on-chain events into a queryable [Arkiv](https://docs.arkiv.network) database — no RPC, reorg, or gas knowledge required.**

Arkiv is a **queryable database on Ethereum** (think Supabase/Postgres, not "a blockchain"). Arkiv Sync is the always-on worker that watches a chain and writes each event as a queryable, expiring Arkiv entity. The chain is the source of truth; **Arkiv is a derived view that can always be re-derived** — which is exactly what makes reorgs and restarts safe.

```
  Sepolia (any contract's events)  ──▶  Arkiv Sync  ──▶  Arkiv / Braga (queryable entities)
        viem getLogs                  decode · dedup ·          your app queries this
     RPC pool + rotation             reorg · cursor · TTL        (no RPC, no gas)
```

**Live demo:** https://arkiv-indexer.vercel.app · **Install:** `npm create arkiv-sync@latest` ([npm](https://www.npmjs.com/package/arkiv-sync))

---

## Three modes (don't overlap)

| Mode | What it is | Where |
|---|---|---|
| **npm library** | the **runtime** — the worker that watches the chain 24/7 (what no MCP can be) | `src/` → `arkiv-sync` |
| **Skill** | the **knowledge** — teaches an LLM to wire the library + the gotchas | [`skill/SKILL.md`](./skill/SKILL.md) |
| **Template** | `npm create arkiv-sync` — a ready project that indexes on `npm start` | [`create-arkiv-sync/`](./create-arkiv-sync/) |

The library is the backbone; the skill and template sit on top without rewriting it.

## Requirements (preflight)

1. **Node 20–22** (`node -v`). **Not Node 24** — it silently hangs Arkiv entity updates (the tx lands but the promise never resolves; arkiv-sdk-js #14). `engines` enforces `<24`.
2. A **throwaway testnet wallet** funded with GLM at the [Braga faucet](https://braga.hoodi.arkiv.network/faucet/). Its `PRIVATE_KEY` goes in `.env` (gitignored). It signs Arkiv writes **locally** via viem — the key never leaves your machine, is never logged, and **must never hold real funds** (Arkiv Sync refuses any non-allowlisted chain).
3. The target: a **contract address + chain + event signature(s)**.

## Quickstart

### With the template

```bash
npm create arkiv-sync@latest my-indexer   # (or: node create-arkiv-sync/index.mjs my-indexer)
cd my-indexer
npm install
cp .env.example .env          # add your funded Braga testnet PRIVATE_KEY
npm run verify                # bounded end-to-end check (Sepolia → Arkiv → query)
npm start                     # index 24/7
```

### In this repo (the reference implementation)

```bash
npm install
cp .env.example .env          # add PRIVATE_KEY
npm run smoke                 # live end-to-end: index a real Sepolia block → Arkiv → query back
npm start                     # runs arkiv.config.ts (WETH Transfers on Sepolia)
```

## Configure (the declarative layer)

Everything is one `arkiv.config.ts`. Adding another contract or chain is just another config — the engine never changes.

```ts
import { defineConfig, days, type NormalizedEvent } from 'arkiv-sync'

export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    events: ['Transfer(address indexed from, address indexed to, uint256 value)'], // "event " optional
    fromBlock: 'latest',   // or a block number to backfill history
    // confirmations defaults per-chain (Sepolia 6 · ETH 24 · Base 40 · BSC 75) — set a number to override
  },
  ttlSeconds: days(30),    // TTL is in SECONDS — always use the helpers
  map: (e: NormalizedEvent) => ({
    attributes: {          // queryable fields (string | number; coerce bigint with String())
      from: String(e.args.from).toLowerCase(),
      to: String(e.args.to).toLowerCase(),
      value: String(e.args.value),
    },
    // return null to SKIP an event; `data: {...}` overrides the stored payload (defaults to the full event)
  }),
})
```

The indexer always adds system attributes — `eventId, contentHash, chainId, contract, event, block, sync` (reserved; setting any in `map` throws).

## Query the derived database

```ts
import { createArkivReader } from 'arkiv-sync'

const reader = createArkivReader()
const rows = await reader.query('event = "Transfer"', {
  owner: '0xYOUR_INDEXER_WALLET',  // ALWAYS owner-scope — the Arkiv store is shared/public
  limit: 25,
  sortBy: 'block', sortDir: 'desc', // client-side sort (Arkiv has no server-side orderBy)
})
// rows[i] = { key, owner, attributes: {from,to,value,block,…}, data, expiresAtBlock }
// `data` defaults to { event, chainId, contract, block, blockHash, tx, logIndex, args } (args nested under .args)
```

Predicate operators: `=`, `!=`, numeric `>`/`>=`/`<`/`<=`, combined with `&&`/`||`. String values use double quotes; values containing quotes/comment tokens are rejected (injection-safe).

## Use it in your app (as a library)

The published package works exactly like this repo:

```bash
npm i arkiv-sync          # or scaffold a whole project: npm create arkiv-sync@latest my-indexer
```

```ts
import { createIndexer, defineConfig, createArkivReader, addr, uint, days } from 'arkiv-sync'
```

- **Coercers** — `addr()` / `uint()` / `lower()` validate event args in `map()`, so a mistyped arg name **throws** instead of silently storing the string `"undefined"`.
- **Safe predicates** — build queries from untrusted values with `quoteValue()` / `assertSafePredicate()` (the same guard the reader uses); never string-concatenate raw user input.
- **Always pass `owner`** to `reader.query(...)` — the Arkiv store is shared/public, so an un-scoped read returns everyone's entities.
- **Multiple indexers on one wallet?** Give each a distinct `label` — reorg reconciliation is scoped per-indexer (a `sync` attribute), so they never delete each other's entities.

## How it works (the hard parts, handled in code)

- **Reorgs** — indexes only `head − confirmations` (default is per-chain: Sepolia 6 · ETH 24 · Base 40 · BSC 75); tracks recent block hashes; on a reorg it rolls back to the common ancestor and **re-derives**, deleting orphaned events via an owner-scoped block-range reconciliation (query-based, at any depth; detection covers the recent `reorgWindow` blocks). A transient RPC error is never mistaken for a reorg (it throws → retry, vs a genuinely-absent block).
- **Idempotency** — every event's key is `chainId:txHash:logIndex`; writes are create-or-skip by a sha256 content hash, so restarts and overlaps never duplicate.
- **Cursor** — persisted atomically to `.arkiv-sync/` (write-then-rename); the worker resumes exactly where it stopped.
- **Zero-friction RPCs** — a viem `fallback` pool over public Sepolia endpoints with automatic rotation; a throttled/dead endpoint is skipped silently. Set `SEPOLIA_RPC_URL` for your own. `getLogs` auto-splits when an RPC rejects a too-wide range.
- **Preflight + gas** — checks the Braga wallet's GLM balance and prints the faucet link instead of a cryptic error. Writes are **batched** (one `mutateEntities` tx per ~50 events). Measured cost ≈ **1–3 ×10⁻⁸ GLM/event** (1 GLM ≈ tens of millions of events).
- **Full-replace updates** — Arkiv updates replace the whole entity; the engine always sends the complete derived record, so replace is correct.

## Multichain

Built-in source chains (set `source.chain` to one of these keys): **`ethereum`** (1) · **`sepolia`** (11155111) · **`base`** (8453) · **`base-sepolia`** (84532) · **`bsc`** (56) · **`bsc-testnet`** (97). Each ships verified keyless public RPCs (with rotation) + a per-chain reorg-safe `defaultConfirmations` (override via `source.confirmations`). For any other EVM chain, pass a chain definition object (from `viem/chains`) + `rpcUrls` + `defaultConfirmations` instead of a key.

**Mainnets are READ-ONLY here.** Reading a contract's logs signs nothing and spends nothing, so indexing **mainnet** events is safe. The only thing that holds a key is the **sink** — which is always Arkiv/**Braga testnet**. So: source = any chain (mainnet or testnet), sink = Braga. The sink is likewise swappable (Braga decommissions ~Sep 2026 — this is a reference implementation + demo + friction sensor, not a mass-onboarding to Braga).

> RPC notes (verified 2026-06-15): BSC's official `bsc-dataseed*` seeds **disable `eth_getLogs`** (and the bnbchain testnet seed rate-limits it), so they're excluded — publicnode/1rpc/drpc are used. Public endpoints are best-effort; set your own RPC via `source.rpcUrls` for sustained load.

## Going to mainnet (the sink)

The sink is **testnet-locked by default** (Braga). When Arkiv mainnet launches, the swap is **one config field** — pass an `arkivNetwork` and opt in with `allowMainnet: true` (or `ARKIV_ALLOW_MAINNET=1`):

```ts
import { defineConfig, type ArkivNetwork } from 'arkiv-sync'

const ARKIV_MAINNET: ArkivNetwork = {
  chain: /* the arkiv-mainnet viem chain */, name: 'arkiv:mainnet', isTestnet: false,
  explorerUrl: 'https://explorer.…',
}
export default defineConfig({ /* …source… */, arkivNetwork: ARKIV_MAINNET, allowMainnet: true })
```

Guards that always hold (in `assertWritableChain`): a known **EVM mainnet** id (Ethereum/Base/BSC/…) is **never** a valid sink, the RPC's `chainId` must match the configured network, and a non-testnet network is refused without the explicit opt-in. With real funds, sign with a secure signer (KMS/HSM), not a raw `.env` key.

## Project structure

```
src/
  index.ts            public API
  config.ts           defineConfig · createIndexer · quickCheck
  types.ts            SourceAdapter · Sink · Cursor · EventMapper …
  time.ts log.ts util.ts
  source/  chains.ts · rpcPool.ts · evmSource.ts   (read side, per-chain adapter)
  sink/    arkivSink.ts · arkivQuery.ts · predicate.ts   (write side, swappable)
  core/    indexer.ts · cursor.ts · reorg.ts   (the worker)
  bin/cli.ts          `npm start` entrypoint
arkiv.config.ts       demo config (WETH Transfers on Sepolia)
scripts/smoke.ts      live end-to-end smoke (via quickCheck)
test/run.ts           unit tests (dedup · resume · reorg) — no network
skill/                SKILL.md + skill-lock.json (agentskills.io)
create-arkiv-sync/    the `npm create` scaffolder + template/
```

Scripts: `npm start` · `npm run smoke` · `npm test` · `npm run typecheck` · `npm run build`.

## Verification (honest status)

Verified on this machine (Node 22.22.3), **2026-06-15**:

- ✅ `npm run typecheck` — 0 errors.
- ✅ `npm test` — 19/19 (time helpers, idempotency/dedup, restart-resume, reorg detection + re-derivation + per-sync reconcile + deep-reorg, events-per-tick cap, config-fingerprint refusal, **quote-aware predicate-injection rejection, file-cursor fingerprint round-trip, sink chain policy, fromBlock>head guard, addr/uint coercers + secret scrubbing**).
- ✅ `npm run smoke` — **live** Sepolia → Arkiv (Braga) → query, real transactions on the burner wallet (`0x6A79…E274`), cost ~1–3 ×10⁻⁸ GLM/event.
- ✅ **Template final smoke** — `create-arkiv-sync` → `npm install` (packaged tarball) → `npm run verify` indexed a live Sepolia block into Braga and queried it back from the installed package.
- ✅ **Published + hosted** — `arkiv-sync@0.1.0` + `create-arkiv-sync@0.1.0` live on npm (2026-06-15), so `npm create arkiv-sync@latest` works end-to-end. Hosted demo at https://arkiv-indexer.vercel.app (`web-demo/` — bounded serverless that **dogfoods the published package**; verified live: read Sepolia → write Braga → query back).

### Load & limits (stress-tested by 3 models)

Hardcoded guards (so a busy contract can't crash or wedge the worker):
- **`maxEventsPerTick`** (default 2000) bounds memory by event COUNT — a dense tick shrinks its block range instead of loading everything → no OOM.
- **Config-fingerprint refusal** — the worker won't reuse a cursor built for a different contract/events/chain (which would silently mix data); it errors with how to fix.
- **Min poll interval** (≥1s, so a `0` can't hot-loop), **consecutive-failure cap** (stops cleanly instead of an invisible infinite-retry on a dead RPC / unsplittable dense block), **lag warning** (`lagBlocks` — backpressure is now visible), **bulk existence lookup** (one paged query per tick, not N — avoids 429s), **batched deletes**, **429-vs-range classification**, **header caching** across ticks.

Not verified / known limits:
- **Write throughput ceiling ≈ 25 events/sec** — one wallet (single nonce) × ~50 entities per `mutateEntities` tx × Braga ~2s blocks. A contract sustaining more than that lags (it never drops/crashes; the lag is logged). The fix for higher throughput is a **multi-wallet (multi-nonce) pool** — designed-for, not built in v1.
- A **single block** with more matching logs than an RPC will serve **can't be paginated below one block** — the worker fails with an actionable message (use a dedicated/archive RPC); per-block log pagination is a follow-up.
- Reorgs **deeper than `reorgWindow`** (default `confirmations + 6`) can leave orphans below the recorded window until they expire — set `confirmations` above your chain's realistic reorg depth (the default is safe for Sepolia).
- Idempotency assumes the Arkiv query index is consistent shortly after a write (it is, post-confirmation); a crash *mid-tick* plus query lag is the only theoretical double-write window.
- Multichain beyond Sepolia is designed-for but not yet exercised on another chain.

## Security

- The private key signs **locally** (viem), is **never logged** (every log line is scrubbed of key-shaped strings), and **never** appears in the repo (`.env` is gitignored).
- **Testnet-only by allowlist** (default-deny): writes are refused on any chain id that isn't Braga unless explicitly opted in via `ARKIV_ALLOW_CHAIN_ID` (still testnet only). Never mainnet.
- The Arkiv store is **public/shared**, so every read is **owner-scoped and injection-safe** (owner clause first, address validated, values rejected if they contain quotes/comment tokens).

Built by Santiago (Arkiv DevRel). MIT.
