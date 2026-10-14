// Claude's search, introspect, validate and dry_run calls read into IRs
// (src/lookup.ts): what each keeps, and that a hostile or huge answer stays
// bounded and inert.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HITS_MAX, LOOKUP_TOOLS, accessFromIR, adaptLookup, lookupToolOf, pendingIR, settledLookup } from '../../src/lookup.ts'
import type { FieldIR } from '../../src/ir.ts'
import { EMPTY, arrive, isFinal, settle, shown } from '../../src/queue.ts'
import type { InspectedCall } from '../../types/index.d.ts'

const walk = (fields: readonly FieldIR[]): FieldIR[] => fields.flatMap(field => [field, ...walk(field.children)])

const QUERY = (name: string, extra = '') => `type Query {\n  """Find ${name}."""\n  ${name}(query: String!, limit: Int = 10, filter: Acme_Filter${extra}): Acme_Page\n}\n`
const TYPES = ['type Acme_Page {\n  items: [Acme_Item]\n  next: String\n}\n', 'type Acme_Item {\n  """The title."""\n  title: String\n  owner: Acme_Item\n}\n', 'input Acme_Filter {\n  kind: Acme_Kind = A\n  tags: [String!]\n}\n', 'enum Acme_Kind {\n  A\n  B\n}\n']
const hit = (name: string, extra = '', opType = 'query') => ({ operationName: name, operationType: opType, scope: 'acme', score: 0.1, types: [QUERY(name, extra), ...TYPES] })

test('the tools besides execute are the lookups, by their own names', () => {
  assert.deepEqual([...LOOKUP_TOOLS], ['search', 'introspect', 'validate', 'dry_run'])
  assert.equal(lookupToolOf('search'), 'search')
  assert.equal(lookupToolOf('execute'), undefined)
  assert.equal(lookupToolOf('constructor'), undefined)
})

test("a search's input keeps its terms, scope and operation type, bounded", () => {
  const adapted = adaptLookup('search', { terms: ['a', 'x'.repeat(5_000), 7, ...Array.from({ length: 50 }, () => 'y')], scope: 'jira', operationType: 'mutation', extra: 'ignored' })
  assert.equal(adapted.input.scope, 'jira')
  assert.equal(adapted.input.operationType, 'mutation')
  assert.ok((adapted.input.terms ?? []).length <= 20)
  assert.ok((adapted.input.terms ?? []).every(term => term.length <= 200))
  assert.equal(adapted.error, undefined)
  assert.ok(adaptLookup('search', { terms: 'jira' }).error !== undefined)
  assert.ok(adaptLookup('search', null).error !== undefined)
})

test('a found operation is drawn as the schema declares it: every argument, with its type, enum values and input fields', () => {
  const adapted = adaptLookup('search', { terms: ['find'] })
  const { ir, found } = settledLookup('s', 'search', adapted, { bundleDigest: 'd', results: [hit('acme_find')], scopes: ['acme'] }, 900)
  const root = ir.roots[0]
  assert.ok(root !== undefined)
  assert.equal(root.name, 'acme_find')
  assert.equal(root.service, 'acme')
  assert.equal(root.policy, 'unknown')
  assert.deepEqual(root.args, [])
  assert.deepEqual(root.omittedArgs?.map(arg => [arg.name, arg.type, arg.default, arg.isRequired]), [
    ['query', 'String!', undefined, true],
    ['limit', 'Int', '10', false],
    ['filter', 'Acme_Filter', undefined, false],
  ])
  assert.deepEqual(root.omittedArgs?.[2]?.inputFields, ['kind: Acme_Kind = A', 'tags: [String!]'])
  assert.equal(root.schema?.description, 'Find acme_find.')
  // The return type's fields, two levels: a type already on the path is not entered again.
  assert.deepEqual(root.children.map(child => child.name), ['items', 'next'])
  assert.deepEqual(root.children[0]?.children.map(child => child.name), ['title', 'owner'])
  assert.deepEqual(root.children[0]?.children[1]?.children, [])
  assert.equal(found.hits, 1)
  // Only a catalog search (no terms) keeps the catalog.
  assert.equal(found.scopes, undefined)
  assert.equal(found.bytes, 900)
})

test('a catalog search keeps the services, shape-checked', () => {
  const adapted = adaptLookup('search', { terms: [] })
  const { ir, found } = settledLookup('c', 'search', adapted, { results: [], scopes: ['jira', 'google-drive', '\u001b[31mevil', 'x'.repeat(200), 42] }, 50)
  assert.deepEqual(ir.roots, [])
  assert.deepEqual(found.scopes, ['jira', 'google-drive'])
})

test('a search keeps at most HITS_MAX operations and counts them all; a bad name is skipped', () => {
  const results = [{ operationName: 'not a name!', operationType: 'query', types: [] }, ...Array.from({ length: 50 }, (_, i) => hit(`acme_find${i}`))]
  const { ir, found } = settledLookup('s', 'search', adaptLookup('search', { terms: ['find'] }), { results }, 1)
  assert.equal(ir.roots.length, HITS_MAX)
  assert.equal(found.hits, 50)
  assert.deepEqual(found.counts?.hits, { kind: 'at-least', value: 50 })
  assert.ok(found.omissions?.some(one => /could not be read/.test(one)))
  assert.ok(ir.roots.every(root => /^acme_find\d+$/.test(root.name)))
})

test('a query and a mutation of one name keep paths of their own, and the mutation is said', () => {
  const { ir, found } = settledLookup('s', 'search', adaptLookup('search', { terms: ['x'] }), { results: [hit('acme_x'), { ...hit('acme_x'), operationType: 'mutation', types: [QUERY('acme_x').replace('type Query', 'type Mutation'), ...TYPES] }] }, 1)
  assert.deepEqual(ir.roots.map(root => root.path), ['acme_x', 'acme_x~mutation'])
  assert.deepEqual(found.mutations, ['acme_x~mutation'])
})

test('hostile SDL stays inert: control characters are kept as data, SDL that does not parse is skipped, a huge one is dropped', () => {
  const hostile = { operationName: 'acme_find', operationType: 'query', scope: 'acme', types: ['type Query {\n  """\u001b]8;;https://evil\u0007click\u001b]8;;\u0007"""\n  acme_find: String\n}\n', 'type {{{ nope', `type Huge { ${'f: String '.repeat(20_000)} }`] }
  const { ir } = settledLookup('s', 'search', adaptLookup('search', { terms: ['find'] }), { results: [hostile] }, 1)
  // Stored as the schema wrote it; the pane escapes it when drawn (src/escape.ts).
  assert.match(ir.roots[0]?.schema?.description ?? '', /click/)
  assert.equal(walk(ir.roots).length, 1)
})

test('descriptions past the budget are dropped, the first kept, and the entry says so', () => {
  const long = 'd'.repeat(30_000)
  const big = (name: string) => ({ operationName: name, operationType: 'query', scope: 'acme', types: [`type Query {\n  """${long}"""\n  ${name}: String\n}\n`] })
  const { ir, found } = settledLookup('s', 'search', adaptLookup('search', { terms: ['x'] }), { results: [big('acme_a'), big('acme_b'), big('acme_c')] }, 1)
  assert.equal(ir.roots[0]?.schema?.description?.length, 30_000)
  assert.equal(ir.roots[2]?.schema?.description, undefined)
  assert.equal(found.isTrimmed, true)
})

test('a recursive type does not recurse: each type is entered once on a path', () => {
  const recursive = { operationName: 'acme_node', operationType: 'query', scope: 'acme', types: ['type Query {\n  acme_node: Acme_Node\n}\n', 'type Acme_Node {\n  parent: Acme_Node\n  children: [Acme_Node]\n  name: String\n}\n'] }
  const { ir } = settledLookup('s', 'search', adaptLookup('search', { terms: ['x'] }), { results: [recursive] }, 1)
  assert.deepEqual(ir.roots[0]?.children.map(child => [child.name, child.children.length]), [['parent', 0], ['children', 0], ['name', 0]])
})

test("introspect draws the type asked for with its fields, and an enum's values", () => {
  const { ir, found } = settledLookup('i', 'introspect', adaptLookup('introspect', { scope: 'acme', type: 'Acme_Page', depth: 1 }), { scope: 'acme', types: TYPES }, 10)
  assert.equal(ir.roots[0]?.name, 'Acme_Page')
  assert.deepEqual(ir.roots[0]?.children.map(child => child.name), ['items', 'next'])
  assert.equal(found.types, 4)
  const enumOnly = settledLookup('i', 'introspect', adaptLookup('introspect', { scope: 'acme', type: 'Acme_Kind' }), { types: TYPES }, 10)
  assert.deepEqual(enumOnly.found.members, ['A', 'B'])
  assert.deepEqual(enumOnly.ir.roots[0]?.children, [])
})

test("validate keeps the operation Claude sent, with the compiler's answer", () => {
  const adapted = adaptLookup('validate', { scope: 'acme', operation: 'query Find { acme_find(query: "x") { items { nosuch } } }' })
  const { ir, found } = settledLookup('v', 'validate', adapted, { valid: false, errors: ['Error: no field `nosuch`\nError: another'] }, 10)
  assert.equal(ir.state, 'invalid')
  assert.equal(ir.opName, 'Find')
  assert.equal(ir.roots[0]?.service, 'acme')
  assert.equal(found.problems, 2)
  const valid = settledLookup('v', 'validate', adapted, { valid: true }, 10)
  assert.equal(valid.ir.validation?.valid, true)
  assert.notEqual(valid.ir.state, 'invalid')
})

test('missing validation results do not become reported invalid operations', () => {
  const adapted = adaptLookup('validate', { operation: 'query { acme_find }' })
  for (const response of [{}, { errors: ['upstream unavailable'] }, { valid: 'true' }]) {
    const settled = settledLookup('missing-validation', 'validate', adapted, response, 10)
    assert.equal(settled.ir.validation, undefined)
    assert.equal(settled.ir.checks?.validation, 'failed')
    assert.equal(settled.found.completeness, 'unavailable')
    assert.ok(settled.found.unreadable)
  }
})

test('dry_run preserves request positions when an input cannot be read, and reports malformed check results', () => {
  const adapted = adaptLookup('dry_run', { requests: [null, { scope: 'acme', operation: 'query { acme_find }' }] })
  const settled = settledLookup('request-index', 'dry_run', adapted, { results: [
    { denyOperation: true, fields: [{ path: 'acme_find', decision: 'deny' }] },
    { denyOperation: false, fields: [{ path: 'acme_find', decision: 'allow' }] },
  ] }, 10)
  assert.equal(settled.ir.roots[0]?.policy, 'allow')
  assert.notEqual(settled.found.requests?.[0]?.isDenied, true)
  assert.ok(settled.found.omissions?.length)
  for (const response of [{ fields: [] }, { denyOperation: false, fields: [null] }, { errors: [{ message: 'upstream unavailable' }] }]) {
    const failed = settledLookup('request-failed', 'dry_run', adaptLookup('dry_run', { requests: [{ scope: 'acme', operation: 'query { acme_find }' }] }), { results: [response] }, 10)
    assert.ok(failed.found.requests?.[0]?.error)
    assert.equal(failed.ir.roots[0]?.policy, 'unknown')
    assert.equal(failed.found.completeness, 'partial')
  }
})

test('missing search results are unknown, and retention limits preserve exact match totals', () => {
  const adapted = adaptLookup('search', { terms: ['find'] })
  const missing = settledLookup('missing-search', 'search', adapted, {}, 10)
  assert.deepEqual(missing.found.counts?.hits, { kind: 'unknown' })
  assert.equal(missing.found.hits, undefined)
  const complete = settledLookup('large-search', 'search', adapted, { results: Array.from({ length: 15 }, (_, i) => hit(`acme_find${i}`)) }, 10)
  assert.deepEqual(complete.found.counts?.hits, { kind: 'exact', value: 15 })
  assert.equal(complete.ir.roots.length, HITS_MAX)
  assert.ok(complete.found.omissions?.some(one => /matching operation definitions omitted/.test(one)))
})

test("dry_run: each request's policy on its own roots, a failed request said, tokens never kept", () => {
  const adapted = adaptLookup('dry_run', {
    requests: [
      { scope: 'acme', operation: 'query A { acme_find(query: "x") { items { title } } }' },
      { scope: 'acme', operation: 'query B { acme_find(query: "y") { next } }' },
      { scope: 'jira', operation: 'query C { jira_me { name } }' },
    ],
  })
  const token = 'eyJ'.padEnd(16_000, 'x')
  const { ir, found } = settledLookup('d', 'dry_run', adapted, {
    results: [
      { denyOperation: false, fields: [{ decision: 'allow', path: 'acme_find' }, { decision: 'deny', path: 'acme_find.items.title', denialContext: token }] },
      { denyOperation: true, fields: [{ decision: 'deny', path: 'acme_find' }] },
      { errors: ['Cannot query field "jira_me" on type "Query".'] },
    ],
  }, 10)
  // The second request's root shares the first's path: it is renamed rather than merged.
  assert.deepEqual(ir.roots.map(root => root.path), ['acme_find', 'r2:acme_find', 'jira_me'])
  assert.equal(walk(ir.roots).find(field => field.path === 'acme_find.items.title')?.policy, 'deny')
  assert.equal(ir.roots[1]?.policy, 'deny')
  assert.ok(!JSON.stringify(ir).includes(token.slice(0, 40)))
  assert.deepEqual(found.requests?.map(one => [one.scope, one.isDenied === true, one.error !== undefined]), [['acme', false, false], ['acme', true, false], ['jira', false, true]])
  assert.equal(ir.isOperationDenied, true)
  // Policy read back off the IR, to annotate it again with the schema.
  assert.equal(accessFromIR(ir)?.fields.get('acme_find.items.title')?.decision, 'deny')
})

test('a dry_run of a huge field list stays bounded in what the pane keeps', () => {
  const adapted = adaptLookup('dry_run', { requests: [{ scope: 'acme', operation: 'query A { acme_find(query: "x") { next } }' }] })
  const fields = Array.from({ length: 10_000 }, (_, i) => ({ decision: 'allow', path: `acme_find.f${i}` }))
  const { ir } = settledLookup('d', 'dry_run', adapted, { results: [{ denyOperation: false, fields: [{ decision: 'allow', path: 'acme_find' }, ...fields] }] }, 10)
  // Only the fields the operation selected carry a policy: the answer's other paths match nothing.
  assert.equal(walk(ir.roots).length, 2)
})

test('an answer that is not JSON is said as unreadable, and the call keeps what it sent', () => {
  const adapted = adaptLookup('validate', { scope: 'acme', operation: 'query A { acme_x }' })
  const { ir, found } = settledLookup('v', 'validate', adapted, 'upstream timed out', 5, 'upstream timed out')
  assert.equal(found.unreadable, 'upstream timed out')
  assert.equal(ir.roots[0]?.name, 'acme_x')
})

test('a pending search or introspect has no fields yet; a pending validate parses its operation', () => {
  assert.deepEqual(pendingIR('p', 'search', adaptLookup('search', { terms: ['x'] })).roots, [])
  assert.equal(pendingIR('p', 'validate', adaptLookup('validate', { scope: 'a', operation: 'query { a_x }' })).roots[0]?.name, 'a_x')
  assert.equal(pendingIR('p', 'validate', adaptLookup('validate', { scope: 'a' })).state, 'unparseable')
})

// ---- The queue

const execute = (id: string): InspectedCall => ({ id, server: 'gas', operation: 'query { a }', variables: '', status: 'pending', arrivedAt: 0, ir: { toolCallId: id, state: 'ready', roots: [] } })
const search = (id: string): InspectedCall => ({ ...execute(id), tool: 'search', input: { terms: ['x'] } })

test('a pending execute holds the pane over lookups that arrived before it', () => {
  const state = arrive(arrive(arrive(EMPTY, search('s1')), execute('e1')), search('s2'))
  assert.equal(shown(state).call?.id, 'e1')
  assert.equal(shown(state).waiting, 1)
  // With no execute waiting, the oldest pending lookup.
  assert.equal(shown(arrive(EMPTY, search('s3'))).call?.id, 's3')
})

test('mixed recent execute and search calls remain in the shared history', () => {
  let state = EMPTY
  for (let i = 0; i < 20; i += 1) state = settle(arrive(state, execute(`e${i}`)), `e${i}`, 'ran')
  for (let i = 0; i < 30; i += 1) state = settle(arrive(state, search(`s${i}`)), `s${i}`, 'ran')
  assert.equal(state.history.filter(call => call.tool === undefined).length, 20)
  assert.equal(state.history.filter(call => call.tool === 'search').length, 30)
  assert.equal(state.last?.id, 's29')
})

test('state with an unknown tool is dropped; one with no tool is an execute', () => {
  const bogus = { ...execute('b'), tool: 'execute_mutation' } as unknown as InspectedCall
  const state = { queue: [execute('e'), bogus], last: null, history: [] }
  assert.deepEqual(shown(state).call?.id, 'e')
  assert.equal(arrive(state, search('s')).queue.length, 2)
})

test('a lookup is final once it settled with its answer', () => {
  const ran = { ...search('s'), status: 'ran' as const }
  assert.equal(isFinal(ran), false)
  assert.equal(isFinal({ ...ran, found: { bytes: 1 } }), true)
  assert.equal(isFinal({ ...ran, status: 'errored' }), true)
})

// ---- Schema for a lookup's operation

test("a validate's operation gets its schema from search and introspect only, and keeps its own answer", async () => {
  const { enrichSchema, emptyCache } = await import('../../src/enrich.ts')
  const calls: string[] = []
  const mcp = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: false })
  const gas = async (tool: string, args: Record<string, unknown>) => {
    calls.push(tool)
    if (tool === 'search') return mcp({ bundleDigest: 'd', results: [{ operationName: 'acme_find', operationType: 'query', types: [QUERY('acme_find')] }] })
    if (tool === 'introspect') return mcp({ bundleDigest: 'd', types: TYPES, scope: args.scope })
    throw new Error(`never ${tool}`)
  }
  const adapted = adaptLookup('validate', { scope: 'acme', operation: 'query Find { acme_find(query: "x") { items { title } } }' })
  const { ir } = settledLookup('v', 'validate', adapted, { valid: true }, 10)
  const cache = emptyCache()
  const done = await enrichSchema(gas, cache, ir, { ...(ir.validation !== undefined && { validation: ir.validation }), checks: ir.checks ?? { policy: 'skipped', validation: 'ok', schema: 'skipped' } })
  assert.deepEqual([...new Set(calls)].sort(), ['introspect', 'search'])
  assert.equal(done.roots[0]?.schema?.description, 'Find acme_find.')
  assert.equal(walk(done.roots).find(field => field.name === 'title')?.schema?.description, 'The title.')
  assert.equal(done.validation?.valid, true)
  assert.equal(done.checks?.schema, 'ok')
  // A second look is the cache's.
  calls.length = 0
  await enrichSchema(gas, cache, ir, { checks: { policy: 'skipped', validation: 'ok', schema: 'skipped' } })
  assert.deepEqual(calls, [])
})

test("a dry_run's policy survives the schema pass, and a read not allowed is said as such", async () => {
  const { enrichSchema, emptyCache } = await import('../../src/enrich.ts')
  const adapted = adaptLookup('dry_run', { requests: [{ scope: 'acme', operation: 'query A { acme_find(query: "x") { next } }' }] })
  const { ir } = settledLookup('d', 'dry_run', adapted, { results: [{ denyOperation: false, fields: [{ decision: 'allow', path: 'acme_find' }, { decision: 'mask', path: 'acme_find.next' }] }] }, 10)
  const refused = async () => {
    throw Object.assign(new Error('not allowed'), { checkCause: 'not-allowed', decision: 'ask' })
  }
  const access = accessFromIR(ir)
  const done = await enrichSchema(refused, emptyCache(), ir, { ...(access !== undefined && { access }), checks: { policy: 'ok', validation: 'skipped', schema: 'skipped' } })
  assert.equal(walk(done.roots).find(field => field.name === 'next')?.policy, 'mask')
  assert.equal(done.checks?.schema, 'not-allowed')
})

test("a failed lookup keeps Agent Services' first error message, flat and bounded", async () => {
  const { lookupErrorOf } = await import('../../src/lookup.ts')
  const response = { errors: [{ extensions: { code: 'TYPE_NOT_AVAILABLE' }, message: 'scope `confluence`\nhas no type `SearchResult`' }] }
  assert.equal(lookupErrorOf(response, ''), 'scope `confluence` has no type `SearchResult`')
  assert.equal(lookupErrorOf({ errors: ['plain text error'] }, ''), 'plain text error')
  // Not JSON: the text itself.
  assert.equal(lookupErrorOf(undefined, '  upstream\ttimed out  '), 'upstream timed out')
  assert.equal(lookupErrorOf(undefined, '   '), undefined)
  assert.equal(lookupErrorOf(undefined, 'x'.repeat(5_000))?.length, 300)
})
