// Splits one operation into per-service sub-operations. Pure: no $.
//
// An Agent Services scope checks one service, so an operation whose roots span services is
// checked as one sub-operation per scope: the same operation (name, directives)
// reduced to that scope's root fields, with only the variable definitions those
// roots use and only the fragments they reach, transitively. The selections are
// the original nodes, so aliases and @skip/@include are kept as written.

import { parse, print, visit, Kind } from './vendor/graphql.js'
import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
} from './vendor/graphql.js'

export type SubOperation = {
  /** The reduced operation, printed. */
  operation: string
  /** The given variables that the reduced operation still uses. */
  variables: Record<string, unknown>
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/**
 * Keeps the top-level fields `keep` accepts (by real field name). A top-level
 * fragment spread or inline fragment is reduced the same way: a spread becomes
 * an inline fragment of its body, so a fragment never straddles two scopes.
 */
function reduce(set: SelectionSetNode, keep: (field: string) => boolean, fragments: Map<string, FragmentDefinitionNode>, seen: readonly string[]): SelectionNode[] {
  const out: SelectionNode[] = []
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      if (keep(sel.name.value)) out.push(sel)
      continue
    }
    if (sel.kind === Kind.INLINE_FRAGMENT) {
      const inner = reduce(sel.selectionSet, keep, fragments, seen)
      if (inner.length > 0) out.push({ ...sel, selectionSet: { kind: Kind.SELECTION_SET, selections: inner } })
      continue
    }
    const name = sel.name.value
    const def = fragments.get(name)
    if (def === undefined || seen.includes(name)) continue
    const inner = reduce(def.selectionSet, keep, fragments, [...seen, name])
    if (inner.length > 0) {
      out.push({ kind: Kind.INLINE_FRAGMENT, typeCondition: def.typeCondition, directives: sel.directives, selectionSet: { kind: Kind.SELECTION_SET, selections: inner } })
    }
  }
  return out
}

/** Variable and fragment-spread names used anywhere under `node`. */
function usesOf(node: SelectionSetNode): { variables: Set<string>; spreads: Set<string> } {
  const variables = new Set<string>()
  const spreads = new Set<string>()
  visit(node, {
    Variable: (v: { name: { value: string } }) => void variables.add(v.name.value),
    FragmentSpread: (s: { name: { value: string } }) => void spreads.add(s.name.value),
  })
  return { variables, spreads }
}

/**
 * The sub-operation holding only the root fields `keep` accepts, or undefined
 * when the operation does not parse, has no single operation, or nothing is kept.
 */
export function subOperation(operation: string, variables: Record<string, unknown>, keep: (field: string) => boolean): SubOperation | undefined {
  let doc: DocumentNode
  try {
    doc = parse(operation, { noLocation: true })
  } catch {
    return undefined
  }
  const ops = doc.definitions.filter((def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION)
  const op = ops[0]
  if (op === undefined || ops.length > 1) return undefined
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const def of doc.definitions) if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def)

  const selections = reduce(op.selectionSet, keep, fragments, [])
  if (selections.length === 0) return undefined
  const selectionSet: SelectionSetNode = { kind: Kind.SELECTION_SET, selections }

  // The fragments the kept selections reach, transitively, in their original order.
  const usedVariables = new Set<string>()
  const reached = new Set<string>()
  const pending: SelectionSetNode[] = [selectionSet]
  // Directives on the operation itself may use variables too.
  for (const directive of op.directives ?? []) {
    visit(directive, { Variable: (v: { name: { value: string } }) => void usedVariables.add(v.name.value) })
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { variables: vars, spreads } = usesOf(next)
    for (const name of vars) usedVariables.add(name)
    for (const name of spreads) {
      const def = fragments.get(name)
      if (def === undefined || reached.has(name)) continue
      reached.add(name)
      pending.push(def.selectionSet)
    }
  }

  const reduced: OperationDefinitionNode = {
    ...op,
    variableDefinitions: (op.variableDefinitions ?? []).filter(def => usedVariables.has(def.variable.name.value)),
    selectionSet,
  }
  const definitions = [reduced, ...[...fragments.values()].filter(def => reached.has(def.name.value))]
  const kept: Record<string, unknown> = {}
  for (const name of usedVariables) if (hasOwn(variables, name)) kept[name] = variables[name]
  return { operation: print({ kind: Kind.DOCUMENT, definitions }), variables: kept }
}

/** Distinct values in first-seen order. */
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
