import type { Hex } from './types.js'

/** Globally-unique idempotency key for a log: chainId + txHash + logIndex. */
export function eventId(chainId: number, transactionHash: string, logIndex: number): string {
  return `${chainId}:${transactionHash.toLowerCase()}:${logIndex}`
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** JSON replacer that turns bigint into string so JSON.stringify never throws. */
export const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

/** Deterministic JSON (sorted keys) — used to detect whether a record actually changed. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet()
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) return undefined
      seen.add(v as object)
      if (Array.isArray(v)) return v.map(norm)
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(norm(value))
}

/** Lowercase a hex address/hash for consistent comparison + dedup keys. */
export const lower = (s: string): Hex => s.toLowerCase() as Hex

/**
 * Remove anything key-shaped from a string/error before it is logged or shown.
 * A 32-byte hex (private key) or a long hex blob must never reach a log line.
 */
export function scrubSecrets(input: unknown): string {
  let s = input instanceof Error ? `${input.message}` : String(input)
  // 0x + 64 hex (private keys, 32-byte ids embedded in viem errors)
  s = s.replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted>')
  // a bare 64-hex private key without 0x
  s = s.replace(/\b[0-9a-fA-F]{64}\b/g, '<redacted>')
  return s
}

/** Truncate a long string for log readability. */
export const short = (s: string, n = 10): string =>
  s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-4)}`
