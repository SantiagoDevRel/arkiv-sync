import { toValue, u64, validateAttributeName, type ArkivValue, type ValueInput } from '@arkiv-network/sdk/attr'
import type { SinkRecord } from '../types.js'

/** Stable SDK0.8 storage names; mapper inputs may retain camelCase. */
export function storageAttributeName(name: string): string {
  const normalized = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) throw new Error(`Attribute "${name}" must map to a lowercase ASCII name.`)
  validateAttributeName(normalized)
  return normalized
}

export const RESERVED_STORAGE_ATTRIBUTES = new Set(['event_id', 'chain_id', 'content_hash', 'contract', 'event', 'block', 'sync'])

export function normalizeAttributes(input: SinkRecord['attributes']): Readonly<Record<string, ArkivValue>> {
  const output: Record<string, ArkivValue> = {}
  for (const cell of input) {
    const name = storageAttributeName(cell.key)
    if (Object.hasOwn(output, name)) throw new Error(`Attribute name collision after mapping to "${name}".`)
    if (name === 'content_hash') throw new Error('content_hash is reserved by Arkiv Sync.')
    let value: ValueInput = cell.value
    if ((name === 'block' || name === 'chain_id') && !isTagged(value)) {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Attribute "${name}" needs an exact integer.`)
      value = u64(value as string | number | bigint)
    }
    output[name] = toValue(value, name)
  }
  return output
}

function isTagged(value: ValueInput): boolean {
  return typeof value === 'object' && value !== null && 'type' in value
}
