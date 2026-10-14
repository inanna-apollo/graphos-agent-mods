// Response denials belong to call-local response paths, not schema coordinates
// or leaf names. Old records may lack that identity: ambiguity stays visible,
// but never lends a sibling its classification, count or requestability.

import type { CallOutcome, FieldIR } from './ir.ts'

export const responsePath = (path: string): string => path.split('.').filter(part => part !== '*' && !/^\d+$/.test(part)).join('.')

export type ObservedDenial = {
  path?: string
  root?: string
  name: string
  field?: FieldIR
  rows?: number
  count?: number
  of?: number
  list?: string
  classification?: string
  isRequestable?: boolean
  hasToken: boolean
  coord?: string
  service?: string
  reason?: string
}

type Evidence = Omit<ObservedDenial, 'field' | 'hasToken'> & { hasToken?: boolean; relative?: { list: string; trail: string } }
const walk = (fields: readonly FieldIR[]): FieldIR[] => fields.flatMap(field => [field, ...walk(field.children)])
const only = <T>(values: readonly T[]): T | undefined => values.length === 1 ? values[0] : undefined
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]
const fact = <K extends keyof Evidence>(evidence: readonly Evidence[], key: K): Evidence[K] | undefined => only(unique(evidence.flatMap(one => one[key] === undefined ? [] : [one[key]])))

function relativeFields(node: FieldIR, names: readonly string[]): FieldIR[] {
  if (names.length === 0) return [node]
  return node.children.filter(child => child.name === names[0]).flatMap(child => relativeFields(child, names.slice(1)))
}

/** Gather every retained denial; exact paths win and legacy matches require a unique occurrence. */
export function observedDenials(outcome: CallOutcome | undefined, roots: readonly FieldIR[] = []): ObservedDenial[] {
  if (outcome === undefined) return []
  if ((outcome.denials?.length ?? 0) === 0 && !outcome.errors.some(one => one.isDenied === true) && !(outcome.preview ?? []).some(list => list.items.some(item => (item.denied?.length ?? 0) > 0))) return []
  const fields = walk(roots)
  const groups = new Map<string, { path?: string; field?: FieldIR; evidence: Evidence[] }>()
  const add = (one: Evidence) => {
    let path = one.path === undefined ? undefined : responsePath(one.path)
    let field: FieldIR | undefined
    if (path !== undefined) field = only(fields.filter(candidate => candidate.path === path))
    else {
      let candidates: FieldIR[]
      if (one.relative !== undefined) {
        const lists = fields.filter(candidate => candidate.name === one.relative!.list || candidate.path === one.relative!.list)
          .filter(candidate => one.root === undefined || candidate.path.split('.')[0] === one.root)
        candidates = lists.flatMap(list => relativeFields(list, one.relative!.trail.split('.')))
      } else {
        candidates = fields.filter(candidate => candidate.name === one.name && (one.root === undefined || candidate.path.split('.')[0] === one.root))
        // A root/name tally may already combine multiple coordinates. Its first
        // token's coordinate cannot recover the identities that were discarded.
        if (one.root === undefined && one.coord !== undefined) candidates = candidates.filter(candidate => candidate.coordinate === one.coord)
        if (one.root === undefined && one.service !== undefined) candidates = candidates.filter(candidate => {
          const root = roots.find(root => root.path === candidate.path.split('.')[0])
          return root?.service === undefined || root.service === one.service
        })
      }
      field = only(unique(candidates))
      path = field?.path
    }
    const key = path === undefined ? JSON.stringify([one.root, one.name, one.relative, one.coord, one.service]) : path
    const group = groups.get(key) ?? { ...(path !== undefined && { path }), ...(field !== undefined && { field }), evidence: [] }
    group.evidence.push(one)
    groups.set(key, group)
  }
  for (const tally of outcome.denials ?? []) add({ ...tally, name: tally.field, ...(tally.rows !== undefined && { count: tally.rows }) })
  for (const error of outcome.errors) {
    if (error.isDenied !== true) continue
    add({ ...error, name: error.field ?? error.path?.split('.').pop() ?? 'field', ...(error.path !== undefined && { root: error.path.split('.')[0] }), count: error.count ?? 1 })
  }
  // Tags are the retained evidence when a denial was moved onto a shown row.
  // Count rows once per identity rather than once per repeated response error.
  for (const list of outcome.preview ?? []) {
    const tagged = new Map<string, { tag: NonNullable<(typeof list.items)[number]['denied']>[number]; count: number }>()
    for (const item of list.items) for (const tag of item.denied ?? []) {
      const key = tag.path ?? tag.field
      const prior = tagged.get(key)
      if (prior === undefined) tagged.set(key, { tag, count: 1 })
      else {
        prior.count += 1
        // Keep differing metadata as separate evidence, so the common facts
        // below cannot silently pick one row's classification for all rows.
        add({ ...tag, name: tag.field.split('.').pop() ?? tag.field, root: list.root, relative: { list: list.field, trail: tag.field } })
      }
    }
    for (const { tag, count } of tagged.values()) add({ ...tag, name: tag.field.split('.').pop() ?? tag.field, root: list.root, count, relative: { list: list.field, trail: tag.field } })
  }
  return [...groups.values()].map(({ path, field, evidence }) => {
    const privateDecision = evidence.some(one => one.isRequestable === false)
    const rows = evidence.flatMap(one => one.rows === undefined ? [] : [one.rows])
    const counts = evidence.flatMap(one => one.count === undefined ? [] : [one.count])
    return {
      ...(path !== undefined && { path }), ...(field !== undefined && { field }),
      root: path?.split('.')[0] ?? fact(evidence, 'root'),
      name: field?.name ?? fact(evidence, 'name') ?? 'field',
      ...(rows.length > 0 && { rows: Math.max(...rows) }),
      ...(counts.length > 0 && { count: Math.max(...counts) }),
      ...(fact(evidence, 'of') !== undefined && { of: fact(evidence, 'of') }),
      ...(fact(evidence, 'list') !== undefined && { list: fact(evidence, 'list') }),
      ...(fact(evidence, 'classification') !== undefined && { classification: fact(evidence, 'classification') }),
      ...(privateDecision ? { isRequestable: false } : evidence.some(one => one.isRequestable === true) ? { isRequestable: true } : {}),
      hasToken: evidence.some(one => one.hasToken === true),
      ...(fact(evidence, 'coord') !== undefined && { coord: fact(evidence, 'coord') }),
      ...(fact(evidence, 'service') !== undefined && { service: fact(evidence, 'service') }),
      ...(fact(evidence, 'reason') !== undefined && { reason: fact(evidence, 'reason') }),
    }
  })
}

export function denialFor(field: FieldIR, outcome: CallOutcome | undefined, roots?: readonly FieldIR[]): ObservedDenial | undefined {
  // Without the complete selection, only explicit paths are safe. Supplying
  // [field] would make an ambiguous old name look artificially unique.
  return observedDenials(outcome, roots).find(one => one.path === field.path && (roots === undefined || one.field !== undefined))
}

/** Resolve one error through the same legacy ambiguity rules as every other surface. */
export function denialFromError(error: CallOutcome['errors'][number], roots?: readonly FieldIR[]): ObservedDenial | undefined {
  return observedDenials({ rows: [], errors: [error], authLinks: [] }, roots)[0]
}
