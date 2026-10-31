# Consumer guidance

This project uses arkiv-sync 1.0.1 with SDK 1.0.0 and Rabdi. Use Node 20 through 22, `npm install --ignore-scripts`, `npm run typecheck`, `npm run verify`, then `npm start`. Verification signs real testnet writes.

Ask for source chain/RPC, contract/event signatures, block range and confirmation policy; a locally configured funded testnet signer; and an access key from https://hub.arkiv.network/access-keys. Fund the address at https://hub.arkiv.network/faucet. Keep credentials outside Git, prompts, logs and browser bundles. Missing access keys fail closed.

Keep the library's source adapters, atomic cursor, reorg detector and owner/schema/sync-isolated upserts. Identity is chainId:txHash:logIndex plus SHA256 content hash. Store rich JSON in data (unindexed bytes); scalar mapper columns are typed and indexed with snake_case names. Reject reserved names/collisions; exact big integers stay strings in read DTOs.

Configure expirationSeconds as a positive multiple of two seconds, shorter than 7,884,000 Rabdi blocks. Changed entities replace mapped content while preserving Entity Expiration unless extendOnUpdate explicitly requests Lifetime Extension.

Reads require owner scope, typed literals and quoteValue. query is one page; queryAll bounds pages and fails on head drift, duplicate keys or budget overflow. Sort client-side; never add orderBy. Rabdi only serves head state: use latest, never safe/finalized/old hashes.

The library unsigned-estimates each write at latest, sends explicit gas >= max(1,000,000, 2 ? estimate), explicit gasPrice/latest nonce and splits batches below half the block gas limit. Keep a single writer and coordinate any external process. Caller txParams cannot bypass gas safety limits.

Keep one WriteOperation per operation across clicks. SDK success/hash is terminal for sending even when the later receipt is null/disagrees. Uncertain errors stop. A retry is allowed once only for SDK-confirmed revert with authoritative reverted receipt whose gasUsed equals the sent gas; re-estimate and double gas within half-block ceiling. WriteReconciliationRequiredError halts the worker: preserve hash and durable input/progress journal, authenticate receipt/readback and reconcile before restart.

Public text is English: Arkiv entities, the Web3 database, DB-Chain, Entity Expiration and Lifetime Extension. See installed library README for exact APIs.

## Durable write recovery

The default sink uses FileWriteJournal beside the checkpoint in .arkiv-sync/. createIndexer also follows a custom FileCursorStore directory; journalDirectory selects another durable directory. Preserve and share this journal across every restart and sink instance using the key. A writable durable volume is required; an ephemeral serverless filesystem is insufficient. MemoryWriteJournal is an explicit test-only alternative.

Admission and consumed attempts are fsynced before broadcast. The wallet transport fsyncs a returned hash before the SDK polls its receipt; SDK success/result is persisted before the separate confirmation lookup. On startup, pending operations reconcile against their hash/receipt and owned entity lookup. Missing/uncertain evidence blocks new writes; it never means resubmit. A confirmed gas-exhausted retry consumes the latest chain nonce, regardless of the original nonce override. The maximum attempt count survives restarts.

All instances share a process-wide queue by chain and signer address. Across processes or deployments use one writer per key; this journal is not a distributed lock. A verified chain reset or expired completed operation requires an explicit new journal generation before re-derivation: retain the old journal and do not silently clear its attempt history. Public preview writes remain off.

Operation identities combine content with a monotonically increasing journal sequence. Returning to earlier content after a confirmed transition or reorg is a new operation; replaying the current state still skips. Historical attempts remain immutable. Transaction evidence with zero attempts is contradictory: preserve the lock and reconcile by hash, never resend.

The current exact registry dependency is published. New patch preparation does not authorize changing its pin, starting the writer or signing a verification transaction.
