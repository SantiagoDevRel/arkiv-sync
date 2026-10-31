# Verification

The release candidate targets Rabdi and SDK 1.0.0. Run `npm run typecheck`, `npm test`, `npm run lint` and `npm run build` from the committed revision. Unit tests use deterministic source and actual SDK transport/ABI fixtures; they do not establish live network behavior.

`scripts/seed-rabdi.mjs` replays a fixed real source block and compares its second pass for zero writes. `scripts/live-rabdi.mjs` additionally checks receipts, typed query values and maximum permitted Entity Expiration with the lane's funded wallet. The packed runtime and scaffolder are installed into a clean temporary consumer; that consumer's `npm run verify` exercises Rabdi.

The hosted preview is checked through its own server-side read endpoint and a hydrated browser. No release or production status follows from a preview. Historical evidence JSON files in this directory describe older versions only and must not be used to certify this candidate.
