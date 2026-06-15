/**
 * Time helpers — Arkiv expiry (`expiresIn`) is in SECONDS, not milliseconds. Passing
 * milliseconds is a classic footgun (an entity meant to live 30 days would live ~30,000
 * years). These helpers make the unit explicit and always return a positive integer.
 *
 *   ttl: days(30)      // 30 days, in seconds
 *   ttl: hours(12)     // 12 hours, in seconds
 */

function asSeconds(value: number, perUnit: number, unit: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`time.${unit}(${value}) must be a positive number.`)
  }
  return Math.floor(value * perUnit)
}

export const seconds = (n: number) => asSeconds(n, 1, 'seconds')
export const minutes = (n: number) => asSeconds(n, 60, 'minutes')
export const hours = (n: number) => asSeconds(n, 3600, 'hours')
export const days = (n: number) => asSeconds(n, 86400, 'days')
export const weeks = (n: number) => asSeconds(n, 604800, 'weeks')

/** Human-readable description of a seconds TTL, for logs/confirmations. */
export function describeSeconds(s: number): string {
  if (s >= 86400) return `${Math.round((s / 86400) * 10) / 10} day(s)`
  if (s >= 3600) return `${Math.round((s / 3600) * 10) / 10} hour(s)`
  if (s >= 60) return `${Math.round((s / 60) * 10) / 10} minute(s)`
  return `${s}s`
}
