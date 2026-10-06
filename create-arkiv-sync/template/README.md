# my-arkiv-sync

A source EVM-to-Arkiv indexer using the SDK 0.8-compatible library. Configure arkiv.config.ts with the source contract, exact event signatures, range, confirmation policy, mapper and intended sink network.

Use Node 20?22 and npm install --ignore-scripts. Configure a locally held funded testnet PRIVATE_KEY in your secret store before npm start. npm run verify performs real bounded writes; obtain network/spend authorization first. Default sink is SDK Tiramisu; Sorbet requires an explicit verified viem Chain. Never paste keys into prompts or invent explorer/faucet URLs.

Read AGENTS.md before changing the worker. Query lowercase stored names and typed SDK 0.8 literals, for example event = str('Transfer'). Pass the sink network to createArkivReader, owner-scope reads, and use queryAll with maxResults for complete pinned pagination. Big integers and expiration blocks are exact decimal strings in DTOs.

The 0.3.0 package is a local candidate until publication. The scaffolder --local option points this consumer at its verified tarball; that does not establish registry availability.
