# SDK compatibility

arkiv-sync uses SDK `^1.0.0`, verified with 1.0.1. Development and sample SDK installs are pinned to 1.0.1. Run `bash scripts/verify-sdk101.sh` on Node 22. The checks exercise versions 1.0.0 and 1.0.1 and restore the 1.0.1 installation and lockfiles exactly.

On 1.0.1, over-maximum Entity Expiration throws `InvalidExpiryError` before submission. The original peer baseline instead sends and reverts on chain with `ExpiryBeyondMaxLifetime`. The deterministic transport checks distinguish these paths without making live over-limit writes. On 1.0.1+, use `ExpirationTime.max()` for the longest lifetime, counted from the inclusion block. Conservative application caps remain for compatibility with the peer baseline; they do not redefine the protocol maximum.

When gas is omitted, 1.0.1 adds 25% to the unsigned estimate, capped at 2^24 unless the estimate itself exceeds that cap. Explicit gas is unchanged. An out-of-gas receipt now produces an `EntityMutationError` message containing `ran out of gas`; the original diagnostic used `reverted`. Adapters recognize both diagnostics and still require an authoritative reverted receipt with gasUsed equal to the submitted gas before their single allowed retry. SDK success, uncertain sends and null or disagreeing confirmation reads never authorize resubmission.

Every application write retains explicit latest nonce, network gasPrice, gas at least max(1,000,000, twice the unsigned latest estimate), and the half-block ceiling. Tests of SDK defaults are deterministic controls, not an endorsement of omitting application gas. Live checks use only an authorized lane wallet, and their receipts are kept outside the package.

The hosted sample and scaffold pin published registry arkiv-sync 1.0.2 and SDK 1.0.1. The pack consumer separately validates the library archive; the registry consumer verifies the published runtime and create-arkiv-sync 1.0.3. Execution receipts and dry-run file lists are written to `artifacts` for the lane report, not shipped as release claims.
