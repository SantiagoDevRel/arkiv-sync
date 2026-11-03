# create-arkiv-sync

Scaffolds a consumer project from template/. Node 22.10+ within the 22.x release line. Run node index.mjs <new-directory> --local <absolute-local-tarball> for an isolated archive consumer. A nonempty target is refused. --install installs dependencies with scripts disabled; it does not start the worker or authorize writes. The template includes AGENTS.md and its CLAUDE.md pointer. Ask for the target directory and exact registry or local archive version. See README.md for runtime source/sink/signing requirements.

create-arkiv-sync 1.0.3 generates projects pinned to arkiv-sync 1.0.2 and SDK ^1.0.0, verified with 1.0.1. Use `npx create-arkiv-sync@1.0.3 my-indexer`.
