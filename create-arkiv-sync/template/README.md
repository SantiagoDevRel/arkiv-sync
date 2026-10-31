# My Arkiv Sync indexer

EVM contract events become public Arkiv entities on Rabdi, the Web3 database's DB-Chain testnet. Requires Node 20 through 22 and SDK 1.0.0.

Run `npm install --ignore-scripts`. Configure `.env` from `.env.example` with your locally held funded testnet `PRIVATE_KEY` and `ARKIV_ACCESS_KEY`. Get a free [access key](https://hub.arkiv.network/access-keys) and [testnet funds](https://hub.arkiv.network/faucet). Never paste credentials into prompts or commit them.

Edit `arkiv.config.ts` with your source contract, exact event signatures, block range and confirmation policy. `npm run verify` signs bounded real writes and reads them back. `npm start` runs continuously; preserve `.arkiv-sync/` checkpoints across restarts. `npm run typecheck` checks the consumer configuration.

Use `expirationSeconds` in seconds (positive multiples of two), below Rabdi's maximum lifetime. Patches preserve Entity Expiration unless explicit `extendOnUpdate` requests Lifetime Extension. Query owner-scoped lowercase stored names and typed literals, such as `event = str('Transfer')`; JSON is in an unindexed `data` bytes column. `queryAll` rejects incomplete/head-drifted scans and sorts client-side.

See AGENTS.md and the installed library README for gas estimation, bounded retry and reconciliation. A pending/uncertain write must be reconciled before restarting; a new process is not evidence of failure.

## Durable write recovery

The default sink uses FileWriteJournal beside the checkpoint in .arkiv-sync/. createIndexer also follows a custom FileCursorStore directory; journalDirectory selects another durable directory. Preserve and share this journal across every restart and sink instance using the key. A writable durable volume is required; an ephemeral serverless filesystem is insufficient. MemoryWriteJournal is an explicit test-only alternative.

Admission and consumed attempts are fsynced before broadcast. The wallet transport fsyncs a returned hash before the SDK polls its receipt; SDK success/result is persisted before the separate confirmation lookup. On startup, pending operations reconcile against their hash/receipt and owned entity lookup. Missing/uncertain evidence blocks new writes; it never means resubmit. A confirmed gas-exhausted retry consumes the latest chain nonce, regardless of the original nonce override. The maximum attempt count survives restarts.

All instances share a process-wide queue by chain and signer address. Across processes or deployments use one writer per key; this journal is not a distributed lock. A verified chain reset or expired completed operation requires an explicit new journal generation before re-derivation: retain the old journal and do not silently clear its attempt history. Public preview writes remain off.

Operation identities combine content with a monotonically increasing journal sequence. Returning to earlier content after a confirmed transition or reorg is a new operation; replaying the current state still skips. Historical attempts remain immutable. Transaction evidence with zero attempts is contradictory: preserve the lock and reconcile by hash, never resend.
