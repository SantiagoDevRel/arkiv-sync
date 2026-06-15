# AGENTS.md

Instructions for AI coding assistants (Cursor, GitHub Copilot, Claude Code, Zed, etc.) working in
**this repository** — the source of the `arkiv-sync` library.

- Contributor guide + engineering invariants: **[CLAUDE.md](./CLAUDE.md)**. User docs: **[README.md](./README.md)**.
- Don't regress the invariants in CLAUDE.md: idempotency key `chainId:txHash:logIndex` + sha256 hash;
  reorg = index `head−confirmations`, roll back to ancestor + re-derive, delete orphans via
  `sink.reconcile`; persisted atomic cursor; TTL in **seconds**; Arkiv update = **full-replace**;
  **never `.orderBy()`** (sort client-side); reads **owner-scoped + injection-safe**; **testnet-only
  allowlist** (never mainnet); the private key is never logged and never committed.
- The Bash tool's real cwd is the parent repo root → wrap commands in `(cd <abs>/indexer && …)`.
- Verify changes: `npm run typecheck` · `npm test` (no network) · `npm run smoke` (live; needs a funded
  Braga testnet `PRIVATE_KEY` in `.env`, gitignored).
- Messaging: Arkiv is a **"queryable database on Ethereum"**; never "decentralized/trustless/permanent".
  For AI use cases say "ephemeral coordination state", not "memory".

The consumer-facing guidance (what an end developer's AI assistant should do with the library) lives
in the template: `create-arkiv-sync/template/AGENTS.md`.
