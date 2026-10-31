# Hosted sample

The existing Vercel project is arkiv-indexer. The approved SDK 1.0/Rabdi release uses exact registry arkiv-sync 1.0.0 in preview and production.

Keep read access keys server-side as ARKIV_ACCESS_KEY, and configure the public owner with ARKIV_DEMO_OWNER. Reads use this application's /api/query endpoint and SDK 1.0/Rabdi typed owner/schema-scoped predicates. Never infer the owner from a private key.

The hosted demo is read-only. A separately authorized writer requires ENABLE_DEMO_WRITES, ARKIV_WRITE_ACCESS_KEY and its own testnet PRIVATE_KEY. Keep operation state across requests and stop on uncertainty. Process-wide guards do not coordinate serverless cold instances; prefer the continuous CLI worker with durable storage.

Retain the existing static UI for this dependency-restricted migration. Keep all visible text English and verify three widths plus empty/error states. Credentials must never enter HTML, client requests, errors or screenshots. .vercelignore excludes local secrets.

The sample and scaffold template pin exact registry arkiv-sync 1.0.0 and SDK 1.0.0. Do not vendor package archives. Verify the published archives and a clean registry consumer with scripts/verify-registry-dgx.sh.
