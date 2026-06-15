/**
 * Safe Arkiv predicate building. Arkiv wraps string values in quotes WITHOUT escaping, and the
 * store is PUBLIC/shared — so every read must be owner-scoped and no caller-supplied value may
 * smuggle a quote or comment token that breaks out of the predicate and broadens the result set.
 * (Same hardening the battle-tested Arkiv MCP applies.)
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const COMMENT_TOKENS = /\/\*|\*\/|--|\/\/|#/

export function assertSafeOwner(owner: string): void {
  if (!ADDRESS_RE.test(owner)) {
    throw new Error(`Invalid owner "${owner}" — expected a 0x-prefixed 40-hex-character address.`)
  }
}

/** Quote a string value for a predicate, refusing anything that could escape the quotes. */
export function quoteValue(value: string): string {
  if (value.includes('"') || COMMENT_TOKENS.test(value)) {
    throw new Error('Query value may not contain a double quote or comment token.')
  }
  return `"${value}"`
}

/**
 * Reject a predicate that could break out of an owner scope. With unbalanced parentheses (or an
 * odd number of quotes), a string-concatenated `&&` wrap could be escaped by a `)` that closes the
 * wrap early followed by a `|| true` (since `&&` binds tighter than `||`). Requiring BALANCED parens
 * + quotes guarantees the user predicate is a self-contained group, so `(owner) && (predicate)`
 * keeps the owner constraint over the whole thing.
 */
function assertBalanced(predicate: string): void {
  let depth = 0
  let quotes = 0
  for (const ch of predicate) {
    if (ch === '"') quotes++
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) throw new Error('Unbalanced parenthesis in query predicate.')
    }
  }
  if (depth !== 0) throw new Error('Unbalanced parenthesis in query predicate.')
  if (quotes % 2 !== 0) throw new Error('Unbalanced double-quote in query predicate.')
}

/**
 * Wrap a predicate in an owner scope, with the owner clause FIRST so a malformed/trailing user
 * predicate fails closed. Combined with balanced-paren/quote validation, the owner constraint can't
 * be escaped (no early `)` + `||`, no comment-token swallow, no quote break-out).
 */
export function scopeToOwner(predicate: string, owner: string): string {
  assertSafeOwner(owner)
  const trimmed = predicate.trim()
  if (!trimmed) return `$owner = ${owner}`
  if (COMMENT_TOKENS.test(trimmed)) {
    throw new Error('Query may not contain comment tokens (/* */ // -- #) when owner-scoped.')
  }
  assertBalanced(trimmed)
  return `($owner = ${owner}) && (${trimmed})`
}
