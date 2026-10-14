// Enrichment: validate, dry_run and schema lookups for one call, in parallel.
// Pure apart from the `call` handed in (register.tsx passes $.mcp.call), so
// it is tested in plain Node with canned Agent Services answers.
//
// Only read-only Agent Services tools are ever called: search, introspect, validate,
// dry_run. Every failure leaves its facts unknown; nothing is assumed.

import type { McpToolResult } from 'claude-code'

import { annotate } from './annotate.ts'
import type { Enrichment } from './annotate.ts'
import { depthOf, provisionalService } from './build.ts'
import { accessEvidenceOf, payloadOf, requestErrorOf, scopeFor, sdlOf, validationOf } from './gas.ts'
import type { Access, Validation } from './gas.ts'
import type { CallIR, CheckContext, CheckOutcome, Checks, FieldIR } from './ir.ts'
import { appendCheckContext, checkFailureContext, normalizeCheckContext } from './checks.ts'
import { indexSdl, typeKindsOf } from './schema.ts'
import type { SchemaIndex } from './schema.ts'
import { subOperation, unique } from './split.ts'

export type GasTool = 'search' | 'introspect' | 'validate' | 'dry_run'
export type CallGas = (tool: GasTool, args: Record<string, unknown>) => Promise<McpToolResult>

/** An enrichment read must need no dialog and fit the organization's ceiling. */
export function isAllowedWithoutPrompt(verdict: { decision: string; ceiling?: string }): boolean {
  return verdict.decision === 'allow' && (verdict.ceiling === undefined || verdict.ceiling === 'allow')
}

/**
 * What enrichment remembers between calls. Everything in it is valid for one
 * bundleDigest: a result carrying another digest clears it (schema or policy moved).
 */
export type EnrichCache = {
  generation: number
  bundleDigest?: string
  scopes?: string[]
  /** `scope\noperationType\nrootField` → SDL of the root field's signature. */
  roots: Map<string, string[]>
  /** `scope\ntype\ndepth` → SDL strings. */
  types: Map<string, string[]>
}

export const emptyCache = (): EnrichCache => ({ generation: 0, roots: new Map(), types: new Map() })

/** Schema and scope facts belong to the server that answered them. */
export function cacheForServer(caches: Map<string, EnrichCache>, server: string): EnrichCache {
  let cache = caches.get(server)
  if (cache === undefined) {
    cache = emptyCache()
    caches.set(server, cache)
  }
  return cache
}

class GenerationChanged extends Error {
  readonly checkCause = 'bundle-changed'
  constructor() {
    super('Agent Services bundle changed during analysis')
  }
}

class MissingCheckData extends Error {
  readonly checkCause = 'missing-data'
  readonly tool: GasTool
  constructor(message: string, tool: GasTool) { super(message); this.tool = tool }
}

function noteDigest(cache: EnrichCache, digest: string | undefined): void {
  if (digest === undefined || digest === cache.bundleDigest) return
  if (cache.bundleDigest !== undefined) {
    cache.scopes = undefined
    cache.roots.clear()
    cache.types.clear()
    cache.generation += 1
  }
  cache.bundleDigest = digest
}

async function read(call: CallGas, cache: EnrichCache, tool: GasTool, args: Record<string, unknown>) {
  const generation = cache.generation
  const digest = cache.bundleDigest
  let result: McpToolResult
  try { result = await call(tool, args) } catch (error) {
    // Preserve structured permission evidence. The short tool identifies the
    // boundary that failed, including search/introspect behind schema checks.
    if (error instanceof Error) { Object.assign(error, { tool }); throw error }
    throw Object.assign(new Error(String(error)), typeof error === 'object' && error !== null ? error : {}, { tool })
  }
  const payload = payloadOf(result)
  if (!payload.ok) throw Object.assign(new Error(`${tool}: ${payload.error}`), { tool })
  // An old request must neither roll the digest back nor repopulate a new cache.
  if (cache.generation !== generation) throw new GenerationChanged()
  // Initial discovery adopts a digest without advancing the generation. A
  // concurrent read that began before discovery must still fit that digest.
  if (cache.bundleDigest !== digest && payload.bundleDigest !== cache.bundleDigest) throw new GenerationChanged()
  noteDigest(cache, payload.bundleDigest)
  if (cache.generation !== generation) throw new GenerationChanged()
  return payload.value
}

export async function scopesOf(call: CallGas, cache: EnrichCache): Promise<string[]> {
  if (cache.scopes !== undefined) return cache.scopes
  const generation = cache.generation
  const value = await read(call, cache, 'search', { terms: [] })
  if (cache.generation !== generation) throw new GenerationChanged()
  const error = requestErrorOf(value)
  if (error !== undefined) throw Object.assign(new Error(error.issue), { checkCause: error.reason, tool: 'search' })
  if (!Array.isArray(value.scopes) || value.scopes.some(one => typeof one !== 'string')) throw new MissingCheckData('service discovery did not report a readable scope list', 'search')
  const scopes = value.scopes as string[]
  cache.scopes = scopes
  return scopes
}

/** The root field's signature: search finds `type Query { field(…): T }` with its description. */
async function rootSdl(call: CallGas, cache: EnrichCache, scope: string, field: string, opType: string): Promise<string[]> {
  const key = `${scope}\n${opType}\n${field}`
  const cached = cache.roots.get(key)
  if (cached !== undefined) return cached
  const generation = cache.generation
  const value = await read(call, cache, 'search', {
    terms: [field],
    scope,
    ...(opType === 'subscription' ? {} : { operationType: opType }),
  })
  if (cache.generation !== generation) throw new GenerationChanged()
  const error = requestErrorOf(value)
  if (error !== undefined) throw Object.assign(new Error(error.issue), { checkCause: error.reason, tool: 'search' })
  const results = Array.isArray(value.results) ? value.results : []
  const hit = results.find(
    (one): one is { operationName: string; types: unknown[] } =>
      typeof one === 'object' && one !== null && (one as { operationName?: unknown }).operationName === field,
  )
  if (hit === undefined || !Array.isArray(hit.types)) throw new MissingCheckData('schema definition for the requested root was not reported', 'search')
  const sdl = hit.types.filter((one): one is string => typeof one === 'string')
  if (sdl.length === 0) throw new MissingCheckData('schema definition for the requested root was not reported', 'search')
  cache.roots.set(key, sdl)
  return sdl
}

async function typeSdl(call: CallGas, cache: EnrichCache, scope: string, type: string, depth: number): Promise<string[]> {
  const key = `${scope}\n${type}\n${depth}`
  const cached = cache.types.get(key)
  if (cached !== undefined) return cached
  const generation = cache.generation
  const value = await read(call, cache, 'introspect', { scope, type, depth })
  const error = requestErrorOf(value)
  if (error !== undefined) throw Object.assign(new Error(error.issue), { checkCause: error.reason, tool: 'introspect' })
  const sdl = sdlOf(value)
  if (sdl.length === 0) throw new MissingCheckData('schema definitions for the requested type were not reported', 'introspect')
  if (cache.generation !== generation) throw new GenerationChanged()
  cache.types.set(key, sdl)
  return sdl
}

const ROOT_TYPE = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' } as const
type OpKind = keyof typeof ROOT_TYPE

/** Indexes the SDL of one scope's `roots` into `index`, which may already hold other scopes' types. */
async function schemaOf(call: CallGas, cache: EnrichCache, opType: OpKind, roots: readonly FieldIR[], scope: string, index: SchemaIndex): Promise<void> {
  await Promise.all(
    roots.map(async root => {
      const rootReport = { parsed: 0, failed: 0 }
      indexSdl(await rootSdl(call, cache, scope, root.name, opType), index, rootReport)
      if (rootReport.failed > 0) throw new MissingCheckData('some root schema definitions could not be read', 'search')
      const def = index.get(ROOT_TYPE[opType])?.get(root.name)
      if (def === undefined) throw new MissingCheckData('schema definition for the requested root could not be read', 'search')
      if (root.children.length === 0) return
      const typeReport = { parsed: 0, failed: 0 }
      indexSdl(await typeSdl(call, cache, scope, def.namedType, Math.max(1, depthOf(root.children) + 1)), index, typeReport)
      if (typeReport.failed > 0 || !typeKindsOf(index).has(def.namedType)) throw new MissingCheckData('schema definition for the requested type could not be read', 'introspect')
    }),
  )
}

const CHECKS = ['policy', 'validation', 'schema'] as const

/** What one scope's checks found. */
type ScopeResult = { validation?: Validation; access?: Access; checks: Checks }

const SEVERITY: CheckOutcome[] = ['ok', 'skipped', 'not-allowed', 'failed']
const worse = (a: CheckOutcome, b: CheckOutcome): CheckOutcome => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a)

/** Runs one scope's checks; only a bundle change escapes to the retry loop. */
async function checkScope(
  call: CallGas,
  cache: EnrichCache,
  opType: OpKind,
  scope: string,
  roots: readonly FieldIR[],
  operation: string | undefined,
  index: SchemaIndex,
): Promise<ScopeResult> {
  let checks: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
  const target = { kind: 'scope', scope, opType } as const
  /** A failure leaves its facts unknown and records why: not allowed by the user's rules, or an Agent Services error. */
  const settled = <T>(work: Promise<T>, which: readonly (typeof CHECKS)[number][]): Promise<T | undefined> =>
    work.then(value => {
      checks = appendCheckContext(checks, which.map(check => ({ check, target, source: 'enrichment', outcome: 'ok', ...(check === 'validation' ? { tool: 'validate' as const } : check === 'policy' ? { tool: 'dry_run' as const, operationDenied: (value as Access).denyOperation } : {}) })))
      return value
    }).catch((error: unknown) => {
      if (error instanceof GenerationChanged) throw error
      const context = which.map(check => checkFailureContext(check, target, error))
      checks = appendCheckContext(checks, context)
      const isNotAllowed = context[0]?.outcome === 'not-allowed'
      for (const key of which) checks[key] = isNotAllowed ? 'not-allowed' : 'failed'
      if (!isNotAllowed && checks.error === undefined) checks.error = String(error instanceof Error ? error.message : error).slice(0, 160)
      return undefined
    })
  // The schema is read from the root fields alone; only validate and dry_run need the operation.
  const schema = settled(schemaOf(call, cache, opType, roots, scope, index), ['schema'])
  if (operation === undefined) {
    // The sub-operation could not be built: this scope's roots stay unchecked.
    checks.policy = 'skipped'
    checks.validation = 'skipped'
    checks = appendCheckContext(checks, ['policy', 'validation'].map(check => ({ check: check as 'policy' | 'validation', target, source: 'enrichment', outcome: 'skipped', reason: 'operation-unavailable' })))
    await schema
    return { checks }
  }
  const [validation, access] = await Promise.all([
    settled(read(call, cache, 'validate', { scope, operation }).then((value): Validation => {
      const validation = validationOf(value)
      if (validation === undefined) throw new MissingCheckData(typeof value.valid === 'boolean' ? 'schema-validation diagnostics could not be read' : 'the response did not report a schema-validation result', 'validate')
      return validation
    }), ['validation']),
    settled(
      read(call, cache, 'dry_run', { requests: [{ scope, operation }] }).then((value): Access => {
        const results = Array.isArray(value.results) ? value.results : []
        const first: unknown = results[0]
        const evidence = { ...accessEvidenceOf(first), ...requestErrorOf(value) }
        if (evidence.access === undefined) throw Object.assign(new Error(evidence.issue ?? 'no readable answer for this request'), { tool: 'dry_run', checkCause: evidence.reason ?? 'missing-data' })
        if (evidence.issue !== undefined) {
          const error = Object.assign(new Error(evidence.issue), { tool: 'dry_run', checkCause: evidence.reason })
          checks = appendCheckContext(checks, [checkFailureContext('policy', target, error)])
          checks.policy = 'failed'
          checks.error ??= evidence.issue.slice(0, 160)
        }
        return evidence.access
      }),
      ['policy'],
    ),
    schema,
  ])
  // A readable access excerpt can still have missing decisions. It stays in
  // the IR, but the partial answer must not acquire an additional ok context.
  if (checks.policy === 'failed' && checks.context !== undefined) checks.context = checks.context.filter(one => !(one.check === 'policy' && one.outcome === 'ok' && one.operationDenied !== true))
  checks.context?.sort((a, b) => CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check))
  return { ...(validation !== undefined && { validation }), ...(access !== undefined && { access }), checks }
}

/**
 * Enriches `ir` (built from `operation`). Roots are grouped by service scope
 * and each scope is checked on its own, as a sub-operation of just its roots
 * (src/split.ts), all scopes in parallel; the answers merge back into the one
 * IR. A root no scope claims keeps its facts unknown. Resolves once every
 * source has answered or failed; bundle changes escape to the retry loop.
 */
async function enrichGeneration(call: CallGas, cache: EnrichCache, ir: CallIR, operation: string, variables: Record<string, unknown>): Promise<CallIR> {
  const generation = cache.generation
  if (ir.state === 'unparseable') return ir
  // Nothing to look up; never leave a call `analyzing`, or the pump retries it forever.
  if (ir.roots.length === 0 || ir.opType === undefined) return { ...ir, state: 'partial' }
  const opType = ir.opType

  let scopes: string[] | undefined
  let lookup: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
  try {
    scopes = await scopesOf(call, cache)
  } catch (error) {
    if (error instanceof GenerationChanged) throw error
    const context = CHECKS.map(check => checkFailureContext(check, { kind: 'call' }, error, 'enrichment', 'search'))
    lookup = appendCheckContext(lookup, context)
    const isNotAllowed = context[0]?.outcome === 'not-allowed'
    const outcome: CheckOutcome = isNotAllowed ? 'not-allowed' : 'failed'
    for (const key of CHECKS) lookup[key] = outcome
    if (!isNotAllowed) lookup.error = String(error instanceof Error ? error.message : error).slice(0, 160)
  }
  if (cache.generation !== generation) throw new GenerationChanged()
  const digest = cache.bundleDigest === undefined ? {} : { bundleDigest: cache.bundleDigest }
  if (scopes === undefined) return annotate(ir, { isIncomplete: true, checks: lookup, ...digest })

  const known = scopes
  const scopeOf = (root: FieldIR) => scopeFor(root.name, known)
  const groups = new Map<string, FieldIR[]>()
  for (const root of ir.roots) {
    const scope = scopeOf(root)
    if (scope !== undefined) groups.set(scope, [...(groups.get(scope) ?? []), root])
  }
  const hasUnclaimed = ir.roots.some(root => scopeOf(root) === undefined)
  // One scope claiming every root checks the operation as sent.
  const isWhole = groups.size === 1 && !hasUnclaimed
  const index: SchemaIndex = new Map()
  const results = await Promise.all(
    [...groups].map(async ([scope, roots]): Promise<ScopeResult> => {
      const names = new Set(roots.map(root => root.name))
      const sub = isWhole ? operation : subOperation(operation, variables, field => names.has(field))?.operation
      return checkScope(call, cache, opType, scope, roots, sub, index)
    }),
  )
  if (cache.generation !== generation) throw new GenerationChanged()

  let checks: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
  for (const result of results) {
    for (const key of CHECKS) checks[key] = worse(checks[key], result.checks[key])
    if (checks.error === undefined && result.checks.error !== undefined) checks.error = result.checks.error
    const context = normalizeCheckContext(result.checks)
    checks = appendCheckContext(checks, context.context)
    if (context.contextOmitted > 0) checks.contextOmitted = (checks.contextOmitted ?? 0) + context.contextOmitted
  }
  // A root no scope claims is not checked at all.
  if (hasUnclaimed) {
    for (const key of CHECKS) checks[key] = worse(checks[key], 'skipped')
    for (const root of ir.roots.filter(root => scopeOf(root) === undefined)) checks = appendCheckContext(checks, CHECKS.map(check => ({ check, target: { kind: 'root', path: root.path }, source: 'enrichment', outcome: 'skipped', reason: 'unclaimed-service' })))
  }

  // Valid only when every scope validated and none was left out; any invalid scope makes the call invalid.
  const validations = results.flatMap(result => (result.validation === undefined ? [] : [result.validation]))
  const validation: Validation | undefined = validations.some(one => !one.valid)
    ? { valid: false, diagnostics: validations.flatMap(one => one.diagnostics) }
    : validations.length === results.length && !hasUnclaimed
      ? { valid: true, diagnostics: [] }
      : undefined
  const accesses = results.flatMap(result => (result.access === undefined ? [] : [result.access]))
  const access: Access | undefined =
    accesses.length === 0
      ? undefined
      : { denyOperation: accesses.some(one => one.denyOperation), fields: new Map(accesses.flatMap(one => [...one.fields])) }
  // Each service once in the order its first root appears; an unclaimed root by its name prefix.
  const services = unique(ir.roots.flatMap(root => scopeOf(root) ?? provisionalService(root.name) ?? []))
  const first = ir.roots[0]
  const firstScope = first === undefined ? undefined : scopeOf(first)

  const found: Enrichment = {
    isIncomplete: CHECKS.some(key => checks[key] !== 'ok'),
    checks,
    services,
    rootScopes: new Map(ir.roots.flatMap(root => {
      const scope = scopeOf(root)
      return scope === undefined ? [] : [[root.path, scope] as const]
    })),
    ...(firstScope !== undefined && { scope: firstScope }),
    ...digest,
    ...(validation !== undefined && { validation }),
    ...(access !== undefined && { access }),
    ...(index.size > 0 && { schema: index }),
  }
  return annotate(ir, found)
}

/** Retry a moving bundle once; never present facts combined across generations. */
export async function enrich(call: CallGas, cache: EnrichCache, ir: CallIR, operation: string, variables: Record<string, unknown> = {}): Promise<CallIR> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await enrichGeneration(call, cache, ir, operation, variables)
    } catch (error) {
      if (!(error instanceof GenerationChanged)) throw error
    }
  }
  return annotate(ir, {
    isIncomplete: true,
    checks: appendCheckContext({ policy: 'failed', validation: 'failed', schema: 'failed', error: 'Agent Services bundle changed during analysis' }, CHECKS.map(check => ({ check, target: { kind: 'call' }, source: 'enrichment', outcome: 'failed', reason: 'bundle-changed' }))),
  })
}

/** What a lookup's own answer already said: its validation or its policy, and how those checks went. */
export type OwnChecks = { validation?: Validation; access?: Access; checks: Checks }

/**
 * Fills in the schema for the operation a validate or dry_run call sent: its
 * root fields' descriptions and types, by the same cached search and
 * introspect reads an execute's analysis makes. Never validate or dry_run:
 * the call's own answer (`own`) is the check, kept as it was. Each root names
 * its service already (the call did), so no catalog is read.
 */
async function schemaGeneration(call: CallGas, cache: EnrichCache, ir: CallIR, own: OwnChecks): Promise<CallIR> {
  const generation = cache.generation
  if (ir.state === 'unparseable' || ir.opType === undefined || ir.roots.length === 0) return ir
  const opType = ir.opType
  const groups = new Map<string, { scope: string; opType: OpKind; roots: FieldIR[] }>()
  for (const root of ir.roots) {
    if (root.service === undefined || root.service === '') continue
    // A dry_run can mix reads and writes, including the same field name on
    // Query and Mutation. The batch's badge is not each request's schema kind.
    const kind = root.request?.opType ?? opType
    const key = `${root.service}\n${kind}`
    const group = groups.get(key) ?? { scope: root.service, opType: kind, roots: [] }
    group.roots.push(root)
    groups.set(key, group)
  }
  const index: SchemaIndex = new Map()
  let schema: CheckOutcome = groups.size === 0 ? 'skipped' : 'ok'
  let error: string | undefined
  const schemaContexts = await Promise.all(
    [...groups.values()].map(async ({ scope, opType, roots }): Promise<CheckContext> => {
      const target = { kind: 'scope', scope, opType } as const
      try {
        await schemaOf(call, cache, opType, roots, scope, index)
        return { check: 'schema', target, source: 'enrichment', outcome: 'ok' }
      } catch (failure: unknown) {
        if (failure instanceof GenerationChanged) throw failure
        const context = checkFailureContext('schema', target, failure)
        const isNotAllowed = context.outcome === 'not-allowed'
        schema = worse(schema, isNotAllowed ? 'not-allowed' : 'failed')
        if (!isNotAllowed) error ??= String(failure instanceof Error ? failure.message : failure).slice(0, 160)
        return context
      }
    }),
  )
  if (cache.generation !== generation) throw new GenerationChanged()
  const checks = appendCheckContext({ ...own.checks, schema, ...(error !== undefined && own.checks.error === undefined && { error }) }, schemaContexts.length > 0 ? schemaContexts : [{ check: 'schema', target: { kind: 'call' }, source: 'enrichment', outcome: 'skipped', reason: 'unclaimed-service' }])
  return annotate(ir, {
    isIncomplete: schema !== 'ok' || ir.state === 'partial' || own.checks.policy === 'failed' || own.checks.policy === 'not-allowed' || own.checks.validation === 'failed' || own.checks.validation === 'not-allowed',
    checks,
    rootScopes: new Map(ir.roots.flatMap(root => (root.service === undefined ? [] : [[root.path, root.service] as const]))),
    ...(ir.services !== undefined && { services: ir.services }),
    ...(ir.service !== undefined && { scope: ir.service }),
    ...(cache.bundleDigest !== undefined && { bundleDigest: cache.bundleDigest }),
    ...(own.validation !== undefined && { validation: own.validation }),
    ...(own.access !== undefined && { access: own.access }),
    ...(index.size > 0 && { schema: index }),
  })
}

/** The schema for a lookup's operation, retried once across a bundle change; the call's own answer stands either way. */
export async function enrichSchema(call: CallGas, cache: EnrichCache, ir: CallIR, own: OwnChecks): Promise<CallIR> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await schemaGeneration(call, cache, ir, own)
    } catch (error) {
      if (!(error instanceof GenerationChanged)) throw error
    }
  }
  return annotate(ir, {
    ...own,
    isIncomplete: true,
    checks: appendCheckContext({ ...own.checks, schema: 'failed' }, [{ check: 'schema', target: { kind: 'call' }, source: 'enrichment', outcome: 'failed', reason: 'bundle-changed' }]),
  })
}
