import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR, depthOf, provisionalService } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'

const OP = `query SearchQueryPlanPages($cql: String!, $limit: Int) { confluence_search(cql: $cql, limit: $limit) { results { title excerpt url lastModified content { id type } } totalSize } }`
const VARS = { cql: 'type=page AND text ~ "query plan"', limit: 10 }

type F = { name: string; path: string; children: F[] }
const paths = (fields: readonly F[]): string[] => fields.flatMap(f => [f.path, ...paths(f.children)])

test('builds an analyzing IR from a parsed operation', () => {
  const ir = buildIR('t1', normalize(OP, VARS))
  assert.equal(ir.toolCallId, 't1')
  assert.equal(ir.state, 'analyzing')
  assert.equal(ir.opType, 'query')
  assert.equal(ir.opName, 'SearchQueryPlanPages')
  assert.equal(ir.service, 'confluence')
  assert.equal(ir.roots.length, 1)
  assert.equal(ir.roots[0]!.name, 'confluence_search')
  assert.equal(ir.roots[0]!.coordinate, 'Query.confluence_search')
  assert.equal(ir.roots[0]!.policy, 'unknown')
})

test('substitutes variable values into args', () => {
  const root = buildIR('t1', normalize(OP, VARS)).roots[0]!
  const cql = root.args.find(a => a.name === 'cql')!
  assert.equal(cql.value, VARS.cql)
  assert.equal(cql.fromVariable, true)
})

test('uses real names, not aliases, and keeps the alias separately', () => {
  const ir = buildIR('t1', normalize('{ hits: confluence_search(cql: "x") { items: results { heading: title } } }', {}))
  const hits = ir.roots[0]!
  assert.equal(hits.name, 'confluence_search')
  assert.equal(hits.alias, 'hits')
  assert.equal(hits.children[0]!.name, 'results')
  assert.equal(hits.children[0]!.children[0]!.name, 'title')
  assert.equal(ir.service, 'confluence')
})

test('dry_run paths are built from response keys', () => {
  const ir = buildIR('t1', normalize('{ hits: confluence_search(cql: "x") { items: results { heading: title } } }', {}))
  assert.deepEqual(paths(ir.roots as unknown as F[]), ['hits', 'hits.items', 'hits.items.heading'])
})

test('unaliased paths use the real names', () => {
  const ir = buildIR('t1', normalize(OP, VARS))
  assert.ok(paths(ir.roots as unknown as F[]).includes('confluence_search.results.content.id'))
})

test('unparseable input gives state unparseable with a failure and no roots', () => {
  const ir = buildIR('t9', normalize('query { confluence_search(', {}))
  assert.equal(ir.state, 'unparseable')
  assert.ok(typeof ir.failure === 'string' && ir.failure.length > 0)
  assert.deepEqual(ir.roots, [])
})

test('provisionalService takes the prefix before the first underscore', () => {
  assert.equal(provisionalService('confluence_search'), 'confluence')
  assert.equal(provisionalService('jira_deleteIssue'), 'jira')
  assert.equal(provisionalService('search'), undefined)
  assert.equal(provisionalService('_x'), undefined)
})

test('depthOf counts selection depth below the roots', () => {
  assert.equal(depthOf([]), 0)
  assert.equal(depthOf(buildIR('t', normalize('{ a_b }', {})).roots), 0)
  assert.equal(depthOf(buildIR('t', normalize('{ a_b { c } }', {})).roots), 1)
  assert.equal(depthOf(buildIR('t', normalize(OP, VARS)).roots), 3)
})
