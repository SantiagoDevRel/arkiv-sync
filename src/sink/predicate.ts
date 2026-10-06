/** Conservative raw-predicate helpers. Prefer SDK expressions for dynamic values. */

import { addr, str } from '@arkiv-network/sdk/attr'
import { eq } from '@arkiv-network/sdk/query'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const COMMENT_TOKENS = /\/\*|\*\/|--|\/\/|#/

export function assertSafeOwner(owner: string): void {
  if (!ADDRESS_RE.test(owner)) {
    throw new Error(`Invalid owner "${owner}" — expected a 0x-prefixed 40-hex-character address.`)
  }
}

/** Quote a string value for a predicate, refusing anything that could escape the quotes. */
export function quoteValue(value: string): string {
  if (value.includes('"') || value.includes("'") || value.includes('\\') || COMMENT_TOKENS.test(value)) {
    throw new Error('Query value may not contain a double quote, backslash, or comment token.')
  }
  return eq('value', str(value)).toString().slice('value = '.length)
}

/**
 * Reject a predicate that could break out of an owner scope. With unbalanced parentheses (or an
 * odd number of quotes), an `AND` wrap could be escaped by a `)` that closes the
 * wrap early followed by `OR true`. Requiring balanced parentheses
 * and quotes keeps the user predicate a self-contained group, so `(owner) AND (predicate)`
 * keeps the owner constraint over the whole thing.
 */
function assertBalanced(predicate: string): void {
    // Count only parentheses outside either quote style. Counting string contents could
    // hide an unbalanced closing parenthesis followed by an OR expression.
  let depth = 0
  let quote: string | undefined
  for (const ch of predicate) {
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = undefined
      else if (!quote) quote = ch
      continue
    }
    if (quote) continue
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) throw new Error('Unbalanced parenthesis in query predicate.')
    }
  }
  if (quote) throw new Error('Unbalanced quote in query predicate.')
  if (depth !== 0) throw new Error('Unbalanced parenthesis in query predicate.')
}

/**
 * Wrap a predicate in an owner scope, with the owner clause FIRST so a malformed/trailing user
 * predicate fails closed. Combined with balanced-paren/quote validation, the owner constraint can't
 * be escaped by the balanced-parenthesis and quote-breakout fixtures.
 */
/**
 * Validate a standalone predicate is injection-safe (no comment tokens, balanced parens/quotes).
 * Use this whenever a predicate may contain caller-supplied values, even with no owner wrap.
 */
export function assertSafePredicate(predicate: string): void {
  const trimmed = predicate.trim()
  if (!trimmed) return
  if (COMMENT_TOKENS.test(trimmed) || trimmed.includes('\\')) {
    throw new Error('Query may not contain comment tokens (/* */ // -- #).')
  }
  assertBalanced(trimmed)
}

export function scopeToOwner(predicate: string, owner: string): string {
  assertSafeOwner(owner)
  const trimmed = predicate.trim()
  const ownerClause = eq('$owner', addr(owner)).toString()
  if (!trimmed) return ownerClause
  assertSafePredicate(trimmed)
  return `(${ownerClause}) AND (${trimmed})`
}
