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
 * Validate + lowercase a 20-byte address from an event arg. THROWS on a bad value, which turns the
 * classic silent footgun (a mistyped arg name → `String(undefined)` → the literal "undefined" stored
 * as a queryable attribute) into a loud error. Use in `map()` for address attributes.
 */
export function addr(value: unknown): string {
  const s = String(value)
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new Error(`addr(): "${s}" is not a 20-byte 0x address — check the event arg name in your map().`)
  }
  return s.toLowerCase()
}

/**
 * Coerce a uint (bigint | number | decimal string) to a decimal STRING — a uint256 exceeds JS's safe
 * integer range, so amounts must be stored as strings. THROWS on a non-integer value.
 */
export function uint(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`uint(): ${value} is not an integer.`)
    return value.toString()
  }
  const s = String(value)
  if (!/^[0-9]+$/.test(s)) throw new Error(`uint(): "${s}" is not a non-negative integer — check the arg name/type.`)
  return s
}

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
  // credentials embedded in a URL (e.g. a token in ARKIV_RPC_URL): user:pass@ and ?key=/&token=/#token=…
  s = s.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
  s = s.replace(
    /([?&#](?:api[-_]?key|key|token|secret|client[-_]?secret|password|passwd|pwd|auth|authorization|access[-_]?token)=)[^&\s"']+/gi,
    '$1<redacted>',
  )
  return s
}

/** Truncate a long string for log readability. */
export const short = (s: string, n = 10): string =>
  s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-4)}`
