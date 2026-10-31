# Verification

arkiv-sync@1.0.0 is published and targets Rabdi with SDK 1.0.0. This branch prepares 1.0.1. Run `npm run typecheck`, `npm test`, `npm run lint` and `npm run build` from the committed revision. Unit tests use deterministic source and actual SDK transport/ABI fixtures; they do not establish live network behavior.

`scripts/seed-rabdi.mjs` replays a fixed real source block and compares its second pass for zero writes. `scripts/live-rabdi.mjs` additionally checks receipts, typed query values and maximum permitted Entity Expiration with the lane's funded wallet. The packed runtime and scaffolder are installed into a clean temporary consumer; that consumer's `npm run verify` exercises Rabdi.

The hosted preview is checked through its own server-side read endpoint and a hydrated browser. No release or production status follows from a preview. Historical evidence JSON files in this directory describe older versions only and must not be used to certify this candidate.

## Durable write recovery

The default sink uses FileWriteJournal beside the checkpoint in .arkiv-sync/. createIndexer also follows a custom FileCursorStore directory; journalDirectory selects another durable directory. Preserve and share this journal across every restart and sink instance using the key. A writable durable volume is required; an ephemeral serverless filesystem is insufficient. MemoryWriteJournal is an explicit test-only alternative.

Admission and consumed attempts are fsynced before broadcast. The wallet transport fsyncs a returned hash before the SDK polls its receipt; SDK success/result is persisted before the separate confirmation lookup. On startup, pending operations reconcile against their hash/receipt and owned entity lookup. Missing/uncertain evidence blocks new writes; it never means resubmit. A confirmed gas-exhausted retry consumes the latest chain nonce, regardless of the original nonce override. The maximum attempt count survives restarts.

All instances share a process-wide queue by chain and signer address. Across processes or deployments use one writer per key; this journal is not a distributed lock. A verified chain reset or expired completed operation requires an explicit new journal generation before re-derivation: retain the old journal and do not silently clear its attempt history. Public preview writes remain off.

Operation identities combine content with a monotonically increasing journal sequence. Returning to earlier content after a confirmed transition or reorg is a new operation; replaying the current state still skips. Historical attempts remain immutable. Transaction evidence with zero attempts is contradictory: preserve the lock and reconcile by hash, never resend.
