# Hosted sample

The existing Vercel project is arkiv-indexer. This migration deploys a preview first; publishing and production promotion require a separate reviewer.

Keep read access keys server-side as ARKIV_ACCESS_KEY, and configure the public owner with ARKIV_DEMO_OWNER. Reads use this application's /api/query endpoint and SDK 1.0/Rabdi typed owner/schema-scoped predicates. Never infer the owner from a private key.

The preview is read-only. A separately authorized writer requires ENABLE_DEMO_WRITES, ARKIV_WRITE_ACCESS_KEY and its own testnet PRIVATE_KEY. Keep operation state across requests and stop on uncertainty. Instance-local guards do not coordinate serverless cold instances; prefer the continuous CLI worker.

Retain the existing static UI for this dependency-restricted migration. Keep all visible text English and verify three widths plus empty/error states. Credentials must never enter HTML, client requests, errors or screenshots. .vercelignore excludes local secrets.

Before npm publication the sample pins the verified candidate tarball in vendor/. After approval and publication replace it with exact registry arkiv-sync 1.0.0 and verify the registry archive. A preview does not establish registry availability.
