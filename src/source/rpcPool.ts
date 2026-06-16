import { fallback, http, type Transport } from 'viem'

/**
 * Build a resilient read transport from a list of RPC URLs.
 *
 * viem's `fallback` transport tries them in order and transparently rotates to the next
 * on any failure (timeout, 429, 5xx). That IS the zero-friction "RPC rotation/fallback":
 * one endpoint throttling never surfaces as an error to the caller as long as one works.
 *
 * `rank` enables viem's latency+stability scoring so a consistently slow / 429-ing (but not outright
 * failing) endpoint is automatically DEPRIORITIZED. Without it, fallback always hammers endpoint #1
 * first on every request and only rotates on an outright throw — pinning a flaky primary under load.
 */
export function buildReadTransport(urls: string[]): Transport {
  if (!urls.length) {
    throw new Error('No RPC URLs configured for the source chain.')
  }
  const transports = urls.map((url) => http(url, { timeout: 8_000, retryCount: 2, retryDelay: 250 }))
  // rank samples endpoints periodically and orders by latency/stability (auto-cooldown for a flaky one).
  return fallback(transports, { rank: { interval: 60_000, sampleCount: 5, timeout: 2_000 }, retryCount: 1 })
}
