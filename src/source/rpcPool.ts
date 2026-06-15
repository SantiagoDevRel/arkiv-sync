import { fallback, http, type Transport } from 'viem'

/**
 * Build a resilient read transport from a list of RPC URLs.
 *
 * viem's `fallback` transport tries them in order and transparently rotates to the next
 * on any failure (timeout, 429, 5xx). That IS the zero-friction "RPC rotation/fallback":
 * one endpoint throttling never surfaces as an error to the caller as long as one works.
 *
 * `rank: false` keeps the declared order (predictable); each endpoint gets a short timeout
 * and a couple of retries before the next is tried.
 */
export function buildReadTransport(urls: string[]): Transport {
  if (!urls.length) {
    throw new Error('No RPC URLs configured for the source chain.')
  }
  const transports = urls.map((url) => http(url, { timeout: 8_000, retryCount: 2, retryDelay: 250 }))
  return fallback(transports, { rank: false, retryCount: 1 })
}
