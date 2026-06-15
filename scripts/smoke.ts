/**
 * End-to-end smoke — the real thing, bounded for speed/cost, via the library's `quickCheck`:
 *
 *   Sepolia (real WETH Transfer logs)  →  Arkiv Sync engine  →  Arkiv (Braga) entities  →  query back
 *
 * Uses the repo's demo config (arkiv.config.ts). Requires PRIVATE_KEY in .env (a funded Braga
 * testnet burner). Run: `npm run smoke`.
 */
import dotenv from 'dotenv'
import { quickCheck } from '../src/index.js'
import { createLogger } from '../src/log.js'
import { scrubSecrets } from '../src/util.js'
import config from '../arkiv.config.js'

dotenv.config({ quiet: true })
const log = createLogger()

async function main() {
  const r = await quickCheck(config)
  if (!r.ok) throw new Error(`SMOKE FAIL: ${r.reason ?? 'no data round-tripped'} (written ${r.written}, queried ${r.queried})`)

  log.info(`indexed block ${r.window}: wrote ${r.written}, queried back ${r.queried}. Sample:`)
  for (const e of r.sample.slice(0, 5)) {
    const a = e.attributes
    log.info(`  • block ${a.block} | ${String(a.from).slice(0, 10)}→${String(a.to).slice(0, 10)} | value ${a.value} | key ${e.key.slice(0, 14)}…`)
  }
  if (r.spent) {
    log.info(`cost: ~${r.spent.spentGlm} GLM over ${r.spent.writes} write(s) (~${r.spent.perWriteGlm.toFixed(9)} GLM/event)`)
  }
  log.info('')
  log.info('✅ SMOKE OK — Sepolia → Arkiv → query verified end-to-end on live testnets.')
}

main().catch((e) => {
  log.error(`SMOKE FAIL: ${scrubSecrets(e?.message ?? e)}`)
  process.exit(1)
})
