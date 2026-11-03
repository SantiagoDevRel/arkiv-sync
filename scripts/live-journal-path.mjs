import fs from 'node:fs';
import path from 'node:path';

/** Never bypass an existing legacy journal when selecting the durable default. */
export function selectLiveJournal({ checkout = process.cwd(), args = process.argv.slice(2) } = {}) {
  if (!(args.length === 0 || args.length === 2 && args[0] === '--journal' && args[1])) throw new Error('Usage: node scripts/live-sdk101.mjs [--journal <path>]');
  const legacy = path.resolve(checkout, 'artifacts/sdk101-roundtrip-journal');
  const requested = args.length ? path.resolve(checkout, args[1]) : undefined;
  if (fs.existsSync(legacy)) {
    if (!requested || !fs.existsSync(requested) || fs.realpathSync(requested) !== fs.realpathSync(legacy)) {
      throw new Error('Existing journal retained at ' + legacy + '. Inspect/reconcile it with --journal ' + legacy + ' before choosing a new journal. Nothing was moved or deleted.');
    }
  }
  return requested ?? path.resolve(checkout, '.arkiv-sync/sdk101-roundtrip-journal');
}
