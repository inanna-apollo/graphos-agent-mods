// Folds what enrichment learned into the IR. Pure: no $.
//
// Each source is optional: whatever is missing leaves its facts unknown and
// the call `partial`, never assumed. Policy is looked up by dry_run path
// (response keys, so aliases), schema by the real name under its parent type.

import type { Access } from './gas.ts'
import type { ArgIR, CallIR, CallState, Checks, FieldIR, OmittedArg, OpType, Paging, Validation } from './ir.ts'
import { enumsOf, hintsFrom, scopesFrom } from './schema.ts'
import type { FieldDef, SchemaIndex } from './schema.ts'

const ROOT_TYPE: Record<OpType, string> = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }

export type Enrichment = {
  schema?: SchemaIndex
  access?: Access
  validation?: Validation
  /** The service scope the call was checked against. */
  scope?: string
  /** Every service the call touches, in the order its roots appear. */
  services?: string[]
  /** The scope each root was checked against, by root path. */
  rootScopes?: ReadonlyMap<string, string>
  bundleDigest?: string
  /** True when a source failed or was skipped. */
  isIncomplete: boolean
  checks?: Checks
}

const ARG_KINDS: [Paging['kind'], string[]][] = [
  ['token', ['pageToken', 'nextPageToken']],
  ['cursor', ['cursor', 'after', 'before']],
  ['offset', ['startAt', 'offset', 'start']],
  ['page', ['page']],
]
// Fields that hold the continuation, then flags that say whether more remains.
const TOKEN_FIELDS = ['nextPageToken', 'nextCursor', 'next', 'cursor', 'pageToken', 'after', 'endCursor']
const FLAG_FIELDS = ['hasMoreResults', 'hasNextPage', 'isLast', 'pageInfo']

const PAGINATION_FIELDS = ['pagination', 'pageInfo']

/** A paging argument's value that still asks for the first page: no token or cursor, an offset of 0, page 0 or 1. */
function isFirstValue(kind: Paging['kind'], value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined
  if (number === undefined) return false
  return kind === 'offset' ? number === 0 : kind === 'page' && number <= 1
}

/** `page`-style paging: a `pagination` / `pageInfo` object with `page` and `pageCount`, on the response or one object down. */
function pageCountOf(response: Map<string, FieldDef> | undefined, schema: SchemaIndex): string | undefined {
  const inspect = (fields: Map<string, FieldDef> | undefined): string | undefined => {
    for (const name of PAGINATION_FIELDS) {
      const info = schema.get(fields?.get(name)?.namedType ?? '')
      if (info?.has('page') && info.has('pageCount') && info.has('totalCount')) return 'pageCount'
    }
    return undefined
  }
  const own = inspect(response)
  if (own !== undefined) return own
  for (const one of response?.values() ?? []) if (!one.isList) { const found = inspect(schema.get(one.namedType)); if (found !== undefined) return found }
  return undefined
}

function pagingOf(field: FieldIR, def: FieldDef, schema: SchemaIndex): Paging | undefined {
  const response = schema.get(def.namedType)
  const isListing =
    def.isList ||
    [...(response?.values() ?? [])].some(one => one.isList || [...(schema.get(one.namedType)?.values() ?? [])].some(inner => inner.isList))
  if (!isListing) return undefined
  const declared = Object.keys(def.argDefs)
  const isPagingArg = (name: string) => ARG_KINDS.some(([, names]) => names.includes(name))
  const kindOf = (name: string) => ARG_KINDS.find(([, names]) => names.includes(name))?.[0] ?? 'token'
  for (const [kind, names] of ARG_KINDS) {
    const via = declared.filter(name => names.includes(name))
    if (via.length === 0) continue
    // An argument set to the value that means the beginning (`startAt: 0`, `nextPageToken: null`, `page: 1`) is still the first page.
    const moved = field.args.filter(arg => declared.includes(arg.name) && isPagingArg(arg.name) && !isFirstValue(kindOf(arg.name), arg.value))
    const moreField = TOKEN_FIELDS.find(name => response?.has(name)) ?? FLAG_FIELDS.find(name => response?.has(name))
    const flagField = FLAG_FIELDS.find(name => response?.has(name))
    const pageCountField = kind === 'page' ? pageCountOf(response, schema) : undefined
    return {
      kind,
      via,
      isFirstPage: moved.length === 0,
      ...(pageCountField !== undefined && { pageCountField }),
      ...(moreField !== undefined && { moreField }),
      ...(flagField !== undefined && flagField !== moreField && { flagField }),
    }
  }
  return undefined
}

function annotateArg(arg: ArgIR, def: FieldDef | undefined, schema: SchemaIndex | undefined): ArgIR {
  const known = def?.argDefs[arg.name]
  if (known === undefined) return arg
  const enumValues = schema === undefined ? undefined : enumsOf(schema).get(known.namedType)
  // A default belongs to an argument the call left out; this one was set.
  const hints = hintsFrom(known.description).filter(hint => !/^default\b/i.test(hint))
  return {
    ...arg,
    type: known.type,
    ...(known.defaultValue !== undefined && { defaultValue: known.defaultValue }),
    ...(known.description !== undefined && { description: known.description }),
    ...(enumValues !== undefined && { enumValues }),
    ...(hints.length > 0 && { hints }),
  }
}

function omittedOf(field: FieldIR, def: FieldDef): OmittedArg[] {
  const set = new Set(field.args.map(arg => arg.name))
  return Object.values(def.argDefs)
    .filter(arg => !set.has(arg.name))
    .map(arg => ({
      name: arg.name,
      type: arg.type,
      ...(arg.defaultValue !== undefined && { default: arg.defaultValue }),
      ...(arg.description !== undefined && { description: arg.description }),
      isRequired: arg.type.endsWith('!') && arg.defaultValue === undefined,
    }))
}

function annotateField(field: FieldIR, parentType: string | undefined, found: Enrichment, isRoot = false): FieldIR {
  const owner = field.onType ?? parentType
  // A type condition equal to the parent type names nothing new: not a branch.
  const { onType: _same, ...bare } = field
  const base: FieldIR = field.onType !== undefined && field.onType === parentType ? bare : field
  const def = owner === undefined ? undefined : found.schema?.get(owner)?.get(field.name)
  const decision = found.access?.fields.get(field.path)
  const scopes = scopesFrom(def?.description)
  const hints = hintsFrom(def?.description)
  const paging = isRoot && def !== undefined && found.schema !== undefined ? pagingOf(field, def, found.schema) : undefined
  const service = isRoot ? found.rootScopes?.get(field.path) : undefined
  return {
    ...base,
    ...(service !== undefined && { service }),
    coordinate: owner === undefined ? field.name : `${owner}.${field.name}`,
    args: field.args.map(arg => annotateArg(arg, def, found.schema)),
    ...(def !== undefined && Object.keys(def.argDefs).length > 0 && { omittedArgs: omittedOf(field, def) }),
    ...(paging !== undefined && { paging }),
    ...(def !== undefined && {
      schema: {
        type: def.type,
        isList: def.isList,
        isNonNull: def.isNonNull,
        isListItemNonNull: def.isListItemNonNull,
        isListNonNull: def.isListNonNull,
        ...(hints.length > 0 && { hints }),
        ...(def.description !== undefined && { description: def.description }),
        ...(def.deprecated !== undefined && { deprecated: def.deprecated }),
        scopes,
        tags: def.tags,
        ...(def.requiresInclude !== undefined && { requiresInclude: def.requiresInclude }),
        ...(def.isOpaque === true && { isOpaque: true }),
      },
    }),
    policy: decision?.decision ?? 'unknown',
    ...(decision?.denialContext !== undefined && { denialContext: decision.denialContext }),
    children: field.children.map(child => annotateField(child, def?.namedType, found)),
  }
}

export function annotate(ir: CallIR, found: Enrichment): CallIR {
  if (ir.state === 'unparseable' || ir.opType === undefined) return ir
  const rootType = ROOT_TYPE[ir.opType]
  const state: CallState =
    found.validation?.valid === false ? 'invalid' : found.isIncomplete ? 'partial' : 'ready'
  return {
    ...ir,
    ...(found.scope !== undefined && { service: found.scope }),
    ...(found.services !== undefined && { services: found.services }),
    ...(found.bundleDigest !== undefined && { bundleDigest: found.bundleDigest }),
    ...(found.validation !== undefined && { validation: found.validation }),
    ...(found.checks !== undefined && { checks: found.checks }),
    ...(found.access !== undefined && { isOperationDenied: found.access.denyOperation }),
    state,
    roots: ir.roots.map(root => annotateField(root, rootType, found, true)),
  }
}

/**
 * The fields policy counts: data-bearing leaves (no children), and a denied or
 * masked object as one field, its selection left uncounted since none of it
 * comes back to be read. Selection order.
 */
export const isPolicyUnit = (field: FieldIR): boolean => field.children.length === 0 || field.policy === 'deny' || field.policy === 'mask'

export function policyUnits(fields: readonly FieldIR[]): FieldIR[] {
  return fields.flatMap(field => (isPolicyUnit(field) ? [field] : policyUnits(field.children)))
}

/** Policy counts over `policyUnits`: what a reader can see, and a restricted object once. */
export function leafPolicyCounts(fields: readonly FieldIR[]): { allow: number; mask: number; deny: number; unknown: number } {
  const counts = { allow: 0, mask: 0, deny: 0, unknown: 0 }
  for (const field of policyUnits(fields)) counts[field.policy] += 1
  return counts
}
