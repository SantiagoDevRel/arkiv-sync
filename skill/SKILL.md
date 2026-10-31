---
name: arkiv-sync
description: Build a checkpointed EVM contract-event indexer with arkiv-sync on Rabdi. Use for derived event feeds, reorg recovery and idempotent replay; use direct Arkiv entity APIs for application state without an EVM event source.
license: MIT
metadata:
  arkiv.skill-version: "2.0.0"
  arkiv.npm-package: "arkiv-sync"
  arkiv.sdk-range: "^1.0.0"
  arkiv.sdk-verified: "1.0.0"
  arkiv.network-fingerprint: "rabdi:7794095"
---

# Arkiv Sync

Use the library runtime to derive public Arkiv entities from confirmed EVM logs. Arkiv is the Web3 database; the source chain remains canonical. Read the installed package README and AGENTS.md before wiring its config. This recipe targets arkiv-sync 1.0.1: install `npm install --save-exact arkiv-sync@1.0.1 @arkiv-network/sdk@1.0.0`.

Ask for source chain/RPC, contract and exact indexed event signatures, backfill range, confirmation policy, a locally configured funded Rabdi testnet signer and an access key. Obtain keys at https://hub.arkiv.network/access-keys and testnet funds at https://hub.arkiv.network/faucet. Never request secret values in chat. `MissingAccessKeyError` must produce the helpful Hub link; do not silently use anonymous RPCs.

Use Node 20 through 22, `defineConfig`, `createIndexer` or the `create-arkiv-sync` scaffolder. `npm run verify` signs bounded real writes; `npm start` runs continuously. Preserve the persisted cursor directory. Source mainnet reads sign nothing; known EVM mainnets are forbidden sinks. Rabdi chain ID is 7794095; the SDK constructor is `rabdi({ accessKey })`, exposed by the library as `createRabdiNetwork(accessKey)`.

```ts
import { defineConfig, days, addr, uint } from 'arkiv-sync'
export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    events: ['Transfer(address indexed from, address indexed to, uint256 value)'],
    fromBlock: 'latest',
  },
  expirationSeconds: days(30),
  map: e => ({ attributes: { from: addr(e.args.from), to: addr(e.args.to), value: uint(e.args.value) } }),
})
```

Do not reimplement the engine's identity `chainId:txHash:logIndex`, SHA256 content hashing, atomic checkpoints, confirmed head policy or owner/schema/sync-scoped reorg reconciliation. Transient source RPC errors throw; they never imply a reorg. An incompatible source/writer/schema fingerprint refuses old checkpoints.

The named schema `arkiv_sync_v1` declares typed indexed system and scalar mapper columns. Mapper names become snake_case. Rich JSON belongs in `data`, an unindexed `bytes()` column; bytes cannot be filtered. Changed entities explicitly unset removed fields while preserving expiration unless `extendOnUpdate` requests Lifetime Extension. Exact big integers stay decimal strings in read DTOs.

Every read requires an owner. Use typed SDK literals and `quoteValue`; never interpolate raw user input. SDK 1.0 pages by offset at the head, at most 100 entities per page. `queryAll` requires maxResults, aborts on head drift/duplicate keys/bounds and sorts client-side. Do not add orderBy. No historical snapshot pinning is available; narrow large scans instead of returning incomplete data.

Every write uses explicit gas/gasPrice and nonce at latest. Encode through the SDK, unsigned-estimate at latest, choose gas >= max(1,000,000, 2 ? estimate), split batches until gas <= half the head gas limit, and stop on estimate errors. The library does this for public APIs, including per-write txParams overrides. Never guess a near-block-limit gas budget.

Keep one WriteOperation state instance for each operation across clicks/re-renders: guard sending before network calls. SDK success stores submitted(hash) before looking up its receipt; no subsequent outcome may resend. Null/disagreeing lookup is confirmation pending, with hash. Uncertain errors require checking before retrying. Only an SDK-confirmed revert plus an authoritative reverted receipt with gasUsed == sent gas can retry once; re-estimate latest and double gas within the half-block ceiling. All other reverts terminate. Preserve the hash and durable input/progress journal; reconcile before restart.

Entity Expiration uses positive multiples of two seconds. Rabdi lifetime must be shorter than 7,884,000 blocks; longer-lived entities require Lifetime Extension before expiration. Never promise an unlimited lifetime. Testnet resets require idempotent reseeding from a fixed source range.

Troubleshoot `arkiv serves state at the chain head only` by reading latest instead of safe/finalized/old hashes. A revert at exactly the gas limit needs estimate/headroom and the bounded retry rule above. Keep access keys server-side for shared read proxies; browser wallet writers use their own configured RPC. AI integrations use the phrase "ephemeral coordination state".

## Durable write recovery

The default sink uses FileWriteJournal beside the checkpoint in .arkiv-sync/. createIndexer also follows a custom FileCursorStore directory; journalDirectory selects another durable directory. Preserve and share this journal across every restart and sink instance using the key. A writable durable volume is required; an ephemeral serverless filesystem is insufficient. MemoryWriteJournal is an explicit test-only alternative.

Admission and consumed attempts are fsynced before broadcast. The wallet transport fsyncs a returned hash before the SDK polls its receipt; SDK success/result is persisted before the separate confirmation lookup. On startup, pending operations reconcile against their hash/receipt and owned entity lookup. Missing/uncertain evidence blocks new writes; it never means resubmit. A confirmed gas-exhausted retry consumes the latest chain nonce, regardless of the original nonce override. The maximum attempt count survives restarts.

All instances share a process-wide queue by chain and signer address. Across processes or deployments use one writer per key; this journal is not a distributed lock. A verified chain reset or expired completed operation requires an explicit new journal generation before re-derivation: retain the old journal and do not silently clear its attempt history. Public preview writes remain off.

Operation identities combine content with a monotonically increasing journal sequence. Returning to earlier content after a confirmed transition or reorg is a new operation; replaying the current state still skips. Historical attempts remain immutable. Transaction evidence with zero attempts is contradictory: preserve the lock and reconcile by hash, never resend.
