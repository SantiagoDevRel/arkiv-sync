# arkiv-sync contributor and consumer guidance

Reads confirmed source EVM logs and writes a derived view as public Arkiv entities. The source chain is canonical. This branch prepares version 1.0.0 against SDK 1.0.0; never infer registry publication from package metadata.

Use Node 20 through 22. Run `npm install --ignore-scripts`, `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` and `npm pack --ignore-scripts`. Offline tests never sign. `npm run smoke` and scaffold `npm run verify` sign bounded live writes and need an authorized funded testnet account.

Ask for source chain/RPC, contract/event signatures, range and confirmation policy. Ask for a locally configured signer and free access key from https://hub.arkiv.network/access-keys; fund the address at https://hub.arkiv.network/faucet. Never request keys in chat. Rabdi is chain 7794095; `createRabdiNetwork(accessKey)` builds SDK `rabdi({ accessKey })`. Missing access keys fail closed. Known EVM mainnets are forbidden sinks; source reads sign nothing.

Preserve these invariants:
- Identity `chainId:txHash:logIndex`, SHA256 content hashing, owner/schema/sync isolation and atomic persisted checkpoints. Storage version changes refuse old cursors.
- Index source head minus confirmations. Reorgs roll back to the ancestor, re-derive and remove only this worker's orphaned entities using `sink.reconcile`. Source RPC errors throw rather than pretending a block vanished.
- Schema `arkiv_sync_v1` uses indexed system and scalar mapper columns. Names map to lowercase snake_case; reject collisions and reserved names. Rich JSON is stored in unindexed `data: bytes()`, never filtered directly. Exact big integers remain strings in DTOs.
- `expirationSeconds` is a positive multiple of two seconds. Rabdi duration must be below 7,884,000 blocks. Changed entity patches explicitly unset old fields and preserve expiration; only `extendOnUpdate` adds Lifetime Extension. No unlimited lifetime.
- Every write uses explicit gas/gasPrice and latest nonce. Encode with the SDK, estimate unsigned at latest, gas >= max(1,000,000, 2 ? estimate); never exceed half the head gas limit. Split batches before sending. Estimate failure stops admission; caller overrides cannot bypass ceilings.
- Preserve one WriteOperation per user operation. SDK success stores submitted(hash) before receipt lookup and never sends again. Null/disagreeing lookup means pending. Uncertain errors block. Retry once only for SDK-confirmed revert plus authoritative reverted receipt with gasUsed == sent gas, with fresh latest estimate and doubled gas within half-block ceiling. Preserve hashes and a durable input/progress journal before restarting.
- One exclusive writer per account/process. Coordinate other processes separately; batch size is a policy, not a measured capacity promise.
- Every reader is owner-scoped and schema-scoped with injection-safe predicates. SDK 1 uses head-only offset pages, max 100. Complete bounded scans abort on block drift, duplicate keys or bounds; no partial cleanup. Sort client-side; do not add orderBy.

Troubleshooting must cover both head-only state errors (read latest, not safe/finalized/old hashes) and reverts at the gas limit (estimate/headroom plus bounded retry). Never print access-key RPC paths or raw wallet errors. Use `scrubSecrets`.

Public copy is English: "Arkiv entities", "the Web3 database", "DB-Chain", "Entity Expiration", "Lifetime Extension"; AI applications use "ephemeral coordination state". Consumer scaffold instructions live in `create-arkiv-sync/template/AGENTS.md`. See README.md for exact APIs and CHANGELOG.md for breaking changes.

## Durable write recovery

The default sink uses FileWriteJournal beside the checkpoint in .arkiv-sync/. createIndexer also follows a custom FileCursorStore directory; journalDirectory selects another durable directory. Preserve and share this journal across every restart and sink instance using the key. A writable durable volume is required; an ephemeral serverless filesystem is insufficient. MemoryWriteJournal is an explicit test-only alternative.

Admission and consumed attempts are fsynced before broadcast. The wallet transport fsyncs a returned hash before the SDK polls its receipt; SDK success/result is persisted before the separate confirmation lookup. On startup, pending operations reconcile against their hash/receipt and owned entity lookup. Missing/uncertain evidence blocks new writes; it never means resubmit. A confirmed gas-exhausted retry consumes the latest chain nonce, regardless of the original nonce override. The maximum attempt count survives restarts.

All instances share a process-wide queue by chain and signer address. Across processes or deployments use one writer per key; this journal is not a distributed lock. A verified chain reset or expired completed operation requires an explicit new journal generation before re-derivation: retain the old journal and do not silently clear its attempt history. Public preview writes remain off.
