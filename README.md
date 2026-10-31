# Arkiv Sync

Index confirmed EVM contract events into public Arkiv entities on Rabdi, the Web3 database's DB-Chain testnet. The source chain is canonical; the derived view can be rebuilt.

This branch prepares **arkiv-sync 1.0.0** and **create-arkiv-sync 1.0.0** for SDK **1.0.0**. Publication and production promotion require a separate release step. Node 20 through 22 is supported.

## Configure

Get a free [access key](https://hub.arkiv.network/access-keys) and fund a throwaway testnet account at the [faucet](https://hub.arkiv.network/faucet). Configure `ARKIV_ACCESS_KEY` and `PRIVATE_KEY` locally; never put their values in prompts, client bundles or Git.

After release, scaffold with `npm create arkiv-sync@1.0.0 my-indexer`, then `npm install --ignore-scripts`, configure `.env` from `.env.example`, and run `npm run verify`. Verification signs bounded real transactions; `npm start` runs the worker continuously. Before release use the scaffolder's `--local /absolute/arkiv-sync-1.0.0.tgz` option.

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
  map: event => ({ attributes: {
    from: addr(event.args.from), to: addr(event.args.to), value: uint(event.args.value),
  } }),
})
```

`createIndexer(config)` provides `init()`, `runOnce()`, `start()` and `stop()`. `quickCheck(config)` finds a bounded confirmed source block, writes its events and queries them back. Mainnet **source reads** are supported; known EVM mainnets are always forbidden as signing destinations. A custom sink network must match its RPC identity; a non-testnet sink additionally requires explicit `allowMainnet`.

## Stored schema and reads

Writes use a named SDK schema, `arkiv_sync_v1`. System columns `event_id`, `chain_id`, `contract`, `event`, `block` and `sync` are indexed. Mapper names become lowercase snake_case; scalar mapper columns are indexed, while `bytes()` columns are stored only. `content_hash` and `content_type` are stored scalar columns; `data` is an unindexed `bytes()` column containing JSON, with big integers serialized exactly as decimal strings. These names are reserved. Changed entities receive a complete replacement patch, explicitly unsetting removed mapper fields.

```ts
import { createArkivReader, quoteValue } from 'arkiv-sync'
const reader = createArkivReader({ accessKey: process.env.ARKIV_ACCESS_KEY })
const rows = await reader.queryAll(`event = ${quoteValue('Transfer')}`, {
  owner: indexerAddress, maxResults: 1000, limit: 100,
  sortBy: 'block', sortDir: 'desc',
})
// { key, owner, attributes, attributeTypes, data, expiresAtBlock }
```

Every read requires an owner and includes the schema tag. Use typed SDK literals (`str('Transfer')`, `u64(11155111)`) and `quoteValue` for strings; never concatenate untrusted values. `query()` sorts one page; `queryAll()` sorts the complete bounded result on the client. `queryPage()` exposes the next `offset` and response `blockNumber`. SDK 1.0 reads the head, with pages limited to 100. A complete scan aborts on head drift, duplicate keys or its row budget, returning no partial results. It cannot pin historical state; large scans may require narrower source ranges.

## Write safety and Entity Expiration

Every create, patch, Lifetime Extension and reorg cleanup is encoded through the actual SDK before an unsigned estimate at `latest`. A failed estimate stops admission. Gas is at least `max(1_000_000, 2 ? estimate)` with explicit `gasPrice` and a nonce read at `latest`. Batches split before broadcast until gas is at most half the head block limit; an oversized single entity fails. `sinkBatchSize` is a batching policy, not a throughput guarantee.

`ArkivSinkOptions.txParams`, `config.sinkTxParams` and the third argument of `sink.write(entity, onWritten, txParams)` / `writeBatch` allow caller overrides. Gas safety floors and ceilings remain enforced. Nonce overrides belong to one coordinated operation; do not reuse one across multiple batches. Only legacy `gasPrice` overrides are accepted on Rabdi.

An operation keeps a `WriteOperation` instance across calls: `sending` ? `submitted(hash)` ? confirmed or confirmation pending. SDK success never re-enters the send path, even if a subsequent receipt lookup is null or disagrees. Uncertain transport failures stop writes. A confirmed reverted SDK error may retry **once**, only after authoritative receipt gas usage equals the sent gas limit, and a fresh estimate plus doubled gas still fits the half-block ceiling. All other reverts stop. Preserve any hash and reconcile before restarting; a new process does not prove an old write failed. The default file journal persists operation state beside the checkpoint; preserve its durable volume across restarts.

`expirationSeconds` and `SinkRecord.expiresInSeconds` use positive multiples of two seconds, nominally converted to blocks. Rabdi's maximum lifetime is 7,884,000 blocks; this library requires a shorter duration. Patches preserve existing Entity Expiration unless `extendOnUpdate: true` explicitly adds Lifetime Extension. Entities needing a longer life must be extended before expiration. There is no unlimited lifetime or erasure guarantee.

Troubleshooting: `arkiv serves state at the chain head only` means use `latest`, rather than old block hashes, `safe` or `finalized`. A receipt reverted at exactly the gas limit indicates gas exhaustion; use the estimate/headroom rule and the bounded state machine above. `MissingAccessKeyError` links to the Hub instead of silently using an anonymous endpoint.

## Correctness and limits

- Identity is `chainId:txHash:logIndex`; a full SHA256 content hash makes unchanged replays skip writes.
- Atomic persisted checkpoints refuse an incompatible configuration, writer or schema. Keep the cursor directory across restarts.
- Index only `head ? confirmations`. Reorgs roll back to an ancestor, re-derive and reconcile owner/schema/sync-scoped orphans. Transient source RPC failures remain failures, never synthetic reorgs.
- Writers serialize within one sink instance. Coordinate processes using the same signer separately.
- Source RPC limits, deep reorgs beyond the retained window and index visibility lag remain operational constraints. Entity Expiration can remove a derived view even while its cursor is caught up; reseeding/rebuilding needs an explicit source range.

Built-in source keys: `ethereum`, `sepolia`, `base`, `base-sepolia`, `bsc`, `bsc-testnet`; custom source adapters remain supported. Source confirmation defaults live in `src/source/chains.ts`.

## Development

`npm run typecheck`, `npm test` and `npm run build` are offline checks; `npm run smoke` is a funded live check. `npm run lint` validates JavaScript syntax and the current public vocabulary without installing a linter. Pack with `npm pack --ignore-scripts`; scaffold and verify both tarballs before release. [Verification](docs/verification.md) explains evidence boundaries; [CHANGELOG](CHANGELOG.md) lists breaking changes. The [hosted demo](https://arkiv-indexer.vercel.app) is independently deployed; this branch's preview does not change production.

MIT. Built by Santiago (Arkiv DevRel).

## Durable write recovery

The default sink uses FileWriteJournal beside the checkpoint in .arkiv-sync/. createIndexer also follows a custom FileCursorStore directory; journalDirectory selects another durable directory. Preserve and share this journal across every restart and sink instance using the key. A writable durable volume is required; an ephemeral serverless filesystem is insufficient. MemoryWriteJournal is an explicit test-only alternative.

Admission and consumed attempts are fsynced before broadcast. The wallet transport fsyncs a returned hash before the SDK polls its receipt; SDK success/result is persisted before the separate confirmation lookup. On startup, pending operations reconcile against their hash/receipt and owned entity lookup. Missing/uncertain evidence blocks new writes; it never means resubmit. A confirmed gas-exhausted retry consumes the latest chain nonce, regardless of the original nonce override. The maximum attempt count survives restarts.

All instances share a process-wide queue by chain and signer address. Across processes or deployments use one writer per key; this journal is not a distributed lock. A verified chain reset or expired completed operation requires an explicit new journal generation before re-derivation: retain the old journal and do not silently clear its attempt history. Public preview writes remain off.
