# arkiv-sync — CLAUDE.md

**A chain→Arkiv indexer.** Point it at any contract on any EVM chain (Sepolia v1) and its on-chain events become a **queryable Arkiv database** (Braga testnet). Library-first; a skill and a `npm create` template sit on top. Part of Santiago's Arkiv DevRel work (`../CLAUDE.md`, `../handoff.md`); this is its **own git repo** (`git init` here), separate from the MCP.

> Read [`README.md`](./README.md) first — it has the full architecture, requirements, quickstart, and the verification status.

## Architecture (3 modes, don't conflate)

- **npm library** = the RUNTIME (`src/`). The 24/7 worker. This is the backbone.
- **Skill** = the KNOWLEDGE (`skill/SKILL.md` + `skill-lock.json`, agentskills.io spec). Teaches an LLM to wire the library.
- **Template** = `create-arkiv-sync/` (`npm create arkiv-sync`). A ready project that indexes on `npm start`.

Seams that keep it swappable: `SourceAdapter` (per-chain reads — `src/source/`) is separate from `Sink` (where the derived view lives — `src/sink/`). **Arkiv = a derived view, not a second source of truth** — the chain is canonical, so the view is always re-derivable (this is what makes reorgs/restarts safe). **Braga decommissions ~Sep 2026** → the sink is a swappable adapter; never couple to Braga.

## Ground truth (MUTABLE — re-verify at docs.arkiv.network)

- **Sink — Braga:** chainId `60138453102` · GLM · RPC `https://braga.hoodi.arkiv.network/rpc` · faucet `https://braga.hoodi.arkiv.network/faucet/` · explorer `https://explorer.braga.hoodi.arkiv.network`.
- **Source — Sepolia:** chainId `11155111` · public RPC pool (publicnode / 1rpc / drpc verified live 2026-06-14) with viem `fallback` rotation.
- **Versions:** `@arkiv-network/sdk ^0.6.8`, `viem ^2.38.2`, **Node 20–22 (NOT 24** — hangs Arkiv updates, sdk-js #14).

## How to run

```bash
npm install
cp .env.example .env          # PRIVATE_KEY = a funded Braga TESTNET burner (faucet above)
npm run typecheck             # tsc, 0 errors
npm test                      # 10 unit tests (no network): dedup, resume, reorg
npm run smoke                 # LIVE end-to-end: real Sepolia block → Arkiv → query back
npm start                     # runs arkiv.config.ts (WETH Transfers on Sepolia)
npm run build                 # esbuild → dist/ (+ .d.ts); needed before `npm pack`
```

**The Bash tool's real cwd is the parent repo root, not this folder** — wrap commands in `(cd "<abs path>/indexer" && …)`.

**Smoke wallet:** the live smoke uses `hackathon-wallets/wallets.json` **index 25** (`0x6A79…E274`, ~1 GLM on Braga) as a throwaway burner, written into `.env` (gitignored, never printed). Indices 1 + 50 are reserved — don't use them.

## Hard rules (engineering invariants — don't regress)

- **Idempotency key = `chainId:txHash:logIndex`.** Writes are create-or-skip by sha256 content hash. Never double-write.
- **Reorgs:** index `head − confirmations`; on reorg, roll back to the common ancestor and re-derive; delete orphans via `sink.reconcile` (block-range, owner-scoped). A transient RPC error must THROW (retry), never be read as a reorg.
- **`expiresIn`/TTL is in SECONDS.** Use `days()/hours()/minutes()`. Never ms.
- **Arkiv update = full-replace** → always send the complete record.
- **NEVER `.orderBy()`** (no functional server-side order; removed in SDK 0.7.0). Sort client-side.
- **Arkiv store is PUBLIC/shared** → every read is owner-scoped + injection-safe (`src/sink/predicate.ts`: owner clause first, address validated, values reject quotes/comment tokens).
- **viem is a direct dep** (the source reads a non-Arkiv chain). Keep it pinned to the SDK's range so there's one viem instance.
- **Testnet-only allowlist** (default-deny); never mainnet. Key never logged (`scrubSecrets`), never committed.

## Messaging (engagement rules)

- Lead with **"queryable database on Ethereum"** (vs Supabase). **Never** "decentralized/trustless/permanent" (there's no permanence primitive; TTLs expire).
- For AI: **"ephemeral coordination state"**, not "memory".
- UI/copy = Colombian Spanish, tú-form. No overclaim; re-verify network facts.

## Quality gates run (2026-06-15)

Multi-model adversarial gate, 3 lenses. **claude + agy** (Fase 1): hardened query-injection/owner-scoping, reorg reconciliation across ticks + deep reorgs, transient-RPC-vs-reorg, atomic delete, sha256 dedup, batched `mutateEntities` writes, bigint coercion, testnet allowlist. **codex** (final pass, returned after rate-limit) found 6 more — all applied: (1) reconcile scoped by a `sync` attribute so two indexers sharing a wallet don't delete each other; (2) balanced-paren/quote validation so `||`/`)` can't escape owner scope in `arkivQuery`; (3) detectReorg runs BEFORE the caught-up early return; (4) `contentHash` now covers contentType + expiresIn + typed attributes (full sha256); (5) `writeBatch` dedupes input + runs the whole plan in one write-lock; (6) `BlockNotFoundError` re-checks head to tell a lagging RPC from a real reorg. Re-verified each round: typecheck 0 · **11 unit tests** · live smoke · template smoke. See README "Verification".

## Load / resilience gate (2026-06-15, 3 models)

Second adversarial gate — "break the worker under load" (claude + agy + codex, strong convergence). Hardcoded guards added + verified (13 unit tests + live smoke): **`maxEventsPerTick`** (bounds memory by event count — shrinks the range, no OOM), **config-fingerprint refusal** (won't reuse a cursor for a different contract/events/chain), **min poll interval** (a `0` can't hot-loop), **consecutive-failure cap** (clean stop vs infinite wedge), **`lagBlocks` observability** (backpressure visible), **bulk existence lookup** (1 paged query/tick vs N → no 429 storm), **batched deletes** in reconcile, **429-vs-range classification** (don't amplify rate-limits), **header caching** across ticks, **actionable poison-pill-block error**. Backpressure model: chain+cursor is the buffer (no in-memory queue, nothing dropped); overload = visible lag. Known ceiling ≈ **25 events/sec** (one wallet × 50/tx × Braga ~2s) → multi-wallet pool is the documented follow-up for higher throughput.

## Dogfooding / friction captured for product

- `quickCheck(config)` doubles as a friction sensor (`npm run verify` in the template).
- Build friction worth flagging to the Arkiv team: SDK type `TS2742` portability error needed an explicit return-type annotation; `mutateEntities` returns only a tx hash (no per-entity keys for batched creates); the SDK re-exports viem but a non-Arkiv source still needs viem directly; numeric range predicates (`block > N`) work and are essential for reorg reconciliation.
