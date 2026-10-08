// Normalizes an Agent Services `execute` operation into what will actually run: one
// operation, fragments inlined, @skip/@include applied, aliases resolved to
// real field names, variables substituted. Pure; never throws.
//
// Treat the operation as untrusted input. Keep fields with unknown conditions
// and reject duplicate fragment names or input keys that would make the
// normalized result ambiguous.

import { parse, print, Kind } from './vendor/graphql.js'
import type {
  ArgumentNode,
  DirectiveNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
  ValueNode,
} from './vendor/graphql.js'

export type ArgValue = { name: string; value: unknown; fromVariable: boolean; variable?: string }
export type NormalizedField = {
  /** The REAL field name, never the alias. */
  name: string
  /** Kept only for the raw view. */
  alias?: string
  /** Type condition it was selected under (inline fragment or fragment's typeCondition), if any. */
  onType?: string
  args: ArgValue[]
  /** Directive names other than skip/include; unknown ones kept. */
  directives: string[]
  children: NormalizedField[]
}
export type NormalizeFailure =
  | 'unparseable'
  | 'no-operation'
  | 'multiple-operations'
  | 'fragment-cycle'
  | 'unknown-fragment'
  | 'too-large'
export type Normalized =
  | {
      ok: true
      opType: 'query' | 'mutation' | 'subscription'
      opName?: string
      roots: NormalizedField[]
      variables: Record<string, unknown>
      printed: string
    }
  | { ok: false; reason: NormalizeFailure; message: string }

/** Most fields the expanded operation may contain. */
export const MAX_FIELDS = 5000
/** Deepest field nesting allowed (a root field is depth 1). */
export const MAX_DEPTH = 64
/**
 * Most selections (fields, spreads, inline fragments, skipped or not) the
 * expansion may visit. Bounds work for fan-out bombs whose leaves are all
 * skipped, which would never trip MAX_FIELDS.
 */
export const MAX_VISITS = 20000
/** Deepest fragment / inline-fragment / field nesting combined. */
export const MAX_NESTING = 128
/** Parser token cap; a larger document is reported as too-large. */
export const MAX_TOKENS = 100000

class Fail {
  reason: NormalizeFailure
  message: string
  constructor(reason: NormalizeFailure, message: string) {
    this.reason = reason
    this.message = message
  }
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Assigns without invoking setters such as `__proto__`. */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

type Converted = { value: unknown; fromVariable: boolean }

function convertValue(node: ValueNode, vars: Record<string, unknown>): Converted {
  switch (node.kind) {
    case Kind.VARIABLE: {
      const name = node.name.value
      return { value: hasOwn(vars, name) ? vars[name] : undefined, fromVariable: true }
    }
    case Kind.INT: {
      const n = Number(node.value)
      // Out-of-range ints keep their exact source text rather than a rounded
      // number that would show a different value from the one sent.
      return { value: Number.isSafeInteger(n) ? n : node.value, fromVariable: false }
    }
    case Kind.FLOAT: {
      const n = Number(node.value)
      return { value: Number.isFinite(n) ? n : node.value, fromVariable: false }
    }
    case Kind.STRING:
    case Kind.ENUM:
      return { value: node.value, fromVariable: false }
    case Kind.BOOLEAN:
      return { value: node.value, fromVariable: false }
    case Kind.NULL:
      return { value: null, fromVariable: false }
    case Kind.LIST: {
      let fromVariable = false
      const value = node.values.map((v) => {
        const c = convertValue(v, vars)
        if (c.fromVariable) fromVariable = true
        return c.value
      })
      return { value, fromVariable }
    }
    case Kind.OBJECT: {
      let fromVariable = false
      const value: Record<string, unknown> = {}
      for (const f of node.fields) {
        const key = f.name.value
        if (hasOwn(value, key)) {
          // A JS object can show only one of the two; refuse instead of guessing.
          throw new Fail('unparseable', `Input object has duplicate field "${key}"`)
        }
        const c = convertValue(f.value, vars)
        if (c.fromVariable) fromVariable = true
        put(value, key, c.value)
      }
      return { value, fromVariable }
    }
    default:
      throw new Fail('unparseable', `Unsupported value kind ${(node as { kind: string }).kind}`)
  }
}

function convertArgs(args: readonly ArgumentNode[] | undefined, vars: Record<string, unknown>): ArgValue[] {
  const out: ArgValue[] = []
  for (const a of args ?? []) {
    const c = convertValue(a.value, vars)
    const arg: ArgValue = { name: a.name.value, value: c.value, fromVariable: c.fromVariable }
    if (a.value.kind === Kind.VARIABLE) arg.variable = a.value.name.value
    out.push(arg)
  }
  return out
}

type Condition = 'drop' | 'keep' | 'unknown'

/** Evaluates one @skip/@include `if:`. 'unknown' when it cannot be decided. */
function conditionOf(d: DirectiveNode, vars: Record<string, unknown>): Condition {
  const ifArg = (d.arguments ?? []).filter((a) => a.name.value === 'if')
  const only = ifArg.length === 1 ? ifArg[0] : undefined
  if (!only) return 'unknown'
  const v = only.value
  let b: unknown
  if (v.kind === Kind.BOOLEAN) b = v.value
  else if (v.kind === Kind.VARIABLE) b = hasOwn(vars, v.name.value) ? vars[v.name.value] : undefined
  else return 'unknown'
  if (typeof b !== 'boolean') return 'unknown'
  const isSkip = d.name.value === 'skip'
  return (isSkip ? b : !b) ? 'drop' : 'keep'
}

/**
 * Applies @skip/@include. Returns null when the selection is dropped, else the
 * directives to print: decided skip/include removed, undecided ones kept so
 * the printed view shows the field is conditional.
 */
function applyConditions(
  directives: readonly DirectiveNode[] | undefined,
  vars: Record<string, unknown>,
): DirectiveNode[] | null {
  const kept: DirectiveNode[] = []
  let drop = false
  for (const d of directives ?? []) {
    const n = d.name.value
    if (n === 'skip' || n === 'include') {
      const c = conditionOf(d, vars)
      if (c === 'drop') drop = true
      else if (c === 'unknown') kept.push(d)
    } else {
      kept.push(d)
    }
  }
  return drop ? null : kept
}

function otherDirectiveNames(directives: readonly DirectiveNode[]): string[] {
  return directives.map((d) => d.name.value).filter((n) => n !== 'skip' && n !== 'include')
}

type Ctx = {
  fragments: Map<string, FragmentDefinitionNode>
  vars: Record<string, unknown>
  fields: number
  visits: number
}

type Expanded = { fields: NormalizedField[]; selections: SelectionNode[] }

const argsKey = (field: NormalizedField): string => JSON.stringify([...field.args].sort((a, b) => a.name.localeCompare(b.name)).map(arg => [arg.name, arg.value]))

/**
 * GraphQL field merging: siblings with one response key (`alias ?? name`), one
 * real name, one type condition and the same arguments are one field, their
 * selections joined (`issues { ...A ...B }` with `A { key }` and `B { key
 * summary }` selects `key summary`). Siblings that differ in arguments are not
 * merged: the call is invalid, and both stay in view.
 */
function merged(fields: readonly NormalizedField[]): NormalizedField[] {
  const out: NormalizedField[] = []
  const first = new Map<string, NormalizedField>()
  for (const field of fields) {
    const id = [field.alias ?? field.name, field.name, field.onType ?? '', argsKey(field)].join('\u0000')
    const into = first.get(id)
    if (into === undefined) {
      first.set(id, field)
      out.push(field)
      continue
    }
    into.children = merged([...into.children, ...field.children])
    into.directives = [...new Set([...into.directives, ...field.directives])]
  }
  return out
}

function expand(
  set: SelectionSetNode,
  ctx: Ctx,
  onType: string | undefined,
  depth: number,
  nesting: number,
  stack: string[],
): Expanded {
  if (nesting > MAX_NESTING) throw new Fail('too-large', `Selections nest deeper than ${MAX_NESTING}`)
  const fields: NormalizedField[] = []
  const selections: SelectionNode[] = []
  for (const sel of set.selections) {
    if (++ctx.visits > MAX_VISITS) {
      throw new Fail('too-large', `Operation expands to more than ${MAX_VISITS} selections`)
    }
    const kept = applyConditions(sel.directives, ctx.vars)
    if (kept === null) continue

    if (sel.kind === Kind.FIELD) {
      const fieldDepth = depth + 1
      if (fieldDepth > MAX_DEPTH) throw new Fail('too-large', `Fields nest deeper than ${MAX_DEPTH}`)
      if (++ctx.fields > MAX_FIELDS) {
        throw new Fail('too-large', `Operation expands to more than ${MAX_FIELDS} fields`)
      }
      const nf: NormalizedField = {
        name: sel.name.value,
        args: convertArgs(sel.arguments, ctx.vars),
        directives: otherDirectiveNames(kept),
        children: [],
      }
      if (sel.alias) nf.alias = sel.alias.value
      if (onType !== undefined) nf.onType = onType
      let childSet: SelectionSetNode | undefined
      if (sel.selectionSet) {
        // Children of a field start a fresh type scope.
        const sub = expand(sel.selectionSet, ctx, undefined, fieldDepth, nesting + 1, stack)
        nf.children = sub.fields
        childSet = { kind: Kind.SELECTION_SET, selections: sub.selections }
      }
      fields.push(nf)
      const printedField: FieldNode = {
        kind: Kind.FIELD,
        alias: sel.alias,
        name: sel.name,
        arguments: sel.arguments,
        directives: kept,
        selectionSet: childSet,
      }
      selections.push(printedField)
      continue
    }

    let typeName: string | undefined
    let typeCondition: InlineFragmentNode['typeCondition']
    let body: SelectionSetNode
    let nextStack = stack
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const name = sel.name.value
      if (stack.includes(name)) {
        throw new Fail('fragment-cycle', `Fragment cycle: ${[...stack, name].join(' -> ')}`)
      }
      const frag = ctx.fragments.get(name)
      if (!frag) throw new Fail('unknown-fragment', `Unknown fragment "${name}"`)
      typeCondition = frag.typeCondition
      typeName = frag.typeCondition.name.value
      body = frag.selectionSet
      nextStack = [...stack, name]
    } else {
      typeCondition = sel.typeCondition
      typeName = sel.typeCondition ? sel.typeCondition.name.value : onType
      body = sel.selectionSet
    }
    const sub = expand(body, ctx, typeName, depth, nesting + 1, nextStack)
    fields.push(...sub.fields)
    if (sub.selections.length > 0) {
      const inline: InlineFragmentNode = {
        kind: Kind.INLINE_FRAGMENT,
        typeCondition,
        directives: kept,
        selectionSet: { kind: Kind.SELECTION_SET, selections: sub.selections },
      }
      selections.push(inline)
    }
  }
  return { fields: merged(fields), selections }
}

function run(operation: string, given: Record<string, unknown>): Normalized {
  if (typeof operation !== 'string') {
    return { ok: false, reason: 'unparseable', message: 'Operation is not a string' }
  }
  let doc: DocumentNode
  try {
    doc = parse(operation, { noLocation: true, maxTokens: MAX_TOKENS })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/^Syntax Error: Document contains more th[ae]t? /.test(message)) {
      return { ok: false, reason: 'too-large', message }
    }
    return { ok: false, reason: 'unparseable', message }
  }

  const ops: OperationDefinitionNode[] = []
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const def of doc.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) ops.push(def)
    else if (def.kind === Kind.FRAGMENT_DEFINITION) {
      const name = def.name.value
      if (fragments.has(name)) {
        return { ok: false, reason: 'unparseable', message: `Fragment "${name}" is defined more than once` }
      }
      fragments.set(name, def)
    } else {
      return { ok: false, reason: 'unparseable', message: `Unexpected ${def.kind} in an executable document` }
    }
  }
  const op = ops[0]
  if (!op) return { ok: false, reason: 'no-operation', message: 'Document has no operation' }
  if (ops.length > 1) {
    return {
      ok: false,
      reason: 'multiple-operations',
      message: `Document has ${ops.length} operations; Agent Services runs one per call`,
    }
  }

  const vars: Record<string, unknown> = {}
  const src = given !== null && typeof given === 'object' && !Array.isArray(given) ? given : {}
  for (const k of Object.keys(src)) put(vars, k, src[k])
  for (const vd of op.variableDefinitions ?? []) {
    const name = vd.variable.name.value
    if (vd.defaultValue && (!hasOwn(vars, name) || vars[name] === undefined)) {
      put(vars, name, convertValue(vd.defaultValue, {}).value)
    }
  }

  const ctx: Ctx = { fragments, vars, fields: 0, visits: 0 }
  const top = expand(op.selectionSet, ctx, undefined, 0, 0, [])

  const printedOp: OperationDefinitionNode = {
    kind: Kind.OPERATION_DEFINITION,
    operation: op.operation,
    name: op.name,
    variableDefinitions: op.variableDefinitions,
    directives: op.directives,
    selectionSet: { kind: Kind.SELECTION_SET, selections: top.selections },
  }
  const printed = print({ kind: Kind.DOCUMENT, definitions: [printedOp] })

  const result: Normalized = {
    ok: true,
    opType: op.operation as 'query' | 'mutation' | 'subscription',
    roots: top.fields,
    variables: vars,
    printed,
  }
  if (op.name) result.opName = op.name.value
  return result
}

export function normalize(operation: string, variables: Record<string, unknown>): Normalized {
  try {
    return run(operation, variables)
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.reason, message: e.message }
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    return { ok: false, reason: 'unparseable', message }
  }
}
