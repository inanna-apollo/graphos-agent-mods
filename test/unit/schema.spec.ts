import assert from 'node:assert/strict'
import { test } from 'node:test'

import { indexSdl, scopesFrom } from '../../src/schema.ts'

const SEARCH_SDL =
  'type Query {\n  """\n  Search Confluence content, spaces, and users with a CQL query (v1 search API). `cql` is required, e.g. `type=page AND space=DEV`. Requires the search:confluence and read:confluence-content.summary scopes.\n  """\n  confluence_search(cql: String!, cursor: String, limit: Int): Confluence_SearchResult\n}\n'
const INTROSPECT = [
  'type Confluence_SearchContent {\n  id: ID\n  type: String\n  status: String\n  title: String\n  spaceId: String\n}\n',
  '"""A single CQL search hit."""\ntype Confluence_SearchResultItem {\n  title: String\n  excerpt: String\n  url: String\n  entityType: String\n  lastModified: String\n  friendlyLastModified: String\n  score: Float\n  content: Confluence_SearchContent\n}\n',
  'type Confluence_SearchResult {\n  results: [Confluence_SearchResultItem!]\n  start: Int\n  limit: Int\n  size: Int\n  totalSize: Int\n  cqlQuery: String\n  searchDuration: Int\n  next: String\n}\n',
]

test('indexes the root field from a search snippet', () => {
  const def = indexSdl([SEARCH_SDL]).get('Query')!.get('confluence_search')!
  assert.equal(def.type, 'Confluence_SearchResult')
  assert.equal(def.namedType, 'Confluence_SearchResult')
  assert.equal(def.isList, false)
  assert.deepEqual({ ...def.args }, { cql: 'String!', cursor: 'String', limit: 'Int' })
  assert.match(def.description!, /CQL query/)
})

test('indexes introspect types, including lists and non-null wrappers', () => {
  const index = indexSdl([SEARCH_SDL, ...INTROSPECT])
  const results = index.get('Confluence_SearchResult')!.get('results')!
  assert.equal(results.type, '[Confluence_SearchResultItem!]')
  assert.equal(results.namedType, 'Confluence_SearchResultItem')
  assert.equal(results.isList, true)
  assert.equal(index.get('Confluence_SearchResultItem')!.get('excerpt')!.type, 'String')
  assert.equal(index.get('Confluence_SearchContent')!.get('id')!.namedType, 'ID')
})

test('a string that does not parse is skipped, the rest still indexed', () => {
  const index = indexSdl(['type Broken {', SEARCH_SDL, 'not sdl at all ???'])
  assert.ok(index.get('Query')!.has('confluence_search'))
  assert.equal(index.has('Broken'), false)
})

test('captures @deprecated(reason:)', () => {
  const def = indexSdl(['type Query { old: String @deprecated(reason: "use new") }']).get('Query')!.get('old')!
  assert.equal(def.deprecated, 'use new')
  assert.deepEqual(def.tags, [])
})

test('bare @deprecated is still recorded as deprecated', () => {
  const def = indexSdl(['type Query { old: String @deprecated }']).get('Query')!.get('old')!
  assert.ok(def.deprecated !== undefined)
})

test('unknown directives are kept by name in tags', () => {
  const def = indexSdl(['type Query { f: String @requiresScopes(scopes: [["a"]]) @cost(weight: 3) }']).get('Query')!.get('f')!
  assert.deepEqual(def.tags, ['requiresScopes', 'cost'])
})

test('snippets of the same type merge', () => {
  const index = indexSdl(['type Query { a: String }', 'type Query { b: Int }'])
  assert.deepEqual([...index.get('Query')!.keys()].sort(), ['a', 'b'])
})

test('indexing into an existing index adds to it', () => {
  const index = indexSdl(['type Query { a: String }'])
  indexSdl(['type Query { b: Int }'], index)
  assert.equal(index.get('Query')!.size, 2)
})

test('scopesFrom extracts dotted scopes from the real Agent Services description', () => {
  const desc = indexSdl([SEARCH_SDL]).get('Query')!.get('confluence_search')!.description!
  assert.deepEqual(scopesFrom(desc), ['search:confluence', 'read:confluence-content.summary'])
})

test('scopesFrom extracts undotted scopes', () => {
  assert.deepEqual(scopesFrom('Requires the search:confluence and read:jira-work scopes.'), ['search:confluence', 'read:jira-work'])
  assert.deepEqual(scopesFrom('Requires write:slack scope'), ['write:slack'])
})

test('scopesFrom handles variants', () => {
  assert.deepEqual(scopesFrom('Requires scope `read:jira-work`.'), ['read:jira-work'])
  assert.deepEqual(scopesFrom('requires the read:jira-work, write:jira-work scopes'), ['read:jira-work', 'write:jira-work'])
  assert.deepEqual(scopesFrom('Requires the a:b or c:d.e scopes'), ['a:b', 'c:d.e'])
  assert.deepEqual(scopesFrom('Requires the a:b scope. Unrelated text with foo:bar scopes.'), ['a:b'])
  assert.deepEqual(scopesFrom('Requires the nope scope. Requires the foo:bar scopes.'), ['foo:bar'])
  assert.deepEqual(scopesFrom('Requires the a:b.c. scopes'), [])
})

test('scopesFrom is linear on a 10,000-char description', () => {
  const t0 = Date.now()
  for (const d of ['requires '.repeat(1112), 'Requires ' + ' '.repeat(10000), 'Requires ' + 'a.b'.repeat(3300), 'Requires ' + 'a:b '.repeat(2500)]) {
    assert.deepEqual(scopesFrom(d), [])
  }
  assert.ok(Date.now() - t0 < 500)
})

test('scopesFrom returns [] for prose with no scopes or undefined', () => {
  assert.deepEqual(scopesFrom('Search pages. Requires a valid login.'), [])
  assert.deepEqual(scopesFrom('Lists spaces the user can see.'), [])
  assert.deepEqual(scopesFrom(undefined), [])
})

test('scopesFrom does not pick up random words or non-scope tokens', () => {
  const found = scopesFrom('Use `type=page AND space=DEV` for search. Note: this is slow. Requires the read:jira-work scope.')
  assert.deepEqual(found, ['read:jira-work'])
})
