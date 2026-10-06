# Consumer guidance

This project reads source EVM events into a derived Arkiv view using the SDK 0.8-compatible arkiv-sync 0.3 package. Node 20?22 is supported. Use npm install --ignore-scripts; npm start runs the worker. npm run verify performs actual funded writes, not a readonly check.

Ask the developer for the source chain/RPC, contract/event signatures, block range and confirmation policy; the sink testnet/RPC/chain configuration; a locally configured funded signer; and an approved spend budget. Keep PRIVATE_KEY/access keys in a server secret store, never prompts/bundles/logs. The default sink is SDK Tiramisu. Sorbet needs an explicit operator-verified viem Chain; no sorbet export exists in SDK 0.8.1.

Do not replace the library's source adapters, cursor, reorg detector or owner/sync-isolated upserts. Query stored lowercase names: event_id, chain_id, content_hash and camelCase-to-snake_case mapper names. Never override reserved names or create collisions. Rich data belongs in payload; bigint DTO values stay exact strings.

Lifetime values are seconds and positive multiples of two. A changed record patch replaces payload/attributes but keeps its deadline unless extendOnUpdate:true is explicitly chosen. Read actual expiration blocks; no wall-clock or erasure guarantee.

Use typed query literals and quoteValue. query is one page; queryPage returns cursor plus block; queryAll pins all bounded pages and sorts client-side. Never add orderBy or return partial results after cursor/budget failure.

WriteReconciliationRequiredError halts the worker. Preserve its known txHash plus durable input/progress journal, authenticate sender/native input/receipt/readback and reconcile before restart. Missing hash does not prove no transaction landed. One instance serializes writes; coordinate other signers/processes separately. Batch size is chosen from real gas/encoding/provider/budget evidence, not a universal 1,000-op cap.
