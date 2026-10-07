// Trust rules: GraphQL shapes an Agent Services call may run inside without a permission
// dialog. Pure: no $.
//
// The rules are the user's own file, `trust.graphql`. Each named query in it
// is the widest read they would approve. A call fits when every root it
// selects fits a rule's root of the same name: the same field names (aliases
// aside), nothing selected outside the rule's selection, and every argument
// the rule names set to a value the rule allows. A field written in a rule
// with no selection of its own allows anything below it.
//
// Decided from the call's own text and variables alone, never from the
// model's summary. A mutation, a subscription, a root named for a change, a
// directive, or anything this module cannot parse never fits, whatever the
// rules say. A string in a rule is a pattern over the text (`*` matches any
// run), not over what the text means: `project = DEV*` also matches
// `project = DEV OR project = OPS`.

import { adaptExecute } from './adapter.ts'
import { isRecord, LIMIT_ARGS } from './guards.ts'
import { MAX_TOKENS, normalize } from './normalize.ts'
import type { ArgValue, NormalizedField } from './normalize.ts'
import { isDestructiveName, isWriteName } from './risk.ts'
import { Kind, parse, print, visit } from './vendor/graphql.js'
import type { DocumentNode, FragmentDefinitionNode } from './vendor/graphql.js'
import type { RootFit, TrustFit } from '../types'

type DefinitionNode = DocumentNode['definitions'][number]

export type TrustRule = { name: string; roots: NormalizedField[] }
export type TrustRules = { rules: TrustRule[]; problems: string[] }

export type { RootFit }
export type Fit = TrustFit

/** Largest rule file read: far above any hand-written one. */
export const MAX_TRUST_CHARS = 256 * 1024
/** Most rules kept from one file. */
export const MAX_RULES = 200
/** Longest call string a pattern is tried on; longer never fits. */
export const MAX_MATCHED_CHARS = 20_000
/** Most reasons kept per root, and the longest value quoted in one. */
const MAX_REASONS = 12
const QUOTE_CHARS = 120

const EMPTY: TrustRules = { rules: [], problems: [] }

/** The rules in a trust.graphql file; anything unusable is skipped with a problem, never thrown. */
export function parseTrust(text: string): TrustRules {
  if (text.length > MAX_TRUST_CHARS) return { ...EMPTY, problems: [`the file is over ${MAX_TRUST_CHARS / 1024} KB, so no rules were read`] }
  let doc: DocumentNode
  try {
    doc = parse(text, { noLocation: true, maxTokens: MAX_TOKENS })
  } catch (error) {
    return { ...EMPTY, problems: [`the file is not GraphQL: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const problems: string[] = []
  const rules: TrustRule[] = []
  const fragments = doc.definitions.filter((def): def is FragmentDefinitionNode => def.kind === Kind.FRAGMENT_DEFINITION)
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) continue
    if (def.kind !== Kind.OPERATION_DEFINITION) {
      problems.push(`skipped a ${def.kind}: the file holds queries and fragments only`)
      continue
    }
    const name = def.name?.value
    const label = name ?? 'an unnamed operation'
    if (def.operation !== 'query') {
      problems.push(`skipped ${label}: it is a ${def.operation}, and rules allow reads only`)
      continue
    }
    if (name === undefined) {
      problems.push('skipped an unnamed query: name each rule, so the pane can say which one a call fit')
      continue
    }
    if (rules.some(rule => rule.name === name)) {
      problems.push(`skipped the second ${name}: rule names must be unique`)
      continue
    }
    if ((def.variableDefinitions ?? []).length > 0 || hasVariable(def)) {
      problems.push(`skipped ${name}: rules take written values, not variables`)
      continue
    }
    const directives = directivesIn([def, ...fragments])
    if (directives.length > 0) {
      problems.push(`skipped ${name}: rules take no directives (@${directives[0]})`)
      continue
    }
    if (rules.length >= MAX_RULES) {
      problems.push(`skipped ${name} and every rule after it: at most ${MAX_RULES} rules`)
      break
    }
    // normalize expands the file's fragments into the rule, as it does a call's.
    const normalized = normalize(print({ kind: Kind.DOCUMENT, definitions: [def, ...fragments] }), {})
    if (!normalized.ok) {
      problems.push(`skipped ${name}: ${normalized.message}`)
      continue
    }
    rules.push({ name, roots: normalized.roots })
  }
  return { rules, problems }
}

/** Whether a call's execute input fits the rules, and why or why not, in words. */
export function fitCall(input: unknown, rules: readonly TrustRule[]): Fit {
  if (rules.length === 0) return miss('there are no trust rules')
  if (!isRecord(input)) return miss('the call has no operation')
  const extra = Object.keys(input).find(key => key !== 'operation' && key !== 'variables')
  if (extra !== undefined) return miss(`the call also passes ${quote(extra)}, which rules do not cover`)
  const adapted = adaptExecute(input)
  if (!adapted.ok) return miss(`the call cannot be read: ${adapted.error}`)
  const normalized = normalize(adapted.input.operation, adapted.input.variables)
  if (!normalized.ok) return miss(`the operation cannot be read: ${normalized.message}`)
  if (normalized.opType !== 'query') return miss(`a ${normalized.opType} always asks`)
  // Directives the expansion keeps no trace of (on the operation, a fragment, a spread) are found in the text itself.
  const directives = directivesIn(parse(adapted.input.operation, { noLocation: true, maxTokens: MAX_TOKENS }).definitions).filter(name => name !== 'skip' && name !== 'include')
  if (directives.length > 0) return miss(`the operation uses @${directives[0]}, which rules do not cover`)
  if (normalized.roots.length === 0) return miss('the operation selects nothing')

  const fits: RootFit[] = []
  for (const root of normalized.roots) {
    if (isTypename(root)) continue
    if (isWriteName(root.name) || isDestructiveName(root.name)) return miss(`${root.name} is named for a change, so it always asks`)
    const candidates = rules.flatMap(rule => rule.roots.filter(one => one.name === root.name).map(one => ({ rule: rule.name, field: one })))
    if (candidates.length === 0) return miss(`no rule names ${root.name}`)
    let first: string | undefined
    let found: RootFit | undefined
    for (const candidate of candidates) {
      const result = fitField(root, candidate.field, root.name, candidate.rule)
      if (result.ok) {
        found = { root: root.name, rule: candidate.rule, reasons: result.reasons.slice(0, MAX_REASONS) }
        break
      }
      first ??= result.reason
    }
    if (found === undefined) return miss(first ?? `no rule fits ${root.name}`)
    fits.push(found)
  }
  if (fits.length === 0) return miss('the operation selects nothing a rule names')
  return { isAllowed: true, fits }
}

/** Each rule with the roots it allows, for `/gas trust`. */
export function describeRules(rules: readonly TrustRule[]): string[] {
  return rules.map(rule => `${rule.name}: ${[...new Set(rule.roots.map(root => root.name))].join(', ')}`)
}

type Step = { ok: true; reasons: string[] } | { ok: false; reason: string }

/** A call's field against a rule's field of the same name, at `path`. */
function fitField(call: NormalizedField, rule: NormalizedField, path: string, ruleName: string): Step {
  if (call.directives.length > 0) return { ok: false, reason: `${path} uses @${call.directives[0]}, which rules do not cover` }
  const reasons: string[] = []
  for (const constraint of rule.args) {
    const given = call.args.find(arg => arg.name === constraint.name)
    if (given === undefined || given.value === undefined) {
      return { ok: false, reason: `${path} does not set ${constraint.name}, which ${ruleName} requires to be ${shown(constraint.value)}` }
    }
    const step = fitValue(given.value, constraint.value, isLimit(constraint))
    if (!step.ok) return { ok: false, reason: `${path}: ${constraint.name} ${shown(given.value)} is not ${step.reason} (${ruleName})` }
    reasons.push(`${constraint.name} ${shown(given.value)} ${step.reason}`)
  }
  if (rule.children.length === 0) {
    if (call.children.length > 0) reasons.push(`anything under ${path}`)
    return { ok: true, reasons }
  }
  if (call.children.length === 0) return { ok: true, reasons }
  for (const child of call.children) {
    if (isTypename(child)) continue
    const at = `${path}.${child.name}`
    // A rule child under `... on T` covers only the call's children under the same condition.
    const candidates = rule.children.filter(one => one.name === child.name && (one.onType === undefined || one.onType === child.onType))
    if (candidates.length === 0) return { ok: false, reason: `${at}${child.onType === undefined ? '' : ` (on ${child.onType})`} is outside ${ruleName}` }
    let first: string | undefined
    let matched: string[] | undefined
    for (const candidate of candidates) {
      const step = fitField(child, candidate, at, ruleName)
      if (step.ok) {
        matched = step.reasons
        break
      }
      first ??= step.reason
    }
    if (matched === undefined) return { ok: false, reason: first ?? `${at} is outside ${ruleName}` }
    reasons.push(...matched)
  }
  return { ok: true, reasons }
}

type ValueStep = { ok: true; reason: string } | { ok: false; reason: string }

/**
 * A call's argument value against the rule's: a string is a pattern, a
 * number on a limit argument a maximum (at least 1, since 0 or a negative
 * can mean no limit at all), a list the values allowed for each item, an
 * object the keys it constrains; anything else must be equal.
 */
function fitValue(value: unknown, rule: unknown, isLimit: boolean): ValueStep {
  if (typeof rule === 'string') {
    if (typeof value !== 'string') return { ok: false, reason: `matching ${shown(rule)}` }
    return value.length <= MAX_MATCHED_CHARS && globMatches(rule, value) ? { ok: true, reason: rule.includes('*') ? `~ ${shown(rule)}` : `= ${shown(rule)}` } : { ok: false, reason: `matching ${shown(rule)}` }
  }
  if (typeof rule === 'number') {
    const number = numberOf(value)
    if (isLimit) return number !== undefined && Number.isInteger(number) && number >= 1 && number <= rule ? { ok: true, reason: `≤ ${rule}` } : { ok: false, reason: `between 1 and ${rule}` }
    return number === rule ? { ok: true, reason: `= ${rule}` } : { ok: false, reason: `${rule}` }
  }
  if (Array.isArray(rule)) {
    // GraphQL takes a single value where a list is declared: it is a list of one.
    const items = Array.isArray(value) ? value : [value]
    // An empty list can mean "no filter"; only a rule's own empty list allows it.
    if (items.length === 0 && rule.length > 0) return { ok: false, reason: `items from ${shown(rule)}` }
    for (const item of items) {
      if (!rule.some(allowed => fitValue(item, allowed, isLimit).ok)) return { ok: false, reason: `items from ${shown(rule)}` }
    }
    return { ok: true, reason: `in ${shown(rule)}` }
  }
  if (isRecord(rule)) {
    if (!isRecord(value)) return { ok: false, reason: `an object with ${shown(rule)}` }
    for (const [key, allowed] of Object.entries(rule)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) return { ok: false, reason: `an object that sets ${key}` }
      const step = fitValue(value[key], allowed, LIMIT_ARGS.includes(key.toLowerCase()))
      if (!step.ok) return { ok: false, reason: `an object whose ${key} is ${step.reason}` }
    }
    return { ok: true, reason: `has ${shown(rule)}` }
  }
  return value === rule ? { ok: true, reason: `= ${shown(rule)}` } : { ok: false, reason: shown(rule) }
}

/** `*` matches any run of characters, everything else itself; the whole value must match. Linear backtracking, no RegExp. */
export function globMatches(pattern: string, value: string): boolean {
  let p = 0
  let v = 0
  let star = -1
  let resume = 0
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++
      resume = v
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p++
      v++
    } else if (star >= 0) {
      p = star + 1
      v = ++resume
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

const miss = (reason: string): Fit => ({ isAllowed: false, reason })

const isTypename = (field: NormalizedField): boolean => field.name === '__typename' && field.args.length === 0 && field.directives.length === 0 && field.children.length === 0

const isLimit = (arg: ArgValue): boolean => LIMIT_ARGS.includes(arg.name.toLowerCase())

/** A number, or a large int kept as its source text. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d{1,30}$/.test(value)) return Number(value)
  return undefined
}

function hasVariable(def: DefinitionNode): boolean {
  let found = false
  visit(def, { Variable: () => { found = true } })
  return found
}

/** Every directive's name in these definitions, in order. */
function directivesIn(defs: readonly DefinitionNode[]): string[] {
  const names: string[] = []
  for (const def of defs) visit(def, { Directive: node => { names.push(node.name.value) } })
  return names
}

const quote = (text: string): string => JSON.stringify(text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text)

/** A value as a reason quotes it. */
function shown(value: unknown): string {
  if (typeof value === 'string') return quote(value)
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text
}
