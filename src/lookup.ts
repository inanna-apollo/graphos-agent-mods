// Claude's calls to Agent Services' search, introspect, validate and dry_run:
// what each asked and what came back, as the pane draws them. Pure: no $.
//
// Each lookup becomes a CallIR like an execute call's, so the same planner,
// form and cards draw it. validate and dry_run carry the operation Claude
// sent, annotated with the call's own answer. search and introspect carry
// what the schema declares: each operation found, or the type asked for, as
// fields built from the response's SDL (src/annotate.ts fieldOfDef). The
// input and the response are untrusted: bounded here, escaped when drawn.

import type { CallIR, CheckContext, Checks, FieldIR, LookupFound, LookupInput, LookupTool, OpType } from './ir.ts'
import { annotate, fieldOfDef } from './annotate.ts'
import { buildIR } from './build.ts'
import { accessEvidenceOf, requestErrorOf, validationOf } from './gas.ts'
import { appendCheckContext } from './checks.ts'
import type { Access, Validation } from './gas.ts'
import { isRecord } from './guards.ts'
import { normalize } from './normalize.ts'
import { enumsOf, indexSdl, inputsOf, memberDetailsOf, typeDescriptionsOf, typeKindsOf, unionsOf } from './schema.ts'
import type { FieldDef, SchemaIndex } from './schema.ts'

export const LOOKUP_TOOLS: readonly LookupTool[] = ['search', 'introspect', 'validate', 'dry_run']

/** The lookup an MCP tool's own name is (`search`, …), or undefined for `execute` and anything else. */
export function lookupToolOf(tool: string): LookupTool | undefined {
  return (LOOKUP_TOOLS as readonly string[]).includes(tool) ? (tool as LookupTool) : undefined
}

// ---- Bounds

const TERMS_MAX = 20
const TERM_MAX = 200
const NAME_MAX = 200
const REQUESTS_MAX = 20
/** Operations a search keeps, in the order Agent Services ranked them. */
export const HITS_MAX = 10
/** Stored field nodes per lookup, independent of the pane's display limits. */
const FIELDS_MAX = 1_024
/** SDL looked at: per string, strings in all, and characters in all. */
const SDL_MAX = 64 * 1024
const SDLS_MAX = 200
const SDL_TOTAL = 512 * 1024
/** Schema descriptions an entry keeps, in characters; past it they are dropped and the entry says so. */
const DESCRIPTIONS_MAX = 48 * 1024
const ERROR_MAX = 1_000
const SCOPES_MAX = 200
const MEMBERS_MAX = 512
/** A service name as Agent Services spells one (`google-search-console`). */
const SCOPE = /^[a-z0-9][a-z0-9_-]{0,79}$/i
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined)

/** SDL strings, bounded: each, how many, and all together. */
function boundedSdl(value: unknown): { schema: SchemaIndex; complete: boolean; omissions: string[] } {
  const all: unknown[] = Array.isArray(value) ? value : []
  const kept: string[] = []
  const omissions: string[] = []
  if (!Array.isArray(value)) omissions.push('schema declarations were not supplied as a list')
  if (all.length > SDLS_MAX) omissions.push(`${all.length - SDLS_MAX} schema strings omitted by the source limit`)
  let total = 0
  let skipped = 0
  let malformed = 0
  for (const sdl of all.slice(0, SDLS_MAX)) {
    if (typeof sdl !== 'string') { malformed++; continue }
    if (sdl.length > SDL_MAX || total + sdl.length > SDL_TOTAL) { skipped++; continue }
    kept.push(sdl)
    total += sdl.length
  }
  if (skipped > 0) omissions.push(`${skipped} schema strings omitted by the size limit`)
  if (malformed > 0) omissions.push(`${malformed} schema entries were not strings`)
  const report = { parsed: 0, failed: 0 }
  const schema = indexSdl(kept, new Map(), report)
  if (report.failed > 0) omissions.push(`${report.failed} schema strings could not be read as schema declarations`)
  return { schema, complete: omissions.length === 0, omissions }
}

const count = (value: number, complete: boolean): NonNullable<NonNullable<LookupFound['counts']>['fields']> =>
  complete ? { kind: 'exact', value } : value > 0 ? { kind: 'at-least', value } : { kind: 'unknown' }

/** Retain declarations with one shared node budget, without building an oversized tree first. */
function retainedField(def: FieldDef, owner: string, path: string, schema: SchemaIndex, depth: number, budget: { left: number; omitted: boolean; memberOmitted?: boolean }, seen: ReadonlySet<string>, scope?: string, isRoot = false): FieldIR | undefined {
  if (budget.left === 0) { budget.omitted = true; return undefined }
  budget.left--
  const field = fieldOfDef(def, owner, path, schema, { depth: 0, maxChildren: 0, isRoot, ...(scope !== undefined && { service: scope }) })
  for (const arg of field.omittedArgs ?? []) {
    const named = def.argDefs[arg.name]?.namedType ?? ''
    if ((enumsOf(schema).get(named)?.length ?? 0) > (arg.enumValues?.length ?? 0) || (inputsOf(schema).get(named)?.length ?? 0) > (arg.inputFields?.length ?? 0)) budget.memberOmitted = true
  }
  const inner = schema.get(def.namedType)
  if (depth <= 0 || inner === undefined || seen.has(def.namedType) || def.isOpaque === true) return field
  const below = new Set([...seen, def.namedType])
  for (const child of inner.values()) {
    const kept = retainedField(child, def.namedType, `${path}.${child.name}`, schema, depth - 1, budget, below, scope)
    if (kept === undefined) break
    field.children.push(kept)
  }
  return field
}

const walk = (fields: readonly FieldIR[]): FieldIR[] => fields.flatMap(field => [field, ...walk(field.children)])

// ---- The input

export type AdaptedLookup = {
  input: LookupInput
  /** The operations sent (validate's, dry_run's), each with its service; empty for search and introspect. */
  requests: { scope: string; operation: string; responseIndex?: number }[]
  /** What the raw view shows: the operations, and the rest of the input as JSON. */
  operation: string
  variables: string
  /** Why the input could not be read, when it could not. */
  error?: string
}

/** A lookup's input as the model sent it, shape-checked and bounded. A part that is not what the tool takes is left out, and says why. */
export function adaptLookup(tool: LookupTool, raw: unknown): AdaptedLookup {
  const e = isRecord(raw) ? raw : {}
  let variables = ''
  try { variables = JSON.stringify(raw, null, 2) ?? '' } catch { variables = 'Input could not be serialized.' }
  const scope = text(e.scope, NAME_MAX)
  if (tool === 'search') {
    const terms = Array.isArray(e.terms) ? e.terms.filter((one): one is string => typeof one === 'string').slice(0, TERMS_MAX).map(one => one.slice(0, TERM_MAX)) : undefined
    const operationType = e.operationType === 'query' || e.operationType === 'mutation' ? e.operationType : undefined
    const input: LookupInput = { terms: terms ?? [], ...(scope !== undefined && { scope }), ...(operationType !== undefined && { operationType }) }
    return { input, requests: [], operation: '', variables, ...(terms === undefined && { error: 'terms is not a list of strings' }) }
  }
  if (tool === 'introspect') {
    const type = text(e.type, NAME_MAX)
    const depth = typeof e.depth === 'number' && Number.isInteger(e.depth) && e.depth >= 0 && e.depth <= 100 ? e.depth : undefined
    const input: LookupInput = { ...(type !== undefined && { type }), ...(scope !== undefined && { scope }), ...(depth !== undefined && { depth }) }
    return { input, requests: [], operation: '', variables, ...(type === undefined && { error: 'no type named' }) }
  }
  if (tool === 'validate') {
    const operation = typeof e.operation === 'string' ? e.operation : undefined
    const input: LookupInput = { ...(scope !== undefined && { scope }) }
    return {
      input,
      requests: operation === undefined ? [] : [{ scope: scope ?? '', operation }],
      operation: operation ?? '',
      variables,
      ...(operation === undefined && { error: 'operation is not a string' }),
    }
  }
  const all = Array.isArray(e.requests) ? e.requests : undefined
  const requests = (all ?? []).slice(0, REQUESTS_MAX).flatMap((one, responseIndex) => (isRecord(one) && typeof one.operation === 'string' ? [{ scope: text(one.scope, NAME_MAX) ?? '', operation: one.operation, responseIndex }] : []))
  const input: LookupInput = { scopes: requests.map(one => one.scope) }
  return {
    input,
    requests,
    operation: requests.map(one => `# ${one.scope.replace(/\s+/g, ' ')}\n${one.operation}`).join('\n\n'),
    variables,
    ...((all === undefined || requests.length === 0) && { error: 'requests is not a list of operations' }),
    ...(all !== undefined && requests.length < Math.min(all.length, REQUESTS_MAX) && { error: 'some requests could not be read' }),
    ...(all !== undefined && all.length > REQUESTS_MAX && { error: `only the first ${REQUESTS_MAX} requests are shown` }),
  }
}

// ---- The IR

/** The services a lookup names, each once. */
const servicesOf = (scopes: readonly (string | undefined)[]) => [...new Set(scopes.filter((one): one is string => one !== undefined && one !== ''))]

/** An operation Claude sent, parsed as an execute call's is; the root fields take the service the call names. */
function operationIR(id: string, operation: string, scope: string): CallIR {
  const ir = buildIR(id, normalize(operation, {}))
  if (ir.state === 'unparseable' || scope === '') return ir
  return { ...ir, service: scope, services: [scope], roots: ir.roots.map(root => ({ ...root, service: scope })) }
}

/** A path under a prefix, so two requests' roots never share one. */
function prefixed(field: FieldIR, prefix: string): FieldIR {
  return { ...field, path: `${prefix}${field.path}`, children: field.children.map(child => prefixed(child, prefix)) }
}

/** dry_run's requests as one IR: their roots in order, a later request's renamed where its paths would meet an earlier one's. */
function joinIRs(id: string, irs: readonly CallIR[]): CallIR {
  const parsed = irs.filter(ir => ir.state !== 'unparseable' && ir.opType !== undefined)
  const first = parsed[0]
  if (first === undefined) return irs[0] ?? buildIR(id, { ok: false, reason: 'unparseable', message: 'no operation could be read' })
  const used = new Set<string>()
  const roots = irs.flatMap((ir, at) => {
    if (ir.state === 'unparseable' || ir.opType === undefined) return []
    const request = { index: at, opType: ir.opType }
    const isMet = ir.roots.some(root => used.has(root.path))
    const kept = ir.roots.map(root => ({
      ...(isMet ? prefixed(root, `r${at + 1}:`) : root),
      request,
    }))
    for (const root of kept) used.add(root.path)
    return kept
  })
  const opType: OpType = parsed.some(ir => ir.opType === 'mutation') ? 'mutation' : (first.opType ?? 'query')
  let checks: Checks | undefined
  for (const ir of irs) {
    if (ir.checks === undefined) continue
    if (checks === undefined) checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
    const severity = ['ok', 'skipped', 'not-allowed', 'failed']
    for (const key of ['policy', 'validation', 'schema'] as const) if (severity.indexOf(ir.checks[key]) > severity.indexOf(checks[key])) checks[key] = ir.checks[key]
    checks.error ??= ir.checks.error
    checks = appendCheckContext(checks, ir.checks.context ?? [])
    if (ir.checks.contextOmitted !== undefined) checks.contextOmitted = (checks.contextOmitted ?? 0) + ir.checks.contextOmitted
  }
  return {
    ...first,
    toolCallId: id,
    opType,
    roots,
    services: servicesOf(parsed.flatMap(ir => ir.services ?? [])),
    printed: parsed.map(ir => ir.printed ?? '').join('\n\n'),
    ...(checks !== undefined && { checks }),
  }
}

/** What the pane draws while a lookup waits for its answer: the operations it sent, or nothing yet for a search or an introspect. */
export function pendingIR(id: string, tool: LookupTool, adapted: AdaptedLookup): CallIR {
  if (tool === 'validate' || tool === 'dry_run') {
    if (adapted.requests.length === 0) return buildIR(id, { ok: false, reason: 'unparseable', message: adapted.error ?? 'no operation' })
    const irs = adapted.requests.map(one => operationIR(id, one.operation, one.scope))
    return tool === 'validate' ? (irs[0] as CallIR) : joinIRs(id, irs)
  }
  const scope = adapted.input.scope
  return { toolCallId: id, state: 'ready', opType: 'query', roots: [], ...(scope !== undefined && { service: scope, services: [scope] }) }
}

/** Each field's policy, as a dry_run's answer gave it, read back from an IR (to annotate it again with the schema). */
export function accessFromIR(ir: CallIR): Access | undefined {
  const fields = walk(ir.roots).filter(field => field.policy !== 'unknown')
  if (fields.length === 0 && ir.isOperationDenied !== true) return undefined
  return { denyOperation: ir.isOperationDenied === true, fields: new Map(fields.map(field => [field.path, { decision: field.policy as 'allow' | 'mask' | 'deny' }] as const)) }
}

// ---- The response

export type Settled = { ir: CallIR; found: LookupFound }

/**
 * Drops descriptions past the budget, from the last field back, so the
 * first operations and fields keep theirs. True when any was dropped.
 */
function trimDescriptions(roots: FieldIR[]): boolean {
  let left = DESCRIPTIONS_MAX
  let isTrimmed = false
  const visit = (field: FieldIR): FieldIR => {
    const description = field.schema?.description
    let schema = field.schema
    if (description !== undefined && schema !== undefined) {
      if (description.length <= left) left -= description.length
      else {
        const { description: _dropped, ...rest } = schema
        schema = rest
        isTrimmed = true
      }
    }
    const omittedArgs = field.omittedArgs?.map(arg => {
      if (arg.description === undefined) return arg
      if (arg.description.length <= left) {
        left -= arg.description.length
        return arg
      }
      isTrimmed = true
      const { description: _dropped, ...rest } = arg
      return rest
    })
    return { ...field, ...(schema !== undefined && { schema }), ...(omittedArgs !== undefined && { omittedArgs }), children: field.children.map(visit) }
  }
  const kept = roots.map(visit)
  roots.splice(0, roots.length, ...kept)
  return isTrimmed
}

const ROOT_OF: Record<'query' | 'mutation', string> = { query: 'Query', mutation: 'Mutation' }

/** search: each operation found, ranked, as the schema declares it; the catalog when Claude asked for nothing else. */
function searchSettled(id: string, adapted: AdaptedLookup, value: Record<string, unknown>, bytes: number): Settled {
  const results: unknown[] = Array.isArray(value.results) ? value.results : []
  const roots: FieldIR[] = []
  const seen = new Set<string>()
  const mutations: string[] = []
  const omissions: string[] = []
  if (!Array.isArray(value.results)) omissions.push('matching operation definitions were not supplied as a list')
  let hits = 0
  let malformed = 0
  const budget = { left: FIELDS_MAX, omitted: false, memberOmitted: false }
  for (const hit of results) {
    if (!isRecord(hit)) { malformed++; continue }
    const name = typeof hit.operationName === 'string' ? hit.operationName : undefined
    if (name === undefined || name.length > NAME_MAX || !GRAPHQL_NAME.test(name) || (hit.operationType !== 'query' && hit.operationType !== 'mutation')) { malformed++; continue }
    const opType = hit.operationType
    const scope = typeof hit.scope === 'string' && SCOPE.test(hit.scope) ? hit.scope : undefined
    const key = `${scope ?? ''}:${opType}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    hits++
    if (roots.length >= HITS_MAX) continue
    const parsed = boundedSdl(hit.types)
    omissions.push(...parsed.omissions)
    const schema = parsed.schema
    const def = schema.get(ROOT_OF[opType])?.get(name)
    if (def === undefined) omissions.push('some matching operation declarations were unavailable')
    // Equal names from different operation types/services keep distinct paths.
    const candidate = roots.some(root => root.path === name) ? `${name}~${opType}` : name
    const path = roots.some(root => root.path === candidate) ? `${candidate}~${roots.length + 1}` : candidate
    const root: FieldIR = def === undefined
      ? { name, coordinate: `${ROOT_OF[opType]}.${name}`, path, args: [], policy: 'unknown', children: [], ...(scope !== undefined && { service: scope }) }
      : (retainedField(def, ROOT_OF[opType], path, schema, 2, budget, new Set(), scope, true) ?? { name, coordinate: `${ROOT_OF[opType]}.${name}`, path, args: [], policy: 'unknown', children: [], ...(scope !== undefined && { service: scope }) })
    if (opType === 'mutation') mutations.push(path)
    roots.push(root)
  }
  const hasErrors = value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0)
  const countComplete = Array.isArray(value.results) && malformed === 0 && !hasErrors
  if (malformed > 0) omissions.push(`${malformed} matching operation definitions could not be read`)
  if (hasErrors) omissions.push(Array.isArray(value.errors) ? 'the search reported errors alongside its matches' : 'the search error details could not be read')
  if (hits > roots.length) omissions.push(`${hits - roots.length} matching operation definitions omitted from retained detail`)
  if (budget.omitted) omissions.push('field declarations omitted by the retained node limit')
  if (budget.memberOmitted) omissions.push('argument type members omitted from retained detail')
  const isTrimmed = trimDescriptions(roots)
  if (isTrimmed) omissions.push('schema descriptions omitted by the retained text limit')
  const isCatalog = (adapted.input.terms ?? []).length === 0
  const allScopes = isCatalog && Array.isArray(value.scopes) ? value.scopes.filter((one): one is string => typeof one === 'string' && SCOPE.test(one)) : undefined
  const scopes = allScopes?.slice(0, SCOPES_MAX)
  if (allScopes !== undefined && allScopes.length > SCOPES_MAX) omissions.push(`${allScopes.length - SCOPES_MAX} catalog services omitted from retained detail`)
  if (isCatalog && (!Array.isArray(value.scopes) || allScopes?.length !== value.scopes.length)) omissions.push('the catalog service list is unavailable or partially unreadable')
  const services = servicesOf(roots.map(root => root.service))
  const ir: CallIR = {
    toolCallId: id, state: 'ready', opType: 'query', roots,
    ...(services[0] !== undefined && { service: services[0], services }),
    ...(typeof value.bundleDigest === 'string' && { bundleDigest: value.bundleDigest.slice(0, 200) }),
  }
  const found: LookupFound = {
    bytes,
    ...(Array.isArray(value.results) && { hits }),
    counts: { hits: count(hits, countComplete), ...(isCatalog && { scopes: count(allScopes?.length ?? 0, !hasErrors && Array.isArray(value.scopes) && allScopes?.length === value.scopes.length) }) },
    completeness: omissions.length === 0 ? 'complete' : roots.length > 0 || scopes !== undefined ? 'partial' : 'unavailable',
    ...(omissions.length > 0 && { omissions: [...new Set(omissions)].slice(0, 30) }),
    ...(scopes !== undefined && { scopes }),
    ...(mutations.length > 0 && { mutations }),
    ...(isTrimmed && { isTrimmed }),
  }
  return { ir, found }
}

/** introspect: the type asked for, its fields as the schema declares them, and an enum's values or an input's fields. */
function introspectSettled(id: string, adapted: AdaptedLookup, value: Record<string, unknown>, bytes: number): Settled {
  const parsed = boundedSdl(value.types)
  const schema = parsed.schema
  const omissions = [...parsed.omissions]
  if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0)) omissions.push(Array.isArray(value.errors) ? 'the type lookup reported errors alongside its declarations' : 'the type lookup error details could not be read')
  const sourceComplete = parsed.complete && omissions.length === 0
  const asked = adapted.input.type ?? ''
  const scope = adapted.input.scope
  const fields = schema.get(asked)
  // Reference hops constrain the represented tree; direct declaration counts never come from that tree.
  const depth = Math.min(Math.max(adapted.input.depth ?? 1, 1), 2)
  const budget = { left: FIELDS_MAX - 1, omitted: false, memberOmitted: false }
  const children: FieldIR[] = []
  for (const def of fields?.values() ?? []) {
    const kept = retainedField(def, asked, def.name, schema, depth - 1, budget, new Set([asked]))
    if (kept === undefined) break
    children.push(kept)
  }
  if (budget.omitted) omissions.push('field declarations omitted by the retained node limit')
  if (budget.memberOmitted) omissions.push('argument type members omitted from retained detail')
  const description = typeDescriptionsOf(schema).get(asked)
  const members = enumsOf(schema).get(asked) ?? inputsOf(schema).get(asked) ?? unionsOf(schema).get(asked)
  let memberTextLeft = DESCRIPTIONS_MAX
  let isMemberTrimmed = false
  const keepText = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined
    if (text.length > 2_000 || text.length > memberTextLeft) {
      isMemberTrimmed = true
      return undefined
    }
    memberTextLeft -= text.length
    return text
  }
  const memberDetails = members?.slice(0, MEMBERS_MAX).map(member => {
    const detail = memberDetailsOf(schema).get(asked)?.get(member)
    const description = keepText(detail?.description ?? (typeKindsOf(schema).get(asked) === 'union' ? typeDescriptionsOf(schema).get(member) : undefined))
    const reason = keepText(detail?.deprecated)
    return { name: detail?.name ?? member, ...(description !== undefined && { description }), ...(detail?.deprecated !== undefined && { deprecated: reason ?? 'deprecated' }) }
  })
  const root: FieldIR = {
    name: asked,
    coordinate: asked,
    path: asked,
    args: [],
    policy: 'unknown',
    children,
    ...(scope !== undefined && { service: scope }),
    ...(typeKindsOf(schema).has(asked) && { schema: { type: asked, isList: false, isNonNull: false, isListItemNonNull: false, isListNonNull: false, scopes: [], tags: [], ...(description !== undefined && { description }) } }),
  }
  const roots = asked === '' ? [] : [root]
  const isFieldTextTrimmed = trimDescriptions(roots)
  const isTrimmed = isFieldTextTrimmed || isMemberTrimmed
  if (isTrimmed) omissions.push('schema descriptions omitted by the retained text limit')
  if (members !== undefined && members.length > MEMBERS_MAX) omissions.push(`${members.length - MEMBERS_MAX} declared members omitted from retained detail`)
  const ir: CallIR = {
    toolCallId: id,
    state: 'ready',
    opType: 'query',
    roots,
    ...(scope !== undefined && { service: scope, services: [scope] }),
    ...(typeof value.bundleDigest === 'string' && { bundleDigest: value.bundleDigest.slice(0, 200) }),
  }
  const types = typeKindsOf(schema)
  const typeKind = types.get(asked) ?? (sourceComplete && asked !== '' ? 'absent' : 'unavailable')
  return { ir, found: {
    bytes, types: types.size, typeKind,
    counts: { types: count(types.size, sourceComplete), ...(typeKind !== 'unavailable' && { fields: count(fields?.size ?? inputsOf(schema).get(asked)?.length ?? 0, sourceComplete) }), ...(members !== undefined && { members: count(members.length, sourceComplete) }) },
    completeness: omissions.length === 0 ? 'complete' : types.size > 0 ? 'partial' : 'unavailable',
    ...(omissions.length > 0 && { omissions }),
    ...(members !== undefined && { members: members.slice(0, MEMBERS_MAX), memberDetails }),
    ...(isTrimmed && { isTrimmed }),
  } }
}

const CHECKED_SCHEMA_LATER = { schema: 'skipped' } as const

/** validate: the operation Claude sent, with the compiler's answer. */
function validateSettled(id: string, adapted: AdaptedLookup, value: Record<string, unknown>, bytes: number): Settled {
  const target = adapted.input.scope ? { kind: 'request' as const, scope: adapted.input.scope, index: 0 } : { kind: 'call' as const }
  const reported = validationOf(value)
  if (reported === undefined) {
    const issue = typeof value.valid === 'boolean' ? 'schema-validation diagnostics could not be read' : 'the response did not report a schema-validation result'
    const ir = annotate(pendingIR(id, 'validate', adapted), { isIncomplete: true, checks: appendCheckContext({ policy: 'skipped', validation: 'failed', ...CHECKED_SCHEMA_LATER }, [{ check: 'validation', target, source: 'tool-response', tool: 'validate', outcome: 'failed', reason: 'missing-data', message: issue }]) })
    return { ir, found: { bytes, completeness: 'unavailable', unreadable: issue } }
  }
  const omissions: string[] = []
  if (reported.diagnostics.length > REQUESTS_MAX || reported.diagnostics.some(one => one.length > ERROR_MAX)) omissions.push('schema-validation diagnostics omitted by the retained text limit')
  const validation: Validation = { valid: reported.valid, diagnostics: reported.diagnostics.slice(0, REQUESTS_MAX).map(one => one.slice(0, ERROR_MAX)) }
  const scope = adapted.input.scope ?? ''
  const ir = annotate(pendingIR(id, 'validate', adapted), {
    validation,
    isIncomplete: omissions.length > 0,
    ...(scope !== '' && { scope, rootScopes: new Map() }),
    checks: appendCheckContext({ policy: 'skipped', validation: 'ok', ...CHECKED_SCHEMA_LATER }, [{ check: 'validation', target, source: 'tool-response', tool: 'validate', outcome: 'ok' }]),
  })
  return { ir: withScope(ir, scope), found: { bytes, problems: reported.diagnostics.length, completeness: omissions.length > 0 ? 'partial' : 'complete', ...(omissions.length > 0 && { omissions }) } }
}

/** Every root keeps the service the call named. */
const withScope = (ir: CallIR, scope: string): CallIR => (scope === '' || ir.state === 'unparseable' ? ir : { ...ir, service: scope, services: [scope], roots: ir.roots.map(root => ({ ...root, service: scope })) })

/** dry_run: each request's operation with the policy Agent Services gave each field, and how each request fared. */
function dryRunSettled(id: string, adapted: AdaptedLookup, value: Record<string, unknown>, bytes: number): Settled {
  const results = Array.isArray(value.results) ? value.results : []
  const requests: NonNullable<LookupFound['requests']> = []
  const irs = adapted.requests.map((one, at) => {
    const result: unknown = results[one.responseIndex ?? at]
    const evidence = accessEvidenceOf(result)
    const { access, issue: error } = evidence
    const isPartial = error !== undefined
    const base = { check: 'policy', target: { kind: 'request', scope: one.scope, index: at }, source: 'tool-response', tool: 'dry_run' } as const
    const context: CheckContext[] = error === undefined ? [{ ...base, outcome: 'ok', operationDenied: access?.denyOperation === true }] : [{ ...base, outcome: 'failed', reason: evidence.reason ?? 'missing-data', message: error }]
    if (isPartial && access?.denyOperation === true) context.push({ ...base, outcome: 'ok', operationDenied: true })
    const checks = appendCheckContext({ policy: isPartial ? 'failed' : 'ok', validation: 'skipped', ...CHECKED_SCHEMA_LATER }, context)
    requests.push({ scope: one.scope, ...(access?.denyOperation === true && { isDenied: true }), ...(error !== undefined && { error: error.slice(0, ERROR_MAX) }) })
    const ir = operationIR(id, one.operation, one.scope)
    if (access === undefined) return annotate(ir, { isIncomplete: true, checks })
    // Tokens are for an access request Claude files from an execute's answer; the pane says only that there was one.
    const tokenless: Access = { denyOperation: access.denyOperation, fields: new Map([...access.fields].map(([path, decision]) => [path, { decision: decision.decision, ...(decision.denialContext !== undefined && { denialContext: '' }) }])) }
    return withScope(annotate(ir, { access: tokenless, isIncomplete: isPartial, checks }), one.scope)
  })
  const joined = joinIRs(id, irs)
  const error = requestErrorOf(value)
  if (error !== undefined) joined.checks = appendCheckContext({ ...(joined.checks ?? { validation: 'skipped', schema: 'skipped' }), policy: 'failed' }, [{ check: 'policy', target: { kind: 'call' }, source: 'tool-response', tool: 'dry_run', outcome: 'failed', reason: error.reason, message: error.issue }])
  const isAnyDenied = requests.some(one => one.isDenied === true)
  const isIncomplete = requests.length === 0 || error !== undefined || adapted.error !== undefined || requests.some(one => one.error !== undefined)
  const omissions = [adapted.error, error?.issue].filter((one): one is string => one !== undefined)
  return { ir: { ...joined, ...(isIncomplete && joined.state !== 'unparseable' && { state: 'partial' }), ...(isAnyDenied && { isOperationDenied: true }) }, found: { bytes, requests, completeness: isIncomplete ? 'partial' : 'complete', ...(omissions.length > 0 && { omissions }) } }
}

/**
 * What a settled lookup's response says, and the IR the pane draws from
 * it. `response` is the parsed JSON (src/result.ts responseIn); a response
 * that is not an object is said as unreadable, with the IR kept as sent.
 */
export function settledLookup(id: string, tool: LookupTool, adapted: AdaptedLookup, response: unknown, bytes: number, unreadable?: string): Settled {
  if (!isRecord(response)) {
    const why = (unreadable ?? 'the response is not JSON').replace(/\s+/g, ' ').slice(0, 300)
    const check = tool === 'dry_run' ? 'policy' : tool === 'validate' ? 'validation' : 'schema'
    const checks = appendCheckContext({ policy: 'skipped', validation: 'skipped', schema: 'skipped', [check]: 'failed' }, [{ check, target: { kind: 'call' }, source: 'tool-response', tool, outcome: 'failed', reason: 'missing-data', message: why }])
    const pending = pendingIR(id, tool, adapted)
    return { ir: { ...pending, ...(pending.state !== 'unparseable' && { state: 'partial' }), checks }, found: { bytes, unreadable: why, completeness: 'unavailable', ...(tool === 'introspect' && { typeKind: 'unavailable', counts: { types: { kind: 'unknown' } } }), ...(tool === 'search' && { counts: { hits: { kind: 'unknown' } } }) } }
  }
  if (tool === 'search') return searchSettled(id, adapted, response, bytes)
  if (tool === 'introspect') return introspectSettled(id, adapted, response, bytes)
  if (tool === 'validate') return validateSettled(id, adapted, response, bytes)
  return dryRunSettled(id, adapted, response, bytes)
}

/** What a failed lookup's result says: Agent Services' first error message, else the text itself, whitespace laid flat; at most 300 characters, escaped when drawn. */
export function lookupErrorOf(response: unknown, text: string): string | undefined {
  const errors = isRecord(response) && Array.isArray(response.errors) ? response.errors : []
  const first: unknown = errors[0]
  const message = typeof first === 'string' ? first : isRecord(first) && typeof first.message === 'string' ? first.message : text
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat === '' ? undefined : flat.slice(0, 300)
}

/** The lookups whose IR is an operation Claude sent, which the schema's own descriptions can fill in. */
export const isOperationLookup = (tool: LookupTool | undefined): boolean => tool === 'validate' || tool === 'dry_run'
