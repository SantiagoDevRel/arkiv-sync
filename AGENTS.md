# arkiv-sync contributor and consumer guidance

`arkiv-sync` reads confirmed source EVM logs and writes a derived view as public Arkiv entities. The source chain is canonical. This 0.3.0 candidate targets SDK 0.8.1, viem 2 and Node 20–22; check publication before claiming the candidate is on npm.

Run `npm install --ignore-scripts`, `npm run typecheck`, `npm test`, `npm run build`, then `npm pack --ignore-scripts`. Offline tests do not broadcast. `npm run smoke` and `quickCheck` use real funded writes and require a separately authorized account/network/spend budget.

Hard invariants:

- Preserve source identity `chainId:txHash:logIndex`, full sha256 change detection, owner/sync isolation and persisted atomic source checkpoints.
- Default sink is SDK Tiramisu. Ask the developer for the intended sink network, verified RPC/chain ID, native currency and optional explorer. Sorbet requires an explicit viem Chain because SDK 0.8.1 has no sorbet export. Never invent URLs or substitute another network silently.
- Ask for a locally configured funded testnet signer and source contract/event/range/confirmation policy. Never request a private key in chat or log credentials. Known EVM mainnets are forbidden as sinks; source mainnet reads are separate.
- Stored names are lowercase snake_case. Mapping collisions and reserved aliases fail. System block/chain numbers use u64; big integers stay exact through payloads and DTOs.
- Changed records use patch set/unset for full replacement. Patch preserves expiry; Lifetime Extension is atomic only when extendOnUpdate is explicitly enabled. Duration inputs are positive multiples of two seconds, with nominal SDK block conversion.
- Never add orderBy. Fetch fresh block numbers with `cacheTime: 0` before pinning complete pagination or checking source head; viem's default cache can hide a just-confirmed write. Bound every walk; errors discard partial results. Public raw queries use typed SDK 0.8 grammar and safe owner scoping.
- Keep one writer queue per account, coordinate other writers separately and choose batch size from real estimates/encoding/provider limits. There is no verified universal 1,000-op cap or current per-event cost.
- WriteReconciliationRequiredError stops the worker and subsequent writes. Preserve any txHash, authenticate input/receipt/readback and reconcile before restart. The consumer must persist its write journal; restarting does not prove an earlier write failed.
- Reorg cleanup deletes only this worker's owned derived entities after a complete bounded scan. Source RPC failure must not be classified as a reorg. Keep source catch-up/restart/dedup tests.

Architecture: `src/source` reads EVM; `src/core` owns checkpoints/reorg processing; `src/sink` maps current SDK storage/query/mutation semantics. Consumer scaffold guidance lives in `create-arkiv-sync/template/AGENTS.md`. Read `README.md` for exact APIs and SDK 0.6 migration differences.
