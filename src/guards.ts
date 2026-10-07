// Shared type guards and the name lists several modules read the same way. Pure.

import type { FieldIR } from './ir.ts'

/** A plain object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A table's own entry for `key`, never one it inherits: a key the model or a
 * response wrote (`constructor`, `toString`, `__proto__`) would otherwise
 * find Object.prototype's members. Every lookup of an untrusted key in a
 * plain-object table goes through this.
 */
export const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined)

/** Names of lists that sit beside a result's own rows and are not them: facets, warnings, suggestions. */
const AUXILIARY_LISTS = /^(facets?|warnings?|errors?|aggregations?|aggregates|buckets|suggestions?|hints?|labels|tags|categories|breadcrumbs|filters|highlights?|spellcheck\w*)$/i

/** A list a service returns beside the rows a limit governs, by its name. */
export const isAuxiliaryList = (name: string): boolean => AUXILIARY_LISTS.test(name)

/** Arguments that say how many rows to return. */
export const LIMIT_ARGS = ['limit', 'first', 'last', 'pagesize', 'maxresults', 'count', 'top', 'take', 'size', 'perpage']
/** Arguments that say where in a list to start; with the limit ones, what can cut a list. */
export const PLACE_ARGS = ['page', 'cursor', 'after', 'before', 'offset', 'pagetoken', 'nextpagetoken', 'startat']

/** The numeric limit a root field was given (`limit: 10`), if any. */
export function limitOf(field: FieldIR): number | undefined {
  for (const arg of field.args) {
    if (!LIMIT_ARGS.includes(arg.name.toLowerCase())) continue
    const value = arg.value
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value)
  }
  return undefined
}
