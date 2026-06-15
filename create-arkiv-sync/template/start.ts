import 'dotenv/config'
import { createIndexer } from 'arkiv-sync'
import config from './arkiv.config.js'

/** Start indexing 24/7. Ctrl-C stops gracefully (finishes the current block, then exits). */
const indexer = createIndexer(config)
process.on('SIGINT', () => indexer.stop())
process.on('SIGTERM', () => indexer.stop())
await indexer.start()
