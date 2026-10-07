// Normalized operation → CallIR, before any enrichment. Pure: no $.
//
// Coordinates start as `Query.field` for roots and bare names below; the
// enrichment step fills parent types, schema facts and policy in place.

import type { CallIR, FieldIR, OpType } from './ir.ts'
import type { NormalizedField, Normalized } from './normalize.ts'

const ROOT_TYPE: Record<OpType, string> = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }

function fieldIR(field: NormalizedField, parentPath: string, parentType: string | undefined): FieldIR {
  const key = field.alias ?? field.name
  const path = parentPath === '' ? key : `${parentPath}.${key}`
  const owner = field.onType ?? parentType
  return {
    name: field.name,
    ...(field.alias !== undefined && { alias: field.alias }),
    ...(field.onType !== undefined && { onType: field.onType }),
    coordinate: owner === undefined ? field.name : `${owner}.${field.name}`,
    path,
    args: field.args.map(arg => ({ name: arg.name, value: arg.value, fromVariable: arg.fromVariable })),
    policy: 'unknown',
    children: field.children.map(child => fieldIR(child, path, undefined)),
  }
}

/** The service prefix of a root field (`confluence_search` → `confluence`), until scopes resolve it. */
export function provisionalService(rootField: string): string | undefined {
  const cut = rootField.indexOf('_')
  return cut > 0 ? rootField.slice(0, cut) : undefined
}

export function buildIR(toolCallId: string, normalized: Normalized): CallIR {
  if (!normalized.ok) {
    return { toolCallId, state: 'unparseable', failure: `${normalized.reason}: ${normalized.message}`, roots: [] }
  }
  const roots = normalized.roots.map(root => fieldIR(root, '', ROOT_TYPE[normalized.opType]))
  const first = roots[0]
  const service = first === undefined ? undefined : provisionalService(first.name)
  const services = [...new Set(roots.flatMap(root => provisionalService(root.name) ?? []))]
  return {
    toolCallId,
    ...(service !== undefined && { service }),
    ...(services.length > 0 && { services }),
    opType: normalized.opType,
    ...(normalized.opName !== undefined && { opName: normalized.opName }),
    state: 'analyzing',
    roots,
    printed: normalized.printed,
  }
}

/** Deepest selection depth below the roots (a root with scalar children is 1). */
export function depthOf(fields: readonly FieldIR[]): number {
  let deepest = 0
  for (const field of fields) deepest = Math.max(deepest, field.children.length === 0 ? 0 : 1 + depthOf(field.children))
  return deepest
}
