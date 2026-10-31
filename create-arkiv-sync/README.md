# create-arkiv-sync

Scaffold an EVM event indexer that writes public Arkiv entities to Rabdi, the Web3 database's DB-Chain testnet (chain ID 7794095). The generated project uses `arkiv-sync@1.0.1` and `@arkiv-network/sdk@1.0.0`. Use Node 22.10+ within the 22.x release line to satisfy the SDK prerequisite and the generated project's engine range.

## Create a project

```sh
npx create-arkiv-sync@1.0.2 my-indexer
cd my-indexer
npm install --ignore-scripts
```

The target directory must be new or empty. The command copies the template and sets the project name; it does not start the worker or sign transactions. Add `--install` to install dependencies with scripts disabled during scaffolding.

Create `.env` from the generated `.env.example` and configure your locally held testnet `PRIVATE_KEY` and `ARKIV_ACCESS_KEY`. Obtain a free [access key](https://hub.arkiv.network/access-keys) and [testnet GLM](https://hub.arkiv.network/faucet). Keep both credentials server-side in the Node worker; never put them in Git, prompts, logs or browser bundles. Never send a private key in chat. A provider access key does not replace a funded signing account.

Edit `arkiv.config.ts` to select the source chain/RPC, contract, exact event signatures, block range and confirmation policy. The template starts with Sepolia WETH Transfer events and Rabdi as its destination.

```sh
npm run typecheck
npm run verify
npm start
```

`verify` signs bounded real testnet writes and queries them back. `start` runs continuously. Use only public, non-sensitive source data. Configure Entity Expiration explicitly; it does not erase historical bytes or copies. Preserve the generated `.arkiv-sync/` checkpoints and write journal on a durable volume across restarts. Pending or uncertain writes require reconciliation before restarting; never assume a timeout authorizes resubmission.

## Test a local library archive

```sh
node /absolute/path/to/create-arkiv-sync/index.mjs my-indexer --local /absolute/path/to/arkiv-sync-1.0.1.tgz
```

`--local` sets the generated project's `arkiv-sync` dependency to a local tarball or directory. It does not change the SDK dependency or certify registry publication.

## Integration guidance

Read the generated `README.md` and `AGENTS.md` before running writes. The [arkiv-sync README](https://github.com/SantiagoDevRel/arkiv-sync#readme) documents the exact APIs, owner-scoped reads, schema, Entity Expiration and Lifetime Extension, gas estimation and durable recovery. [arkiv-sync on npm](https://www.npmjs.com/package/arkiv-sync) is the runtime library; this package only scaffolds its consumer project.

Rabdi serves state at the chain head only: use `latest` rather than old block hashes, `safe` or `finalized`. For a revert at the gas limit, retain the transaction evidence and follow the library's gas estimation and bounded retry guidance; successful or uncertain submissions must never be resent automatically.

