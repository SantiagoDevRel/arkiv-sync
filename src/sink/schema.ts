import { addr, bool, bytes, dec, defineSchema, i32, key, str, u64, u256,
  type AnyColumn, type Attributes, type TypeTag } from '@arkiv-network/sdk/schema'

export const SYNC_SCHEMA_NAME = 'arkiv_sync_v1'
const constructors = { addr, bool, bytes, dec, i32, key, str, u64, u256 }

/** Mapper columns retain their exact types; every scalar is filterable, bytes only stored.
 * Optional columns let replacement patches explicitly unset fields removed by the mapper. */
export function entitySchema(values: Attributes) {
  const columns: Record<string, AnyColumn> = Object.create(null)
  for (const [name, value] of Object.entries(values)) {
    if (name === 'arkiv.schema') continue
    const column = constructors[value.type as TypeTag]()
    columns[name] = column.type === 'bytes' || name === 'content_type' || name === 'content_hash'
      ? column.optional() : column.indexed().optional()
  }
  return defineSchema(SYNC_SCHEMA_NAME, columns)
}
