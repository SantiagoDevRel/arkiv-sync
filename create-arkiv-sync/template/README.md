# My Arkiv Sync indexer

EVM contract events become public Arkiv entities on Rabdi, the Web3 database's DB-Chain testnet. Requires Node 20 through 22 and SDK 1.0.0.

Run `npm install --ignore-scripts`. Configure `.env` from `.env.example` with your locally held funded testnet `PRIVATE_KEY` and `ARKIV_ACCESS_KEY`. Get a free [access key](https://hub.arkiv.network/access-keys) and [testnet funds](https://hub.arkiv.network/faucet). Never paste credentials into prompts or commit them.

Edit `arkiv.config.ts` with your source contract, exact event signatures, block range and confirmation policy. `npm run verify` signs bounded real writes and reads them back. `npm start` runs continuously; preserve `.arkiv-sync/` checkpoints across restarts. `npm run typecheck` checks the consumer configuration.

Use `expirationSeconds` in seconds (positive multiples of two), below Rabdi's maximum lifetime. Patches preserve Entity Expiration unless explicit `extendOnUpdate` requests Lifetime Extension. Query owner-scoped lowercase stored names and typed literals, such as `event = str('Transfer')`; JSON is in an unindexed `data` bytes column. `queryAll` rejects incomplete/head-drifted scans and sorts client-side.

See AGENTS.md and the installed library README for gas estimation, bounded retry and reconciliation. A pending/uncertain write must be reconciled before restarting; a new process is not evidence of failure.
