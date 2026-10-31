# Arkiv Sync hosted sample

Displays EVM-derived Arkiv entities on Rabdi through a server-only read proxy. The existing project is arkiv-indexer; this candidate deploys to preview only. Production is independent.

ARKIV_ACCESS_KEY is the server-side read key; ARKIV_DEMO_OWNER is the public signer address used by the idempotent seed. No private key is needed to read. The page queries the seeded Sepolia WETH contract automatically. Queries use indexed contract, chain_id and schema filters, owner scope and no-store responses.

The preview is read-only. A separately authorized bounded writer requires ENABLE_DEMO_WRITES=1, ARKIV_WRITE_ACCESS_KEY and PRIVATE_KEY. Instance-local operation/nonce guards cannot coordinate serverless cold instances: use the continuous CLI worker for sustained indexing. The browser retains operation state and never reconnects a write stream automatically.

Before release, vendor/arkiv-sync-1.0.0.tgz pins the tested unpublished candidate. SDK and viem are exact registry versions. After approval and publication use exact arkiv-sync 1.0.0 and reverify the registry archive. A preview does not prove registry availability.

The existing static interface is retained to honor the no-new-dependencies constraint. .vercelignore excludes secrets. Node is pinned to 22. The read proxy requires no signing credentials. Verification details live in the lane report.
