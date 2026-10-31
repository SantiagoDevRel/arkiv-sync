# create-arkiv-sync

Scaffolds a consumer project from template/. Node 22.10+ within the 22.x release line. Run node index.mjs <new-directory> --local <absolute-local-tarball> for an unpublished candidate. A nonempty target is refused. --install installs dependencies with scripts disabled; it does not start the worker or authorize writes. The template includes AGENTS.md and its CLAUDE.md pointer. Ask for the target directory and compatible published/local package version; do not claim an unpublished candidate is on npm. See README.md for runtime source/sink/signing requirements.

Published scaffolder: create-arkiv-sync@1.0.1; pending documentation patch: 1.0.2. The template keeps the published arkiv-sync@1.0.0 dependency until phase 2.
