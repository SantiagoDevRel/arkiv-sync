# Arkiv Sync hosted sample

Displays EVM-derived Arkiv entities on Rabdi through a server-only read proxy. The existing preview and production project is arkiv-indexer.

ARKIV_ACCESS_KEY is the server-side read key; ARKIV_DEMO_OWNER is the public signer address used by the idempotent seed. No private key is needed to read. The page queries the seeded Sepolia WETH contract automatically. Queries use indexed contract, chain_id and schema filters, owner scope and no-store responses.

The hosted demo is read-only. A separately authorized bounded writer requires ENABLE_DEMO_WRITES=1, ARKIV_WRITE_ACCESS_KEY and PRIVATE_KEY. Process-wide operation/nonce guards cannot coordinate serverless cold instances: use one continuous CLI worker per signer with durable storage. The browser retains operation state and never reconnects a write stream automatically.

The demo and scaffold use exact registry arkiv-sync 1.0.1 and SDK 1.0.0; viem is pinned exactly as well. No package archive is vendored. scripts/verify-registry-dgx.sh checks both published archive hashes, scaffolds from the packed registry package, installs and compiles the generated project, and builds the demo.

The existing static interface is retained to honor the no-new-dependencies constraint. .vercelignore excludes secrets. Node is pinned to 22. The read proxy requires no signing credentials. Verification details live in the lane report.
