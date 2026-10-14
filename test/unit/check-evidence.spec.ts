import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'
import { normalizeCheckContext, appendCheckContext, checkFailureContext, CHECK_CONTEXT_MAX } from '../../src/checks.ts'
import { accessEvidenceOf, accessOf, validationOf } from '../../src/gas.ts'
import { buildIR } from '../../src/build.ts'
import { enrich, enrichSchema, emptyCache } from '../../src/enrich.ts'
import type { CallGas } from '../../src/enrich.ts'
import type { CheckContext, Checks } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { adaptLookup, settledLookup, accessFromIR } from '../../src/lookup.ts'

const answer = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false })
const aggregate: Checks = { policy: 'ok', validation: 'ok', schema: 'ok' }
const context: CheckContext = { check: 'policy', source: 'enrichment', target: { kind: 'scope', scope: 'jira' }, tool: 'dry_run', outcome: 'ok' }

// Normalizing retained evidence is idempotent: interpretation cannot add new
// facts when the same session data is loaded more than once.
test('retained context normalization is idempotent and bounded for arbitrary session data', () => {
  fc.assert(fc.property(fc.jsonValue(), raw => {
    const once = normalizeCheckContext(raw)
    assert.deepEqual(normalizeCheckContext(once), once)
    assert.ok(once.context.length <= CHECK_CONTEXT_MAX)
    assert.ok(Number.isSafeInteger(once.contextOmitted) && once.contextOmitted >= 0)
    for (const one of once.context) if (one.outcome === 'failed') assert.ok((one.message?.length ?? 0) <= 300)
  }))
})

test('valid context round trips preserve every identity and diagnostic within the retained bounds', () => {
  const target = fc.oneof(
    fc.constant({ kind: 'call' as const }),
    fc.string({ minLength: 1, maxLength: 128 }).map(scope => ({ kind: 'scope' as const, scope })),
    fc.tuple(fc.string({ minLength: 1, maxLength: 128 }), fc.nat(19)).map(([scope, index]) => ({ kind: 'request' as const, scope, index })),
    fc.string({ minLength: 1, maxLength: 256 }).map(path => ({ kind: 'root' as const, path })),
  )
  const base = fc.record({
    check: fc.constantFrom('schema' as const, 'validation' as const, 'policy' as const),
    source: fc.constantFrom('enrichment' as const, 'tool-response' as const),
    target,
  })
  const outcome = fc.oneof(
    fc.boolean().map(operationDenied => ({ outcome: 'ok' as const, operationDenied })),
    fc.tuple(fc.constantFrom('allow' as const, 'ask' as const, 'deny' as const), fc.option(fc.constantFrom('allow' as const, 'ask' as const, 'deny' as const), { nil: undefined })).map(([decision, ceiling]) => ({ outcome: 'not-allowed' as const, decision, ...(ceiling === undefined ? {} : { ceiling }) })),
    fc.record({ outcome: fc.constant('failed' as const), reason: fc.constantFrom('missing-data' as const, 'request-failed' as const, 'analysis-timeout' as const, 'bundle-changed' as const), message: fc.oneof(fc.string({ maxLength: 300 }), fc.string({ minLength: 301, maxLength: 400 })) }),
    fc.constantFrom('unclaimed-service' as const, 'operation-unavailable' as const, 'not-applicable' as const).map(reason => ({ outcome: 'skipped' as const, reason })),
  )
  const entry = fc.tuple(base, outcome).map(([base, outcome]) => ({ ...base, ...outcome }))
  const entries = fc.oneof(fc.array(entry, { maxLength: 128 }), fc.array(entry, { minLength: 129, maxLength: 140 }))
  fc.assert(fc.property(entries, entries => {
    const kept = normalizeCheckContext({ context: entries })
    assert.deepEqual(kept.context, entries.slice(0, CHECK_CONTEXT_MAX).map(one => one.outcome === 'failed' ? { ...one, message: one.message.slice(0, 300) } : one))
    assert.equal(kept.contextOmitted, Math.max(0, entries.length - CHECK_CONTEXT_MAX))
    assert.deepEqual(normalizeCheckContext(kept), kept)
  }))
})

test('context caps preserve exact identities and count dropped evidence', () => {
  const oversized = { ...context, target: { kind: 'scope', scope: 'j'.repeat(129) } }
  const entries = [oversized, ...Array.from({ length: 130 }, () => context)]
  const bounded = appendCheckContext(aggregate, entries as CheckContext[])
  assert.equal(bounded.context?.length, 128)
  assert.equal(bounded.contextOmitted, 3)
  assert.ok(bounded.context?.every(one => one.target.kind === 'scope' && one.target.scope === 'jira'))
  assert.deepEqual(normalizeCheckContext({ ...aggregate, context: [{ ...context, target: { kind: 'root', path: 'x'.repeat(257) } }] }), { context: [], contextOmitted: 1 })
  assert.deepEqual(normalizeCheckContext(aggregate), { context: [], contextOmitted: 0 })
})

test('permission context uses the actual decision and organization ceiling, never words', () => {
  const blocked = Object.assign(new Error('not allowed'), { checkCause: 'not-allowed', tool: 'introspect', decision: 'allow', ceiling: 'deny' })
  const kept = checkFailureContext('schema', { kind: 'scope', scope: 'jira' }, blocked)
  assert.deepEqual(kept, { check: 'schema', source: 'enrichment', target: { kind: 'scope', scope: 'jira' }, tool: 'introspect', outcome: 'not-allowed', decision: 'allow', ceiling: 'deny' })
  const prose = checkFailureContext('schema', { kind: 'call' }, new Error('permission denied: must ask'))
  assert.equal(prose.outcome, 'failed')
})

test('schema validation requires an actual boolean; partial access preserves valid decisions', () => {
  assert.equal(validationOf({ valid: 'false' }), undefined)
  const evidence = accessEvidenceOf({ fields: [{ path: 'jira_read', decision: 'allow' }, { path: 'jira_read.bad', decision: 'shrug' }] })
  assert.equal(evidence.reason, 'missing-data')
  assert.equal(evidence.access?.fields.get('jira_read')?.decision, 'allow')
  assert.equal(evidence.access?.fields.has('jira_read.bad'), false)
  assert.equal(accessEvidenceOf({ denyOperation: false, fields: [] }).reason, 'missing-data')
  assert.equal(accessEvidenceOf({ denyOperation: true, fields: [] }).issue, undefined)
})

test('malformed error containers cannot establish clean checks, exact zero matches, or type absence', () => {
  for (const errors of ['backend unavailable', { message: 'backend unavailable' }, null, 1]) {
    const evidence = accessEvidenceOf({ denyOperation: false, fields: [{ path: 'jira_read', decision: 'allow' }], errors })
    assert.equal(evidence.reason, 'missing-data')
    assert.equal(evidence.access?.fields.get('jira_read')?.decision, 'allow')
    assert.equal(validationOf({ valid: true, errors }), undefined)
    const validation = settledLookup('v', 'validate', adaptLookup('validate', { scope: 'jira', operation: '{ jira_read }' }), { valid: true, errors }, 100)
    assert.equal(validation.ir.validation, undefined)
    assert.equal(validation.ir.checks?.validation, 'failed')
    const dryRun = settledLookup('d', 'dry_run', adaptLookup('dry_run', { requests: [{ scope: 'jira', operation: '{ jira_read }' }] }), { results: [{ denyOperation: false, fields: [{ path: 'jira_read', decision: 'allow' }] }], errors }, 100)
    assert.equal(dryRun.ir.checks?.policy, 'failed')
    assert.equal(dryRun.ir.state, 'partial')
    assert.equal(dryRun.ir.roots[0].policy, 'allow')
    const search = settledLookup('s', 'search', adaptLookup('search', { terms: ['read'] }), { results: [], errors }, 100)
    assert.deepEqual(search.found.counts?.hits, { kind: 'unknown' })
    assert.notEqual(search.found.completeness, 'complete')
    const catalog = settledLookup('c', 'search', adaptLookup('search', { terms: [] }), { results: [], scopes: [], errors }, 100)
    assert.deepEqual(catalog.found.counts?.scopes, { kind: 'unknown' })
    const introspection = settledLookup('i', 'introspect', adaptLookup('introspect', { scope: 'jira', type: 'Jira_Item' }), { types: [], errors }, 100)
    assert.equal(introspection.found.typeKind, 'unavailable')
  }
})

test('conflicting path decisions remain unknown regardless of order or repeated later claims', () => {
  const decisions = fc.array(fc.record({ path: fc.constantFrom('a', 'b', 'c'), decision: fc.constantFrom('allow' as const, 'mask' as const, 'deny' as const) }), { minLength: 1, maxLength: 20 })
  fc.assert(fc.property(decisions, fields => {
    // Independent oracle: a path has a known decision only when all of its
    // reported decisions agree. Reordering peer claims cannot create authority.
    const choices = new Map<string, Set<string>>()
    for (const field of fields) {
      const set = choices.get(field.path) ?? new Set<string>()
      set.add(field.decision); choices.set(field.path, set)
    }
    const expected = [...choices].flatMap(([path, choices]) => choices.size === 1 ? [[path, [...choices][0]]] : []).sort()
    for (const entries of [fields, [...fields].reverse()]) {
      const result = { denyOperation: false, fields: entries }
      const access = accessOf(result)
      assert.deepEqual([...access!.fields].map(([path, field]) => [path, field.decision]).sort(), expected)
      assert.equal(accessEvidenceOf(result).issue !== undefined, [...choices.values()].some(set => set.size > 1))
    }
  }))
})

const OP = 'query Two { jira_read slack_read }'
function gas(policy: (scope: string) => unknown = scope => ({ denyOperation: false, fields: [{ path: `${scope}_read`, decision: 'allow' }] })): CallGas {
  return async (tool, args) => {
    if (tool === 'search' && (args.terms as string[]).length === 0) return answer({ scopes: ['jira', 'slack'] })
    if (tool === 'search') return answer({ results: [{ operationName: `${args.scope}_read`, types: [`type Query { ${args.scope}_read: String }`] }] })
    if (tool === 'validate') return answer({ valid: true })
    if (tool === 'dry_run') return answer({ results: [policy((args.requests as { scope: string }[])[0].scope)] })
    throw new Error('unexpected introspection')
  }
}
const initial = () => buildIR('t', normalize(OP, {}))

test('both explicit dry runs and enrichment expose conflicting paths as unknown', async () => {
  const conflicting = { denyOperation: false, fields: [{ path: 'jira_read', decision: 'deny' }, { path: 'jira_read', decision: 'allow' }, { path: 'jira_read', decision: 'allow' }] }
  const explicit = settledLookup('d', 'dry_run', adaptLookup('dry_run', { requests: [{ scope: 'jira', operation: '{ jira_read }' }] }), { results: [conflicting] }, 100)
  assert.equal(explicit.ir.roots[0].policy, 'unknown')
  assert.equal(explicit.ir.checks?.policy, 'failed')
  const ir = await enrich(gas(scope => scope === 'jira' ? conflicting : { denyOperation: false, fields: [{ path: 'slack_read', decision: 'allow' }] }), emptyCache(), initial(), OP)
  assert.equal(ir.roots[0].policy, 'unknown')
  assert.equal(ir.roots[1].policy, 'allow')
  assert.equal(ir.checks?.policy, 'failed')
})

test('malformed validation diagnostics and envelope errors do not become clean enrichment checks', async () => {
  const fixture = gas()
  const ir = await enrich(async (tool, args) => {
    if (tool === 'validate') return answer({ valid: true, errors: 'backend unavailable' })
    if (tool === 'dry_run') return answer({ results: [{ denyOperation: false, fields: [{ path: 'jira_read', decision: 'allow' }, { path: 'slack_read', decision: 'allow' }] }], errors: { message: 'backend unavailable' } })
    return fixture(tool, args)
  }, emptyCache(), initial(), OP)
  assert.equal(ir.validation, undefined)
  assert.equal(ir.checks?.validation, 'failed')
  assert.equal(ir.checks?.policy, 'failed')
  assert.equal(ir.state, 'partial')
  assert.equal(ir.roots[0].policy, 'allow')
})

test('split-operation refusal retains its scope alongside another scope allowed', async () => {
  const ir = await enrich(gas(scope => ({ denyOperation: scope === 'jira', fields: [{ path: `${scope}_read`, decision: scope === 'jira' ? 'deny' : 'allow' }] })), emptyCache(), initial(), OP)
  assert.equal(ir.isOperationDenied, true) // Conservative aggregate guard remains.
  const policy = ir.checks?.context?.filter(one => one.check === 'policy') ?? []
  assert.equal(policy.length, 2)
  assert.ok(policy.some(one => one.target.kind === 'scope' && one.target.scope === 'jira' && one.outcome === 'ok' && one.operationDenied === true))
  assert.ok(policy.some(one => one.target.kind === 'scope' && one.target.scope === 'slack' && one.outcome === 'ok' && one.operationDenied === false))
})

test('missing policy and validation evidence never invents an invalid operation', async () => {
  const fixture = gas(() => ({ fields: [{ path: 'jira_read', decision: 'allow' }] }))
  const ir = await enrich(async (tool, args) => tool === 'validate' ? answer({}) : fixture(tool, args), emptyCache(), initial(), OP)
  assert.equal(ir.state, 'partial')
  assert.equal(ir.validation, undefined)
  assert.equal(ir.checks?.validation, 'failed')
  assert.equal(ir.roots[0].policy, 'allow')
  assert.ok(ir.checks?.context?.some(one => one.check === 'validation' && one.outcome === 'failed' && one.reason === 'missing-data'))
  assert.ok(ir.checks?.context?.some(one => one.check === 'policy' && one.outcome === 'failed' && one.reason === 'missing-data'))
})

test('blocked discovery records search and actual ask before any policy request', async () => {
  const seen: string[] = []
  const ir = await enrich(async tool => {
    seen.push(tool)
    throw Object.assign(new Error('needs a prompt'), { checkCause: 'not-allowed', decision: 'ask' })
  }, emptyCache(), initial(), OP)
  assert.deepEqual(seen, ['search'])
  assert.equal(ir.checks?.policy, 'not-allowed')
  assert.deepEqual(ir.checks?.context?.map(one => one.check).sort(), ['policy', 'schema', 'validation'])
  assert.ok(ir.checks?.context?.every(one => one.outcome === 'not-allowed' && one.decision === 'ask' && one.tool === 'search'))
})

test('malformed discovery is unavailable, while an affirmed empty catalog means unclaimed roots', async () => {
  const malformedCache = emptyCache()
  const malformed = await enrich(async () => answer({}), malformedCache, initial(), OP)
  assert.equal(malformedCache.scopes, undefined)
  assert.deepEqual(malformed.checks?.context?.map(one => one.check).sort(), ['policy', 'schema', 'validation'])
  assert.ok(malformed.checks?.context?.every(one => one.outcome === 'failed' && one.reason === 'missing-data' && one.tool === 'search'))
  const empty = await enrich(async () => answer({ scopes: [] }), emptyCache(), initial(), OP)
  assert.deepEqual(empty.checks?.context?.map(one => [one.target.kind === 'root' ? one.target.path : undefined, one.check]).sort(),
    ['jira_read', 'slack_read'].flatMap(path => ['policy', 'schema', 'validation'].map(check => [path, check])).sort(),
    'each unclaimed root retains the reason for every unavailable check')
  assert.ok(empty.checks?.context?.every(one => one.outcome === 'skipped' && one.reason === 'unclaimed-service'))
  for (const errors of ['backend unavailable', { message: 'backend unavailable' }, ['backend unavailable']]) {
    const cache = emptyCache()
    const result = await enrich(async () => answer({ scopes: [], errors }), cache, initial(), OP)
    assert.equal(cache.scopes, undefined)
    assert.deepEqual(result.checks?.context?.map(one => one.check).sort(), ['policy', 'schema', 'validation'])
    assert.ok(result.checks?.context?.every(one => one.outcome === 'failed' && one.reason === (Array.isArray(errors) ? 'request-failed' : 'missing-data')))
  }
})

test('missing schema definitions never become a complete schema check', async () => {
  const fixture = gas()
  for (const data of [{}, { results: [] }, { results: [{ operationName: 'jira_read', types: [] }] }, { results: [{ operationName: 'jira_read', types: ['type Query { another: String }'] }] }]) {
    const ir = await enrich(async (tool, args) => tool === 'search' && (args.terms as string[]).length > 0 ? answer(data) : fixture(tool, args), emptyCache(), initial(), OP)
    assert.equal(ir.checks?.schema, 'failed')
    assert.ok(ir.checks?.context?.some(one => one.check === 'schema' && one.outcome === 'failed' && one.reason === 'missing-data'))
  }
})

test('empty type introspection is missing evidence, not a completed schema check', async () => {
  const operation = '{ jira_read { value } }'
  for (const types of [[], ['type Another { value: String }'], ['type Jira_Item { value: String }', 'malformed']]) {
    const ir = await enrich(async (tool, args) => {
    if (tool === 'search') return answer((args.terms as string[]).length === 0 ? { scopes: ['jira'] } : { results: [{ operationName: 'jira_read', types: ['type Query { jira_read: Jira_Item }'] }] })
    if (tool === 'introspect') return answer({ types })
    if (tool === 'validate') return answer({ valid: true })
    return answer({ results: [{ denyOperation: false, fields: [{ path: 'jira_read.value', decision: 'allow' }] }] })
  }, emptyCache(), buildIR('t', normalize(operation, {})), operation)
  assert.equal(ir.checks?.schema, 'failed')
  assert.ok(ir.checks?.context?.some(one => one.check === 'schema' && one.outcome === 'failed' && one.reason === 'missing-data' && one.tool === 'introspect'))
  assert.equal(ir.roots[0].children[0].policy, 'allow')
  }
})

test('explicit request checks survive schema failure with their request identity', async () => {
  const input = adaptLookup('dry_run', { requests: [{ scope: 'jira', operation: '{ jira_read }' }, { scope: 'slack', operation: '{ slack_read }' }] })
  const { ir } = settledLookup('t', 'dry_run', input, { results: [{ denyOperation: true, fields: [] }, { denyOperation: false, fields: [{ path: 'slack_read', decision: 'allow' }] }] }, 100)
  assert.equal(ir.checks?.context?.filter(one => one.source === 'tool-response').length, 2)
  const done = await enrichSchema(async () => { throw Object.assign(new Error('schema wait expired'), { checkCause: 'analysis-timeout' }) }, emptyCache(), ir, { checks: ir.checks!, access: accessFromIR(ir) })
  assert.deepEqual(done.checks?.context?.filter(one => one.source === 'tool-response'), ir.checks?.context)
  assert.ok(done.checks?.context?.some(one => one.check === 'schema' && one.outcome === 'failed' && one.reason === 'analysis-timeout'))
  assert.equal(done.roots.find(root => root.service === 'slack')?.policy, 'allow')
  assert.equal(done.isOperationDenied, true)
})

test('a successful schema pass cannot erase missing explicit access evidence', async () => {
  const input = adaptLookup('dry_run', { requests: [{ scope: 'jira', operation: '{ jira_read }' }] })
  const { ir } = settledLookup('t', 'dry_run', input, { results: [{ fields: [{ path: 'jira_read', decision: 'allow' }] }] }, 100)
  const done = await enrichSchema(gas(), emptyCache(), ir, { checks: ir.checks!, access: accessFromIR(ir) })
  assert.equal(done.state, 'partial')
  assert.equal(done.checks?.policy, 'failed')
  assert.equal(done.checks?.schema, 'ok')
  assert.equal(done.roots[0].policy, 'allow')
  assert.deepEqual(done.checks?.context?.filter(one => one.source === 'tool-response'), ir.checks?.context)
})
