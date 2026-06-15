import type { Logger, LogLevel } from './types.js'
import { scrubSecrets } from './util.js'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const ICON: Record<LogLevel, string> = { debug: '·', info: '→', warn: '!', error: '✗' }

/**
 * Zero-friction logger. Every line is human-first and runs through scrubSecrets, so a
 * private key can never leak into a log — even if it ends up inside a viem error object.
 * Level is set by ARKIV_SYNC_LOG (debug|info|warn|error), default info.
 */
export function createLogger(level: LogLevel = (process.env.ARKIV_SYNC_LOG as LogLevel) || 'info'): Logger {
  const min = ORDER[level] ?? ORDER.info
  const emit = (lvl: LogLevel, msg: string, meta?: unknown) => {
    if (ORDER[lvl] < min) return
    const time = new Date().toISOString().slice(11, 19)
    let line = `${time} ${ICON[lvl]} ${scrubSecrets(msg)}`
    if (meta !== undefined) {
      try {
        line += `  ${scrubSecrets(typeof meta === 'string' ? meta : JSON.stringify(meta))}`
      } catch {
        /* ignore unserializable meta */
      }
    }
    // Everything goes to stderr so stdout stays clean for any piped/structured use.
    process.stderr.write(line + '\n')
  }
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  }
}

/** A logger that drops everything — for tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
