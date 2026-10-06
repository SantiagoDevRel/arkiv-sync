# arkiv-sync

Read events from a source EVM chain and store a derived, queryable view as Arkiv entities. The source chain stays canonical. This is an EVM-to-Arkiv indexer; an Arkiv-to-application mirror is a separate integration.

## SDK 0.8 migration candidate

This source targets `arkiv-sync@0.3.0`, `@arkiv-network/sdk@0.8.1`, viem 2 and Node 20–22. Version 0.3.0 is a local candidate until it is published. Test the built tarball directly; `npm install arkiv-sync@latest` may still install the older SDK 0.6 package.

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run build
npm pack --ignore-scripts
```

The tests use deterministic source adapters and actual SDK clients with an in-memory RPC transport. They do not send network transactions. Funded testnet receipt/readback evidence must be recorded separately.

The current candidate validates signing admission before source construction and passes52 offline cases plus18 scaffold checks. A separate actual Tiramisu continuation follows the public source/indexer/sink through a paginated reader, persisted SQLite, authenticated API and React. See [verification](docs/verification.md) for exact source digests, receipts and limits; earlier funded records retain their original bundle identity.

## Configure source and sink

```typescript
import { defineConfig, days, addr, uint } from 'arkiv-sync'

export default defineConfig({
  source: {
    chain: 'sepolia',
    contract: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
    events: ['Transfer(address indexed from, address indexed to, uint256 value)'],
    fromBlock: 'latest',
  },
  ttlSeconds: days(30),
  map: ({ args }) => ({ attributes: {
    from: addr(args.from), to: addr(args.to), value: uint(args.value),
  } }),
})
```

Built-in source keys are `ethereum`, `sepolia`, `base`, `base-sepolia`, `bsc`, and `bsc-testnet`; custom `SourceChainDef` values are supported. Verify current RPC reachability, source chain ID and confirmation policy for the selected source. Mainnet source reads do not authorize sink writes on a mainnet.

The default sink uses the published SDK Tiramisu chain. For another Arkiv testnet, supply `arkivNetwork` with an explicit verified viem `Chain`, `name` and `isTestnet: true`. Sorbet is not exported by SDK 0.8.1; use `defineChain` from viem with operator-provided chain ID, RPC and native-currency configuration. Do not invent an SDK chain import, explorer or faucet URL.

Set a locally held, funded testnet `PRIVATE_KEY` and optional `ARKIV_RPC_URL` in the consumer's secret store. Keep the key out of prompts, bundles, URLs and logs. `createIndexer` also accepts a caller-owned `sink`; `ArkivSink` accepts exactly one `account` or `privateKey`, plus an optional custom transport. The library validates the observed RPC chain ID before each admitted write and always refuses known EVM-mainnet sink IDs.

```typescript
import { ArkivSink, createIndexer, silentLogger } from 'arkiv-sync'
import type { ArkivNetwork } from 'arkiv-sync'
import type { Account } from 'viem'

export function withOperatorSink(config: Parameters<typeof createIndexer>[0],
  account: Account, network: ArkivNetwork) {
  const sink = new ArkivSink({ account, network, logger: silentLogger, batchSize: 50 })
  return createIndexer(config, { sink })
}
```

Run the scaffold or CLI only after source/sink preflight and an approved spend budget. `npm run smoke` and the scaffold's `npm run verify` execute real writes; they are not readonly checks.

## Stored attributes and replacement

Arkiv Sync stores lowercase names. The stable mapping converts camelCase to snake_case: `eventId` → `event_id`, `chainId` → `chain_id`, `contentHash` → `content_hash`, and `tokenId` → `token_id`. A mapping collision such as `fooBar` plus `foo_bar` fails before writes. Query the stored names.

The indexer reserves `event_id`, `chain_id`, `content_hash`, `contract`, `event`, `block` and `sync`, including camelCase aliases. `block` and `chain_id` use `u64`; mapper attributes support SDK tagged values and bare scalars. Put rich objects, arrays and nulls in payload. The default payload keeps block numbers as exact decimal strings; activity events do too.

`SinkRecord.expiresInSeconds` and mapper `ttlSeconds` remain seconds. SDK 0.8 requires a positive multiple of two; its duration helpers use nominal two-second blocks, not exact wall-clock expiration. Read the actual `expiresAt` deadline from chain state.

A changed existing record replaces payload, MIME and attributes by combining `set` with `unset` for omitted old attributes. **Its existing deadline stays unchanged by default.** Set `extendOnUpdate: true` on the mapper result or `SinkRecord` to include Lifetime Extension in the same atomic batch. The extension targets at least the old observed deadline plus one block and the requested minimum lifetime. It never intentionally shortens expiry; concurrent external changes can cause rejection and require reconciliation.

## Reading the derived view

```typescript
import { createArkivReader, quoteValue } from 'arkiv-sync'
import type { Hex } from 'arkiv-sync'

export async function transferRows(owner: Hex, syncId: string) {
  const reader = createArkivReader()
  return reader.queryAll(`sync = ${quoteValue(syncId)}`, {
    owner, limit: 200, maxResults: 1000, sortBy: 'block', sortDir: 'desc',
  })
}
```

Pass the sink's chain and transport/RPC to the reader when using another network. Reads are public; owner scoping identifies the current writer, not an app-user authorization boundary. Internal sink queries use typed expressions and owner/sync scopes. Public raw predicates must use SDK 0.8 typed literals (`str('...')`, `u64(...)`, `addr(...)`) and `AND`/`OR`; `quoteValue` and scope validation conservatively refuse quotes/backslashes/comment tokens supplied as values.

`query()` returns one page and sorts only that page. `queryPage()` also returns the cursor and snapshot block. Reuse a cursor with its original block/query/projection/page size. `queryAll()` reads a fresh head unless you supply `atBlock`, pins that block, walks every page within `maxResults`, and sorts the complete bounded collection client-side. Sink scans and source head checks also bypass viem's block-number cache, so an immediate repeat can observe a confirmed write. Cursor, repeated-cursor, snapshot and bound failures return no partial collection.

DTOs retain `key`, owner, creator, data, `expiresAtBlock` and `attributeTypes`. Big integer attributes are decimal strings; i32 numbers and booleans retain their types. Decimal sorting avoids unsafe Number conversion. There is no server-side `orderBy` or global aggregate API here.

## Recovery and spend

- Event identity is source `chainId:transactionHash:logIndex`; full sha256 covers normalized typed attributes, JSON payload, MIME and lifetime/update policy.
- One instance serializes its writes. Other processes/wallet users need shared coordination or exclusive custody; a process-local queue cannot reserve their nonces.
- `executeBatch` supports creates, patches, deletions and explicit extensions. `batchSize` is a configurable package policy, not a verified 1,000-operation protocol limit. Choose it from exact encoded size, gas estimates, provider limits and approved spend.
- Source checkpoints advance after successful processing. Reorg recovery re-derives canonical source logs and reconciles only current owner/sync-scoped derived entities. A bounded scan must complete before deletions are admitted.
- `maxEventsPerTick` stops between completed source fetch chunks. One dense chunk/block can exceed the threshold; checkpoints keep whole fetched blocks so no logs are dropped. It is not a hard memory bound.
- `WriteReconciliationRequiredError` preserves a known `txHash` and stops the worker and later sink writes. A missing hash still means the outcome may be unknown. Reconcile sender/native input/receipt/rows before restarting; the sink does not persist a transaction journal or automatically authorize another send.
- Use durable per-write callbacks/journals in the consumer for crash recovery. Callback failure after a successful write also stops with its known hash. SDK event-decoding failure does not mean the write failed.
- `spendReport()` is a balance delta and can include unrelated transfers. Actual receipts and `gasUsed × effectiveGasPrice` establish transaction fees; no historical Braga throughput or per-event cost applies to current networks.

Entity Expiration/deletion remove live query state; they do not retract previously downloaded copies or establish an archive policy. Store only intended public data or independently encrypted payloads.

## Scaffold

Build and pack the local candidate, then run:

```sh
node create-arkiv-sync/index.mjs my-indexer --local /absolute/path/arkiv-sync-0.3.0.tgz
```

The generated consumer includes `AGENTS.md` and its `CLAUDE.md` pointer. After a compatible release is actually published, `npm create arkiv-sync@latest` can consume it. Local tarball tests do not establish npm availability.
