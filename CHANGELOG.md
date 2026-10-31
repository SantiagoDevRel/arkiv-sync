# Changelog

## 1.0.0 (candidate)

- Target SDK 1.0.0 and Rabdi with a required access key, schema-typed columns and per-column indexing.
- Breaking: use `expirationSeconds` in configuration and mapper output. Sink input JSON is `data`; stored JSON is an unindexed bytes column. Old sink layouts and cursor fingerprints are incompatible: choose a new cursor directory and re-derive a bounded source range.
- Breaking: SDK imports use `/schema`; use `createRabdiNetwork(accessKey)`. Readers require owner scope and use head-only offset pages instead of pinned cursor pages. Complete scans fail on head drift or bounds.
- Preserve SHA256 replay, source identity, source confirmations, atomic cursor persistence and owner/schema/sync-scoped reorg cleanup.
- Estimate unsigned writes at latest, enforce doubled gas headroom and a half-block ceiling, split oversized batches and check receipts. Persistent operation states block uncertain or already successful resubmission; only a proven gas-exhausted revert can retry once.
- Bound Entity Expiration below Rabdi's maximum lifetime. Patches preserve expiration; explicit Lifetime Extension remains available.
- Update the scaffolder and hosted sample. Release and production promotion are separate gates.
