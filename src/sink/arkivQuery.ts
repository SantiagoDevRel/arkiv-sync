import { createPublicClient, http, type Attribute, type PublicArkivClient } from '@arkiv-network/sdk'
import { braga } from '@arkiv-network/sdk/chains'
import type { Hex } from '../types.js'
import { assertSafePredicate, scopeToOwner } from './predicate.js'

/**
 * Read-side helper for the DERIVED Arkiv database. This is what an app's frontend/backend
 * uses to consume the indexed events — no private key needed (reads are public).
 *
 * IMPORTANT: Arkiv has NO functional `.orderBy()` — order is done client-side here, over the
 * fetched page (use `.limit` + cursor for more). Don't assume server-side global ordering.
 */
export interface DecodedEntity {
  key: Hex
  owner?: string
  attributes: Record<string, string | number>
  data: unknown
  expiresAtBlock?: string
}

export interface ArkivReaderOptions {
  rpcUrl?: string
}

export interface QueryParams {
  /** Max results in this page (Arkiv pagination is limit + cursor). Default 25. */
  limit?: number
  /** Scope to a single writer (STRONGLY recommended — the Arkiv store is shared/public; omitting
   * this queries the ENTIRE shared store across all writers). */
  owner?: Hex
  cursor?: string
  /** Client-side sort over the returned page (Arkiv has no server-side orderBy). */
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

/** Compare two attribute values, numerically when both look numeric, else lexicographically. */
function compareAttr(av: string | number | undefined, bv: string | number | undefined): number {
  const an = typeof av === 'number' ? av : Number(av)
  const bn = typeof bv === 'number' ? bv : Number(bv)
  if (Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== '' && String(bv).trim() !== '') {
    return an - bn
  }
  return String(av ?? '').localeCompare(String(bv ?? ''))
}

function decodeEntity(entity: {
  key: string
  owner?: string
  attributes?: Attribute[]
  payload?: Uint8Array
  expiresAtBlock?: bigint
}): DecodedEntity {
  const attributes: Record<string, string | number> = {}
  for (const a of entity.attributes ?? []) attributes[a.key] = a.value
  let data: unknown = undefined
  if (entity.payload && entity.payload.length) {
    const text = new TextDecoder().decode(entity.payload)
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return {
    key: entity.key as Hex,
    owner: entity.owner,
    attributes,
    data,
    expiresAtBlock: entity.expiresAtBlock?.toString(),
  }
}

export interface ArkivReader {
  query(predicate: string, params?: QueryParams): Promise<DecodedEntity[]>
  /** The underlying Arkiv public client, for advanced reads. */
  raw: PublicArkivClient
}

export function createArkivReader(opts: ArkivReaderOptions = {}): ArkivReader {
  const pub: PublicArkivClient = createPublicClient({ chain: braga, transport: http(opts.rpcUrl) })

  async function query(predicate: string, params: QueryParams = {}): Promise<DecodedEntity[]> {
    const { limit = 25, owner, cursor, sortBy, sortDir = 'desc' } = params
    // The Arkiv store is shared/public, so reads SHOULD be owner-scoped. Owner-scoping is injection-safe
    // (owner clause first, balanced/comment-validated). If `owner` is omitted you query the ENTIRE shared
    // store, so we still injection-validate the raw predicate before sending it.
    let pred: string
    if (owner) pred = scopeToOwner(predicate, owner)
    else {
      assertSafePredicate(predicate)
      pred = predicate
    }
    const res = await pub.query(pred, {
      includeData: { attributes: true, payload: true, metadata: true },
      resultsPerPage: limit,
      cursor,
    })
    let out = res.entities.map((e) => decodeEntity(e as never))
    if (sortBy) {
      // NOTE: client-side sort over THIS page only — Arkiv has no server-side orderBy. Numeric-looking
      // string attributes are compared numerically so "9" doesn't sort after "10".
      out = out.sort((a, b) => {
        const cmp = compareAttr(a.attributes[sortBy], b.attributes[sortBy])
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return out
  }

  return { query, raw: pub }
}
