import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate, leafPolicyCounts } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { accessOf } from '../../src/gas.ts'
import { normalize } from '../../src/normalize.ts'
import { indexSdl } from '../../src/schema.ts'
import type { FieldIR } from '../../src/ir.ts'

const OP = `query SearchQueryPlanPages($cql: String!, $limit: Int) { confluence_search(cql: $cql, limit: $limit) { results { title excerpt url lastModified content { id type } } totalSize } }`
const VARS = { cql: 'type=page AND text ~ "query plan"', limit: 10 }

const SDL = [
  'type Query {\n  """\n  Search. Requires the search:confluence and read:confluence-content.summary scopes.\n  """\n  confluence_search(cql: String!, cursor: String, limit: Int): Confluence_SearchResult\n}\n',
  'type Confluence_SearchContent {\n  id: ID\n  type: String\n}\n',
  'type Confluence_SearchResultItem {\n  title: String\n  excerpt: String\n  url: String\n  lastModified: String\n  content: Confluence_SearchContent\n}\n',
  'type Confluence_SearchResult {\n  results: [Confluence_SearchResultItem!]\n  totalSize: Int\n}\n',
]
const DRY = {
  denyOperation: false,
  fields: [
    { decision: 'allow', path: 'confluence_search' },
    { decision: 'allow', path: 'confluence_search.results' },
    { decision: 'allow', path: 'confluence_search.results.title' },
    { decision: 'mask', path: 'confluence_search.results.excerpt' },
    { decision: 'allow', path: 'confluence_search.results.url' },
  ],
}

const find = (fields: readonly FieldIR[], path: string): FieldIR | undefined => {
  for (const f of fields) {
    if (f.path === path) return f
    const hit = find(f.children, path)
    if (hit) return hit
  }
  return undefined
}
const base = () => buildIR('t1', normalize(OP, VARS))
const full = () => annotate(base(), { schema: indexSdl(SDL), access: accessOf(DRY), validation: { valid: true, diagnostics: [] }, scope: 'confluence', bundleDigest: 'd1', isIncomplete: false })

test('coordinates become Parent.field', () => {
  const ir = full()
  assert.equal(ir.roots[0]!.coordinate, 'Query.confluence_search')
  assert.equal(find(ir.roots, 'confluence_search.results')!.coordinate, 'Confluence_SearchResult.results')
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.coordinate, 'Confluence_SearchResultItem.excerpt')
  assert.equal(find(ir.roots, 'confluence_search.results.content.id')!.coordinate, 'Confluence_SearchContent.id')
})

test('policy is applied, masked excerpt, unknown where dry_run had no path', () => {
  const ir = full()
  assert.equal(find(ir.roots, 'confluence_search.results.excerpt')!.policy, 'mask')
  assert.equal(find(ir.roots, 'confluence_search.results.title')!.policy, 'allow')
  assert.equal(find(ir.roots, 'confluence_search.results.lastModified')!.policy, 'unknown')
})

test('argument types are filled from the schema', () => {
  const root = full().roots[0]!
  assert.equal(root.args.find(a => a.name === 'cql')!.type, 'String!')
  assert.equal(root.args.find(a => a.name === 'limit')!.type, 'Int')
})

test('schema facts land on fields', () => {
  assert.equal(find(full().roots, 'confluence_search.results')!.schema!.isList, true)
  assert.equal(full().roots[0]!.schema!.type, 'Confluence_SearchResult')
})

test('scopes from the description land on the root', () => {
  assert.deepEqual(full().roots[0]!.schema!.scopes, ['search:confluence', 'read:confluence-content.summary'])
})

test('service and bundleDigest come from the enrichment', () => {
  const ir = full()
  assert.equal(ir.service, 'confluence')
  assert.equal(ir.bundleDigest, 'd1')
  assert.equal(ir.isOperationDenied, false)
})

test('state: ready, partial and invalid', () => {
  assert.equal(full().state, 'ready')
  assert.equal(annotate(base(), { isIncomplete: true }).state, 'partial')
  assert.equal(annotate(base(), { isIncomplete: false, validation: { valid: false, diagnostics: ['Error: x'] } }).state, 'invalid')
})

test('invalid wins over partial', () => {
  assert.equal(annotate(base(), { isIncomplete: true, validation: { valid: false, diagnostics: ['Error: x'] } }).state, 'invalid')
})

test('with nothing known, coordinates stay root-qualified and policy unknown', () => {
  const ir = annotate(base(), { isIncomplete: true })
  assert.equal(ir.roots[0]!.coordinate, 'Query.confluence_search')
  assert.equal(find(ir.roots, 'confluence_search.results')!.coordinate, 'results')
  assert.equal(ir.roots[0]!.policy, 'unknown')
})

test('an unparseable IR is returned unchanged', () => {
  const bad = buildIR('t', normalize('{ nope(', {}))
  assert.equal(annotate(bad, { isIncomplete: false }), bad)
})

test('aliases: policy is looked up by alias path, names stay real', () => {
  const ir = buildIR('t', normalize('{ hits: confluence_search(cql: "x") { items: results { heading: title excerpt } } }', {}))
  const access = accessOf({
    denyOperation: false,
    fields: [
      { decision: 'allow', path: 'hits' },
      { decision: 'deny', path: 'hits.items.heading', denialContext: 'tok' },
      { decision: 'mask', path: 'hits.items.excerpt' },
      { decision: 'allow', path: 'confluence_search.results.title' },
    ],
  })
  const out = annotate(ir, { schema: indexSdl(SDL), access, isIncomplete: false })
  const heading = find(out.roots, 'hits.items.heading')!
  assert.equal(heading.name, 'title')
  assert.equal(heading.alias, 'heading')
  assert.equal(heading.policy, 'deny')
  assert.equal(heading.denialContext, 'tok')
  assert.equal(heading.coordinate, 'Confluence_SearchResultItem.title')
  assert.equal(out.roots[0]!.name, 'confluence_search')
  assert.equal(find(out.roots, 'hits.items.excerpt')!.policy, 'mask')
})

test('leafPolicyCounts counts fields with no children only', () => {
  const all = leafPolicyCounts(full().roots)
  const total = all.allow + all.mask + all.deny + all.unknown
  assert.equal(total, 7)
  assert.equal(all.mask, 1)
  assert.deepEqual(leafPolicyCounts(base().roots), { allow: 0, mask: 0, deny: 0, unknown: 7 })
})

test('a denied or masked object counts as one field, its selection not at all', () => {
  const ir = full()
  const [root] = ir.roots
  const results = find(ir.roots, 'confluence_search.results')!
  const restricted = { ...ir, roots: [{ ...root!, children: root!.children.map(child => (child === results ? { ...child, policy: 'deny' as const } : child)) }] }
  const counts = leafPolicyCounts(restricted.roots)
  // totalSize stays a leaf of its own; everything under results is one denied field.
  assert.equal(counts.deny, 1)
  assert.equal(counts.allow + counts.mask + counts.deny + counts.unknown, 2)
})

const PAGING_SDL = [
  'type Query { jira_search(jql: String, startAt: Int, nextPageToken: String, page: Int): Jira_Results }',
  'type Jira_Results { issues: [Jira_Issue] nextPageToken: String }',
  'type Jira_Issue { key: String }',
]
const pagedAs = (args: string) => annotate(buildIR('p', normalize(`query P { jira_search(jql: "x"${args}) { issues { key } } }`, {})), { schema: indexSdl(PAGING_SDL), scope: 'jira', isIncomplete: false }).roots[0]!.paging

test('a paging argument set to where a list begins is still the first page', () => {
  for (const args of ['', ', startAt: 0', ', nextPageToken: null', ', page: 1', ', startAt: 0, nextPageToken: null']) assert.equal(pagedAs(args)?.isFirstPage, true, args)
  for (const args of [', startAt: 50', ', nextPageToken: "abc"', ', page: 2', ', startAt: 0, nextPageToken: "abc"']) assert.equal(pagedAs(args)?.isFirstPage, false, args)
})
