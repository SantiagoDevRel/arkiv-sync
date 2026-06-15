#!/usr/bin/env node
/**
 * Arkiv Sync CLI — `npm start`.
 *
 * Loads `.env` (PRIVATE_KEY), imports your `arkiv.config.ts` (or .js/.mjs) from the current
 * directory, builds the indexer, and runs it 24/7 with graceful shutdown. No flags needed.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promises as fs } from 'node:fs'
import dotenv from 'dotenv'
import { createIndexer, type ArkivSyncConfig } from '../config.js'
import { createLogger } from '../log.js'
import { scrubSecrets } from '../util.js'

const log = createLogger()

const CONFIG_CANDIDATES = [
  'arkiv.config.ts',
  'arkiv.config.mjs',
  'arkiv.config.js',
  'arkiv-sync.config.ts',
]

async function findConfig(): Promise<string> {
  // Allow an explicit path: `arkiv-sync ./path/to/config.ts`
  const arg = process.argv[2]
  if (arg) {
    const abs = path.resolve(process.cwd(), arg)
    await fs.access(abs)
    return abs
  }
  for (const name of CONFIG_CANDIDATES) {
    const abs = path.resolve(process.cwd(), name)
    try {
      await fs.access(abs)
      return abs
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    `No config found. Create an arkiv.config.ts (see arkiv.config.example.ts) or pass a path: ` +
      `arkiv-sync ./my.config.ts`,
  )
}

async function main() {
  dotenv.config({ quiet: true })

  const configPath = await findConfig()
  log.info(`config: ${path.relative(process.cwd(), configPath)}`)

  const mod = await import(pathToFileURL(configPath).href)
  const config: ArkivSyncConfig = mod.default ?? mod.config
  if (!config || typeof config !== 'object') {
    throw new Error(`${configPath} must \`export default defineConfig({ ... })\`.`)
  }

  const indexer = createIndexer(config)

  const shutdown = (sig: string) => {
    log.info(`${sig} received — finishing the current block, then stopping…`)
    indexer.stop()
    // Hard exit if it doesn't wind down promptly.
    setTimeout(() => process.exit(0), 8000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await indexer.start()
  process.exit(0)
}

main().catch((err) => {
  log.error(scrubSecrets(err))
  process.exit(1)
})
