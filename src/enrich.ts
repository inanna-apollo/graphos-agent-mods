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
import { accessOf, payloadOf, scopeFor, sdlOf, validationOf } from './gas.ts'
import type { Access, Validation } from './gas.ts'
import type { CallIR, CheckOutcome, Checks, FieldIR } from './ir.ts'
import { indexSdl } from './schema.ts'
import type { SchemaIndex } from './schema.ts'
import { subOperation, unique } from './split.ts'

export type GasTool = 'search' | 'introspect' | 'validate' | 'dry_run'
export type CallGas = (tool: GasTool, args: Record<string, unknown>) => Promise<McpToolResult>

/**
 * What enrichment remembers between calls. Everything in it is valid for one
 * bundleDigest: a result carrying another digest clears it (schema or policy moved).
 */
export type EnrichCache = {
  bundleDigest?: string
  scopes?: string[]
  /** `scope\nrootField` → SDL of the root field's `type Query { … }` snippet. */
  roots: Map<string, string[]>
  /** `scope\ntype\ndepth` → SDL strings. */
  types: Map<string, string[]>
}

export const emptyCache = (): EnrichCache => ({ roots: new Map(), types: new Map() })

function noteDigest(cache: EnrichCache, digest: string | undefined): void {
  if (digest === undefined || digest === cache.bundleDigest) return
  if (cache.bundleDigest !== undefined) {
    cache.scopes = undefined
    cache.roots.clear()
    cache.types.clear()
  }
  cache.bundleDigest = digest
}

async function read(call: CallGas, cache: EnrichCache, tool: GasTool, args: Record<string, unknown>) {
  const payload = payloadOf(await call(tool, args))
  if (!payload.ok) throw new Error(`${tool}: ${payload.error}`)
  noteDigest(cache, payload.bundleDigest)
  return payload.value
}

export async function scopesOf(call: CallGas, cache: EnrichCache): Promise<string[]> {
  if (cache.scopes !== undefined) return cache.scopes
  const value = await read(call, cache, 'search', { terms: [] })
  const scopes = Array.isArray(value.scopes) ? value.scopes.filter((one): one is string => typeof one === 'string') : []
  cache.scopes = scopes
  return scopes
}

/** The root field's signature: search finds `type Query { field(…): T }` with its description. */
async function rootSdl(call: CallGas, cache: EnrichCache, scope: string, field: string, opType: string): Promise<string[]> {
  const key = `${scope}\n${field}`
  const cached = cache.roots.get(key)
  if (cached !== undefined) return cached
  const value = await read(call, cache, 'search', {
    terms: [field],
    scope,
    ...(opType === 'subscription' ? {} : { operationType: opType }),
  })
  const results = Array.isArray(value.results) ? value.results : []
  const hit = results.find(
    (one): one is { operationName: string; types: unknown[] } =>
      typeof one === 'object' && one !== null && (one as { operationName?: unknown }).operationName === field,
  )
  const sdl = hit === undefined ? [] : hit.types.filter((one): one is string => typeof one === 'string')
  cache.roots.set(key, sdl)
  return sdl
}

async function typeSdl(call: CallGas, cache: EnrichCache, scope: string, type: string, depth: number): Promise<string[]> {
  const key = `${scope}\n${type}\n${depth}`
  const cached = cache.types.get(key)
  if (cached !== undefined) return cached
  const sdl = sdlOf(await read(call, cache, 'introspect', { scope, type, depth }))
  cache.types.set(key, sdl)
  return sdl
}

const ROOT_TYPE = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' } as const
type OpKind = keyof typeof ROOT_TYPE

/** Indexes the SDL of one scope's `roots` into `index`, which may already hold other scopes' types. */
async function schemaOf(call: CallGas, cache: EnrichCache, opType: OpKind, roots: readonly FieldIR[], scope: string, index: SchemaIndex): Promise<void> {
  await Promise.all(
    roots.map(async root => {
      indexSdl(await rootSdl(call, cache, scope, root.name, opType), index)
      const def = index.get(ROOT_TYPE[opType])?.get(root.name)
      if (def === undefined || root.children.length === 0) return
      indexSdl(await typeSdl(call, cache, scope, def.namedType, Math.max(1, depthOf(root.children) + 1)), index)
    }),
  )
}

const CHECKS = ['policy', 'validation', 'schema'] as const

/** What one scope's checks found. */
type ScopeResult = { validation?: Validation; access?: Access; isSchemaRead: boolean; checks: Checks }

const SEVERITY: CheckOutcome[] = ['ok', 'skipped', 'not-allowed', 'failed']
const worse = (a: CheckOutcome, b: CheckOutcome): CheckOutcome => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a)

/** Runs validate, dry_run and the schema lookups for the roots of one scope; never rejects. */
async function checkScope(
  call: CallGas,
  cache: EnrichCache,
  opType: OpKind,
  scope: string,
  roots: readonly FieldIR[],
  operation: string | undefined,
  index: SchemaIndex,
): Promise<ScopeResult> {
  const checks: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
  /** A failure leaves its facts unknown and records why: not allowed by the user's rules, or an Agent Services error. */
  const settled = <T>(work: Promise<T>, which: readonly (typeof CHECKS)[number][]): Promise<T | undefined> =>
    work.catch((error: unknown) => {
      const isNotAllowed = typeof error === 'object' && error !== null && 'decision' in error
      for (const key of which) checks[key] = isNotAllowed ? 'not-allowed' : 'failed'
      if (!isNotAllowed && checks.error === undefined) checks.error = String(error instanceof Error ? error.message : error).slice(0, 160)
      return undefined
    })
  // The schema is read from the root fields alone; only validate and dry_run need the operation.
  const schema = settled(schemaOf(call, cache, opType, roots, scope, index).then(() => true), ['schema'])
  if (operation === undefined) {
    // The sub-operation could not be built: this scope's roots stay unchecked.
    checks.policy = 'skipped'
    checks.validation = 'skipped'
    return { isSchemaRead: (await schema) === true, checks }
  }
  const [validation, access, isSchemaRead] = await Promise.all([
    settled(read(call, cache, 'validate', { scope, operation }).then((value): Validation => validationOf(value)), ['validation']),
    settled(
      read(call, cache, 'dry_run', { requests: [{ scope, operation }] }).then((value): Access => {
        const results = Array.isArray(value.results) ? value.results : []
        const first: unknown = results[0]
        // Agent Services reports a per-request failure as `{ errors: [string] }` (e.g. `Unknown scope "glean"`).
        const errors = typeof first === 'object' && first !== null && Array.isArray((first as { errors?: unknown }).errors) ? (first as { errors: unknown[] }).errors : []
        if (typeof errors[0] === 'string') throw new Error(`dry_run: ${errors[0]}`)
        const found = accessOf(first)
        if (found === undefined) throw new Error('dry_run: no result')
        return found
      }),
      ['policy'],
    ),
    schema,
  ])
  return { ...(validation !== undefined && { validation }), ...(access !== undefined && { access }), isSchemaRead: isSchemaRead === true, checks }
}

/**
 * Enriches `ir` (built from `operation`). Roots are grouped by service scope
 * and each scope is checked on its own, as a sub-operation of just its roots
 * (src/split.ts), all scopes in parallel; the answers merge back into the one
 * IR. A root no scope claims keeps its facts unknown. Resolves once every
 * source has answered or failed; never rejects.
 */
export async function enrich(call: CallGas, cache: EnrichCache, ir: CallIR, operation: string, variables: Record<string, unknown> = {}): Promise<CallIR> {
  if (ir.state === 'unparseable') return ir
  // Nothing to look up; never leave a call `analyzing`, or the pump retries it forever.
  if (ir.roots.length === 0 || ir.opType === undefined) return { ...ir, state: 'partial' }
  const opType = ir.opType

  let scopes: string[] | undefined
  const lookup: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
  try {
    scopes = await scopesOf(call, cache)
  } catch (error) {
    const isNotAllowed = typeof error === 'object' && error !== null && 'decision' in error
    const outcome: CheckOutcome = isNotAllowed ? 'not-allowed' : 'failed'
    for (const key of CHECKS) lookup[key] = outcome
    if (!isNotAllowed) lookup.error = String(error instanceof Error ? error.message : error).slice(0, 160)
  }
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

  const checks: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
  for (const result of results) {
    for (const key of CHECKS) checks[key] = worse(checks[key], result.checks[key])
    if (checks.error === undefined && result.checks.error !== undefined) checks.error = result.checks.error
  }
  // A root no scope claims is not checked at all.
  if (hasUnclaimed) for (const key of CHECKS) checks[key] = worse(checks[key], 'skipped')

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
    ...(results.some(result => result.isSchemaRead) && { schema: index }),
  }
  return annotate(ir, found)
}
