import 'dotenv/config'
import { quickCheck } from 'arkiv-sync'
import config from './arkiv.config.js'

/**
 * "Does my setup work?" — a bounded, real end-to-end check: finds a recent block with events,
 * indexes it into Arkiv, and queries it back. Confirms your PRIVATE_KEY, funding, RPCs, contract,
 * and event signatures are all correct before you leave the worker running.
 */
const r = await quickCheck(config)

if (!r.ok) {
  console.error(`✗ verify failed: ${r.reason ?? `wrote ${r.written}, queried ${r.queried}`}`)
  process.exit(1)
}

console.log(`✓ verify OK — indexed block ${r.window}: wrote ${r.written}, queried back ${r.queried}.`)
for (const e of r.sample.slice(0, 3)) {
  console.log(`  • block ${e.attributes.block} | key ${e.key.slice(0, 16)}…`)
}
if (r.spent) console.log(`  cost ~${r.spent.perWriteGlm.toFixed(9)} GLM/event`)
process.exit(0)
