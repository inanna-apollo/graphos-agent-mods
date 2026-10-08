import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { cacheForServer, emptyCache, enrich, isAllowedWithoutPrompt } from '../../src/enrich.ts'
import type { CallGas, EnrichCache, GasTool } from '../../src/enrich.ts'
import { payloadOf } from '../../src/gas.ts'
import { normalize } from '../../src/normalize.ts'
import type { FieldIR } from '../../src/ir.ts'

const OP = `query SearchQueryPlanPages($cql: String!, $limit: Int) { confluence_search(cql: $cql, limit: $limit) { results { title excerpt url lastModified content { id type } } totalSize } }`
const VARS = { cql: 'type=page AND text ~ "query plan"', limit: 10 }

const mcp = (payload: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError })
const withDigest = (answer: Awaited<ReturnType<CallGas>>, digest: string) => {
  const payload = payloadOf(answer)
  assert.ok(payload.ok)
  return mcp({ ...payload.value, bundleDigest: digest })
}

test('enrichment only accepts allow within an absent or allow organization ceiling', () => {
  const cases = [
    ['allow', [true, true, false, false]],
    ['ask', [false, false, false, false]],
    ['deny', [false, false, false, false]],
  ] as const
  for (const [decision, expected] of cases) {
    for (const [i, ceiling] of [undefined, 'allow', 'ask', 'deny'].entries()) {
      assert.equal(isAllowedWithoutPrompt({ decision, ceiling }), expected[i], `${decision} under ${ceiling ?? 'no ceiling'}`)
    }
  }
})

const SEARCH_ALL = { bundleDigest: 'd1', scopes: ['acme-customer-data', 'confluence', 'glean', 'jira', 'slack'], results: [] }
const SEARCH_ONE = {
  bundleDigest: 'd1',
  results: [{
    operationName: 'confluence_search',
    operationType: 'query',
    scope: 'confluence',
    types: ['type Query {\n  """\n  Search Confluence content, spaces, and users with a CQL query (v1 search API). `cql` is required, e.g. `type=page AND space=DEV`. Requires the search:confluence and read:confluence-content.summary scopes.\n  """\n  confluence_search(cql: String!, cursor: String, limit: Int): Confluence_SearchResult\n}\n'],
  }],
}
const INTROSPECT = {
  bundleDigest: 'd1',
  scope: 'confluence',
  types: [
    'type Confluence_SearchContent {\n  id: ID\n  type: String\n  status: String\n  title: String\n  spaceId: String\n}\n',
    '"""A single CQL search hit."""\ntype Confluence_SearchResultItem {\n  title: String\n  excerpt: String\n  url: String\n  entityType: String\n  lastModified: String\n  friendlyLastModified: String\n  score: Float\n  content: Confluence_SearchContent\n}\n',
    'type Confluence_SearchResult {\n  results: [Confluence_SearchResultItem!]\n  start: Int\n  limit: Int\n  size: Int\n  totalSize: Int\n  cqlQuery: String\n  searchDuration: Int\n  next: String\n}\n',
  ],
}
const VALID = { bundleDigest: 'd1', scope: 'confluence', valid: true }
const DRY = {
  bundleDigest: 'd1',
  results: [{
    denyOperation: false,
    fields: [
      { decision: 'allow', path: 'confluence_search' },
      { decision: 'allow', path: 'confluence_search.results' },
      { decision: 'allow', path: 'confluence_search.results.title' },
      { decision: 'mask', path: 'confluence_search.results.excerpt' },
      { decision: 'allow', path: 'confluence_search.results.url' },
    ],
  }],
}

type Overrides = Partial<Record<GasTool, (args: Record<string, unknown>) => Promise<ReturnType<typeof mcp>> | ReturnType<typeof mcp>>>

function fake(overrides: Overrides = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const call: CallGas = async (tool, args) => {
    calls.push({ tool, args })
    const custom = overrides[tool]
    if (custom !== undefined) return custom(args)
    switch (tool) {
      case 'search':
        return mcp((args.terms as unknown[]).length === 0 ? SEARCH_ALL : SEARCH_ONE)
      case 'introspect':
        return mcp(INTROSPECT)
      case 'validate':
        return mcp(VALID)
      case 'dry_run':
        return mcp(DRY)
    }
  }
  return { call, calls, count: (tool: string) => calls.filter(c => c.tool === tool).length }
}

const build = (op = OP, vars: Record<string, unknown> = VARS) => buildIR('t1', normalize(op, vars))
const find = (fields: readonly FieldIR[], path: string): FieldIR | undefined => {
  for (const f of fields) {
    if (f.path === path) return f
    const hit = find(f.children, path)
    if (hit) return hit
  }
  return undefined
}

test('happy path: ready, service, digest, policy and schema', async () => {
  const { call } = fake()
  const ir = await enrich(call, emptyCache(), build(), OP)
  assert.equal(ir.state, 'ready')
  assert.equal(ir.service, 'confluence')
  assert.equal(ir.bundleDigest, 'd1')
  assert.equal(ir.validation!.valid, true)
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.policy, 'mask')
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.coordinate, 'Confluence_SearchResultItem.excerpt')
  assert.equal(find(ir.roots, 'confluence_search.results.lastModified')!.policy, 'unknown')
  assert.equal(ir.roots[0]!.schema!.type, 'Confluence_SearchResult')
})

test('scopes land on the root schema', async () => {
  const ir = await enrich(fake().call, emptyCache(), build(), OP)
  assert.deepEqual(ir.roots[0]!.schema!.scopes, ['search:confluence', 'read:confluence-content.summary'])
})

test('only read-only tools are called, never execute', async () => {
  const f = fake()
  await enrich(f.call, emptyCache(), build(), OP)
  const allowed = new Set(['search', 'introspect', 'validate', 'dry_run'])
  assert.ok(f.calls.length > 0)
  for (const c of f.calls) assert.ok(allowed.has(c.tool), c.tool)
  assert.equal(f.count('execute'), 0)
})

test('validate and dry_run are sent the scope and the operation', async () => {
  const f = fake()
  await enrich(f.call, emptyCache(), build(), OP)
  const v = f.calls.find(c => c.tool === 'validate')!
  assert.equal(v.args.scope, 'confluence')
  assert.equal(v.args.operation, OP)
})

test('the cache: a second enrich of the same op makes no new search/introspect calls', async () => {
  const f = fake()
  const cache = emptyCache()
  await enrich(f.call, cache, build(), OP)
  const before = { search: f.count('search'), introspect: f.count('introspect') }
  assert.ok(before.search > 0 && before.introspect > 0)
  const second = await enrich(f.call, cache, build(), OP)
  assert.equal(f.count('search'), before.search)
  assert.equal(f.count('introspect'), before.introspect)
  assert.equal(second.state, 'ready')
})

test('a different bundleDigest clears the cache', async () => {
  let digest = 'd1'
  const f = fake()
  const call: CallGas = async (tool, args) => {
    const answer = await f.call(tool, args)
    return withDigest(answer, digest)
  }
  const cache = emptyCache()
  await enrich(call, cache, build(), OP)
  digest = 'd2'
  const searches = f.count('search')
  const changed = await enrich(call, cache, build(), OP)
  assert.ok(f.count('search') > searches, 'the same analysis refetches after the digest moves')
  assert.equal(changed.state, 'ready')
  assert.equal(changed.bundleDigest, 'd2')
})

test('different servers discover their own scopes and schema', async () => {
  const caches = new Map<string, EnrichCache>()
  await enrich(fake().call, cacheForServer(caches, 'first'), build(), OP)
  let searches = 0
  const call: CallGas = async (tool, args) => {
    if (tool === 'search') {
      searches++
      return mcp((args.terms as string[]).length === 0
        ? { bundleDigest: 'other', scopes: ['slack'] }
        : { bundleDigest: 'other', results: [{ operationName: 'slack_read', types: ['type Query { slack_read: Int }'] }] })
    }
    return mcp(tool === 'validate' ? { bundleDigest: 'other', valid: true } : { bundleDigest: 'other', results: [{ fields: [{ path: 'slack_read', decision: 'allow' }] }] })
  }
  const op = '{ slack_read }'
  const second = await enrich(call, cacheForServer(caches, 'second'), build(op, {}), op)
  assert.equal(searches, 2)
  assert.equal(second.bundleDigest, 'other')
  assert.equal(second.roots[0]!.schema!.type, 'Int')
  assert.equal(second.roots[0]!.policy, 'allow')
})

test('a bundle change refetches a cached signature before reporting ready', async () => {
  let digest = 'old'
  const call: CallGas = async (tool, args) => {
    if (tool === 'search') return mcp((args.terms as string[]).length === 0
      ? { bundleDigest: digest, scopes: ['jira'] }
      : { bundleDigest: digest, results: [{ operationName: 'jira_read', types: [`type Query { jira_read: ${digest === 'old' ? 'String' : 'Int'} }`] }] })
    return mcp(tool === 'validate' ? { bundleDigest: digest, valid: true } : { bundleDigest: digest, results: [{ fields: [{ path: 'jira_read', decision: 'allow' }] }] })
  }
  const cache = emptyCache()
  const op = '{ jira_read }'
  await enrich(call, cache, build(op, {}), op)
  digest = 'new'
  const changed = await enrich(call, cache, build(op, {}), op)
  assert.equal(changed.state, 'ready')
  assert.equal(changed.bundleDigest, 'new')
  assert.equal(changed.roots[0]!.schema!.type, 'Int')
})

test('query and mutation roots with the same name retain their own signatures', async () => {
  const f = fake({ search: args => (args.terms as string[]).length === 0 ? mcp(SEARCH_ALL) : mcp({
    bundleDigest: 'd1',
    results: [{ operationName: 'confluence_same', types: [args.operationType === 'query' ? 'type Query { confluence_same: String }' : 'type Mutation { confluence_same: Int }'] }],
  }) })
  const cache = emptyCache()
  const query = 'query { confluence_same }'
  const mutation = 'mutation { confluence_same }'
  await enrich(f.call, cache, build(query, {}), query)
  const changed = await enrich(f.call, cache, build(mutation, {}), mutation)
  assert.equal(changed.roots[0]!.schema!.type, 'Int')
})

test('a repeatedly changing bundle stops after one retry and leaves facts unknown', async () => {
  let digest = 0
  let scopeReads = 0
  const call: CallGas = async (tool, args) => {
    if (tool === 'search' && (args.terms as string[]).length === 0) scopeReads++
    return mcp({ bundleDigest: `d${++digest}`, scopes: ['confluence'], valid: true, results: [{ fields: [{ path: 'confluence_search', decision: 'allow' }] }] })
  }
  const ir = await enrich(call, emptyCache(), build(), OP)
  assert.equal(scopeReads, 2)
  assert.equal(ir.state, 'partial')
  assert.equal(ir.bundleDigest, undefined)
  assert.equal(ir.validation, undefined)
  assert.equal(ir.roots[0]!.schema, undefined)
  assert.equal(ir.roots[0]!.policy, 'unknown')
  assert.match(ir.checks!.error!, /bundle changed/)
})

test('a late response from an older generation cannot roll the cache back', async () => {
  const cache = emptyCache()
  let release!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  let requested!: () => void
  const started = new Promise<void>(resolve => requested = resolve)
  let reads = 0
  const old: CallGas = async (tool, args) => {
    if (tool === 'search' && (args.terms as string[]).length === 0) {
      if (++reads === 1) { requested(); await held; return mcp({ bundleDigest: 'old', scopes: ['confluence'] }) }
      return mcp({ bundleDigest: 'new', scopes: ['confluence'] })
    }
    const response = await fake().call(tool, args)
    return withDigest(response, 'new')
  }
  // Establish a generation, then leave another scope lookup in flight.
  cache.bundleDigest = 'initial'
  const waiting = enrich(old, cache, build(), OP)
  await started
  const current: CallGas = async (tool, args) => {
    const response = await fake().call(tool, args)
    return withDigest(response, 'new')
  }
  await enrich(current, cache, build(), OP)
  release()
  const result = await waiting
  assert.equal(cache.bundleDigest, 'new')
  assert.equal(result.bundleDigest, 'new')
  assert.equal(result.state, 'ready')
})

test('a rejecting dry_run gives partial with unknown policy and does not reject', async () => {
  const f = fake({ dry_run: () => Promise.reject(new Error('network down')) })
  const ir = await enrich(f.call, emptyCache(), build(), OP)
  assert.equal(ir.state, 'partial')
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.policy, 'unknown')
  assert.equal(ir.roots[0]!.coordinate, 'Query.confluence_search')
})

test('a dry_run isError with non-JSON text gives partial', async () => {
  const f = fake({ dry_run: () => ({ content: [{ type: 'text' as const, text: 'upstream exploded' }], isError: true }) })
  const ir = await enrich(f.call, emptyCache(), build(), OP)
  assert.equal(ir.state, 'partial')
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.policy, 'unknown')
})

test('an invalid validate result gives state invalid', async () => {
  const f = fake({ validate: () => mcp({ bundleDigest: 'd1', scope: 'confluence', valid: false, errors: ['Error: bad'] }) })
  const ir = await enrich(f.call, emptyCache(), build(), OP)
  assert.equal(ir.state, 'invalid')
  assert.deepEqual(ir.validation!.diagnostics, ['Error: bad'])
})

test('a failing introspect still yields policy and partial', async () => {
  const f = fake({ introspect: () => Promise.reject(new Error('boom')) })
  const ir = await enrich(f.call, emptyCache(), build(), OP)
  assert.equal(ir.state, 'partial')
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.policy, 'mask')
})

test('a failing search never rejects', async () => {
  const f = fake({ search: () => Promise.reject(new Error('down')) })
  const ir = await enrich(f.call, emptyCache(), build(), OP)
  assert.equal(ir.state, 'partial')
  assert.equal(f.count('validate'), 0)
})

for (const field of ['__typename', 'unknown_thing']) {
  test(`root field ${field} with no matching scope is partial without validate/dry_run`, async () => {
    const f = fake()
    const op = `{ ${field} }`
    const ir = await enrich(f.call, emptyCache(), build(op, {}), op)
    assert.equal(ir.state, 'partial')
    assert.equal(f.count('validate'), 0)
    assert.equal(f.count('dry_run'), 0)
  })
}

const GNARLY = `query Gnarly($jql: String!, $size: Int = 3, $withRoles: Boolean!) {
  open: jira_search(jql: $jql, maxResults: $size) { ... on Jira_Results { issues { key } } }
  incidents: incidentio_incidents(pageSize: $size) { ...Bits roles @include(if: $withRoles) { name } }
  members: acme_customer_data_listMembers(orgId: "x") { id email }
}
fragment Bits on IncidentIO_Incident { ref: reference name }`
const GNARLY_VARS = { jql: 'project = A', withRoles: true }

const SDLS: Record<string, { root: string; types: string[] }> = {
  jira: { root: 'type Query { jira_search(jql: String, maxResults: Int): Jira_Results }', types: ['type Jira_Results { issues: [Jira_Issue] }', 'type Jira_Issue { key: String }'] },
  incidentio: {
    root: 'type Query { incidentio_incidents(pageSize: Int): [IncidentIO_Incident] }',
    types: ['type IncidentIO_Incident { reference: String name: String roles: [IncidentIO_Role] }', 'type IncidentIO_Role { name: String }'],
  },
  'acme-customer-data': {
    root: 'type Query { acme_customer_data_listMembers(orgId: String): [Acme_Member] }',
    types: ['type Acme_Member { id: ID email: String }'],
  },
}

/** An Agent Services stand-in that answers per scope, and records the operation each scope was sent. */
function gnarlyGas(opts: { denyEmail?: boolean; failScope?: string } = {}) {
  const sent = new Map<string, { validate?: string; dryRun?: string }>()
  const call: CallGas = async (tool, args) => {
    if (tool === 'search') {
      const terms = args.terms as string[]
      if (terms.length === 0) return mcp({ bundleDigest: 'd', scopes: Object.keys(SDLS), results: [] })
      const scope = args.scope as string
      return mcp({ bundleDigest: 'd', results: [{ operationName: terms[0], operationType: 'query', scope, types: [SDLS[scope]!.root] }] })
    }
    if (tool === 'introspect') return mcp({ bundleDigest: 'd', types: SDLS[args.scope as string]!.types })
    const scope = tool === 'validate' ? (args.scope as string) : ((args.requests as { scope: string }[])[0]!.scope)
    const operation = tool === 'validate' ? (args.operation as string) : ((args.requests as { operation: string }[])[0]!.operation)
    sent.set(scope, { ...sent.get(scope), ...(tool === 'validate' ? { validate: operation } : { dryRun: operation }) })
    if (scope === opts.failScope) return { content: [{ type: 'text' as const, text: 'boom' }], isError: true }
    if (tool === 'validate') return mcp({ bundleDigest: 'd', valid: true })
    // Paths use response keys: the aliases.
    const paths: Record<string, [string, string][]> = {
      jira: [['open', 'allow'], ['open.issues', 'allow'], ['open.issues.key', 'allow']],
      incidentio: [['incidents', 'allow'], ['incidents.ref', 'allow'], ['incidents.name', 'allow'], ['incidents.roles', 'allow'], ['incidents.roles.name', 'allow']],
      'acme-customer-data': [['members', 'allow'], ['members.id', 'allow'], ['members.email', opts.denyEmail === true ? 'deny' : 'mask']],
    }
    return mcp({ bundleDigest: 'd', results: [{ denyOperation: false, fields: paths[scope]!.map(([path, decision]) => ({ path, decision })) }] })
  }
  return { call, sent }
}

test('roots across services are each checked against their own scope, in one IR', async () => {
  const gas = gnarlyGas()
  const ir = await enrich(gas.call, emptyCache(), build(GNARLY, GNARLY_VARS), GNARLY, GNARLY_VARS)
  assert.equal(ir.state, 'ready')
  assert.deepEqual(ir.services, ['jira', 'incidentio', 'acme-customer-data'])
  assert.deepEqual([...gas.sent.keys()].sort(), ['acme-customer-data', 'incidentio', 'jira'])
  // Each scope was sent only its own root.
  assert.match(gas.sent.get('jira')!.validate!, /jira_search/)
  assert.doesNotMatch(gas.sent.get('jira')!.validate!, /incidentio_incidents|acme_customer_data/)
  assert.doesNotMatch(gas.sent.get('incidentio')!.dryRun!, /jira_search/)
  // Policy lands by response key, schema per root, the scope per root.
  assert.equal(find(ir.roots, 'members.email')!.policy, 'mask')
  assert.equal(find(ir.roots, 'incidents.ref')!.policy, 'allow')
  assert.equal(find(ir.roots, 'open.issues.key')!.policy, 'allow')
  assert.equal(ir.roots.map(root => root.schema?.type).join(), 'Jira_Results,[IncidentIO_Incident],[Acme_Member]')
  assert.deepEqual(ir.roots.map(root => root.service), ['jira', 'incidentio', 'acme-customer-data'])
  assert.deepEqual(ir.checks, { policy: 'ok', validation: 'ok', schema: 'ok' })
  assert.equal(ir.validation?.valid, true)
  // The type condition equal to the parent type names nothing: dropped now the schema is known.
  assert.equal(find(ir.roots, 'incidents.ref')!.onType, undefined)
})

test('a denial in one scope is a denial in the merged IR', async () => {
  const ir = await enrich(gnarlyGas({ denyEmail: true }).call, emptyCache(), build(GNARLY, GNARLY_VARS), GNARLY, GNARLY_VARS)
  assert.equal(find(ir.roots, 'members.email')!.policy, 'deny')
})

test('one scope failing leaves only its roots unknown', async () => {
  const ir = await enrich(gnarlyGas({ failScope: 'incidentio' }).call, emptyCache(), build(GNARLY, GNARLY_VARS), GNARLY, GNARLY_VARS)
  assert.equal(ir.state, 'partial')
  assert.equal(find(ir.roots, 'incidents.name')!.policy, 'unknown')
  assert.equal(find(ir.roots, 'open.issues.key')!.policy, 'allow')
  assert.equal(find(ir.roots, 'members.id')!.policy, 'allow')
  assert.equal(ir.checks?.policy, 'failed')
})

test('a root no service claims stays unchecked while the others are', async () => {
  const op = '{ open: jira_search(jql: "a") { issues { key } } mystery_thing { x } }'
  const gas = gnarlyGas()
  const ir = await enrich(gas.call, emptyCache(), build(op, {}), op, {})
  assert.equal(ir.state, 'partial')
  assert.equal(find(ir.roots, 'open.issues.key')!.policy, 'allow')
  assert.equal(find(ir.roots, 'mystery_thing.x')!.policy, 'unknown')
  assert.deepEqual([...gas.sent.keys()], ['jira'])
  assert.doesNotMatch(gas.sent.get('jira')!.validate!, /mystery_thing/)
  assert.equal(ir.checks?.policy, 'skipped')
})

test('multi-service enrichment never calls execute', async () => {
  const seen: string[] = []
  const gas = gnarlyGas()
  await enrich(async (tool, args) => (seen.push(tool), gas.call(tool, args)), emptyCache(), build(GNARLY, GNARLY_VARS), GNARLY, GNARLY_VARS)
  for (const tool of seen) assert.ok(['search', 'introspect', 'validate', 'dry_run'].includes(tool), tool)
})

test('an unparseable IR is returned unchanged with zero calls', async () => {
  const f = fake()
  const bad = buildIR('t', normalize('{ nope(', {}))
  const out = await enrich(f.call, emptyCache(), bad, '{ nope(')
  assert.equal(out, bad)
  assert.equal(f.calls.length, 0)
})

test('a dry_run per-request error is recorded as a failed policy check with its message', async () => {
  const { enrich, emptyCache } = await import('../../src/enrich.ts')
  const { buildIR } = await import('../../src/build.ts')
  const { normalize } = await import('../../src/normalize.ts')
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }], isError: false })
  const ir0 = buildIR('g', normalize('query G { glean_search(query: "x") { results { title } } }', {}))
  const call = async (tool: string) => {
    if (tool === 'search') return text({ bundleDigest: 'd', scopes: ['glean'], results: [] })
    if (tool === 'validate') return text({ bundleDigest: 'd', valid: true })
    if (tool === 'dry_run') return text({ bundleDigest: 'd', results: [{ errors: ['Unknown scope "glean".'] }] })
    return text({ bundleDigest: 'd', types: [] })
  }
  const ir = await enrich(call, emptyCache(), ir0, 'query G { glean_search(query: "x") { results { title } } }')
  assert.equal(ir.checks?.policy, 'failed')
  assert.equal(ir.checks?.validation, 'ok')
  assert.match(ir.checks?.error ?? '', /Unknown scope "glean"/)
})
