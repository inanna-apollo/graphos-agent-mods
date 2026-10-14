import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { enumsOf, hintsFrom, indexSdl } from '../../src/schema.ts'
import { cameBack, completeArgFacts, completeFieldFacts, scopesNote, statusFacts } from '../../src/view/card-facts.ts'

const GLEAN = [
  `type Query {
  """Search Glean."""
  glean_search(
    "The search query."
    query: String!
    """
    Results per page. Maximum of \`100\`. Defaults to \`10\`.
    """
    pageSize: Int! = 10
    "Opaque cursor from a previous response."
    cursor: String
    datasources: [String!]
    facetFilters: [Glean_FacetFilterInput!]
    "How to combine. (one of AND|OR)"
    operator: Glean_Op = AND
  ): Glean_SearchResponse
}`,
  'enum Glean_Op { AND OR }',
  'type Glean_SearchResponse { results: [Glean_SearchResult] cursor: String hasMoreResults: Boolean }',
  'type Glean_SearchResult { title: String }',
]
const CONFLUENCE = [
  'type Query { confluence_search(cql: String!, cursor: String, limit: Int): Confluence_SearchResult }',
  'type Confluence_SearchResult { results: [Confluence_SearchResultItem!] next: String }',
  'type Confluence_SearchResultItem { title: String }',
]
const SLACK = [
  'type Query {\n  slack_searchMessages(query: String!, "Maximum of `100`." count: Int, page: Int): Slack_Messages\n}',
  'type Slack_Messages { matches: [Slack_Match] total: Int }',
  'type Slack_Match { text: String }',
]

const run = (sdl: string[], op: string) =>
  annotate(buildIR('t', normalize(op, {})), { schema: indexSdl(sdl), isIncomplete: false })

test('declaration details retain required inputs and defaults without claiming an operation was submitted', () => {
  const root = run(GLEAN, '{ glean_search { results { title } } }').roots[0]!
  const context = { isDeclared: true, policyFacts: false, tool: 'search' as const }
  const facts = completeFieldFacts(root, undefined, context).join('\n')
  assert.match(facts, /query: String!.*required/)
  assert.match(facts, /pageSize: Int!.*default 10/)
  assert.doesNotMatch(facts, /not supplied by the call|set:|server uses|policy:/)
  assert.match(completeArgFacts(root.omittedArgs!.find(one => one.name === 'pageSize')!, true, context).join('\n'), /default 10/)
})

test('schema validation details show submitted values, and dry_run details show access evidence separately', () => {
  const root = run(GLEAN, '{ glean_search(query: "Apollo", pageSize: 3) { results { title } } }').roots[0]!
  root.policy = 'allow'
  const validation = completeFieldFacts(root, undefined, { isDeclared: false, policyFacts: false, tool: 'validate' }).join('\n')
  assert.match(validation, /query: String! = "Apollo"/)
  assert.match(validation, /pageSize: Int! = 3/)
  assert.doesNotMatch(validation, /policy:/)
  const rehearsal = completeFieldFacts(root, undefined, { isDeclared: false, policyFacts: true, tool: 'dry_run' }).join('\n')
  assert.match(rehearsal, /dry_run: allowed/)
  assert.doesNotMatch(rehearsal, /returned:/)
})

test('opaque scalar facts explain that payload keys do not become GraphQL selectable fields', () => {
  const root = run(['scalar Atlas_JSON', 'type Query { atlas_payload: Atlas_JSON }'], '{ atlas_payload }').roots[0]!
  assert.equal(root.children.length, 0)
  const facts = completeFieldFacts(root).join('\n')
  assert.match(facts, /GraphQL JSON scalar/)
  assert.match(facts, /without selectable child fields/)
  assert.match(facts, /upstream service/)
})

test('an absent schema field never establishes absence of required scopes', () => {
  const ir = run(['type Query { item: Item }', 'type Item { id: ID }'], '{ item { id } }')
  assert.match(scopesNote(ir) ?? '', /no scopes listed/)
  delete ir.roots[0]!.children[0]!.schema
  assert.equal(scopesNote(ir), undefined)
  ir.checks = { schema: 'ok', policy: 'skipped', validation: 'skipped' }
  assert.equal(scopesNote(ir), undefined)
})

test('interruption describes missing observation without claiming execution never happened', () => {
  const facts = statusFacts('interrupted', undefined).join(' ')
  assert.match(facts, /before a response/)
  assert.match(facts, /does not establish whether/)
  assert.doesNotMatch(facts, /ran the call and the response came back/)
})

test('legacy scalar facts do not borrow a same-named value from another root', () => {
  const ir = run(['type Query { item: Item }', 'type Item { total: Int }'], '{ left: item { total } right: item { total } }')
  const left = ir.roots[0]!.children[0]!
  const outcome = { rows: [], errors: [], authLinks: [], scalars: [{ field: 'total', root: 'right', value: 42 }] }
  assert.deepEqual(cameBack(left, outcome, ir.roots), [])
  const ambiguous = { ...outcome, scalars: [{ field: 'total', value: 42 }] }
  assert.deepEqual(cameBack(left, ambiguous, ir.roots), [])
})

test('type facts: nullable list of non-null items', () => {
  const def = indexSdl(CONFLUENCE).get('Confluence_SearchResult')!.get('results')!
  assert.equal(def.type, '[Confluence_SearchResultItem!]')
  assert.equal(def.isList, true)
  assert.equal(def.isListItemNonNull, true)
  assert.equal(def.isListNonNull, false)
  assert.equal(def.isNonNull, false)
  const ir = run(CONFLUENCE, '{ confluence_search(cql: "x") { results { title } } }')
  const schema = ir.roots[0]!.children[0]!.schema!
  assert.deepEqual([schema.isNonNull, schema.isListNonNull, schema.isListItemNonNull], [false, false, true])
})

test('type facts: [T]! and T!', () => {
  const q = indexSdl(['type Query { a: [String]! b: String! c: [String!]! }']).get('Query')!
  assert.deepEqual([q.get('a')!.isNonNull, q.get('a')!.isListNonNull, q.get('a')!.isListItemNonNull], [true, true, false])
  assert.deepEqual([q.get('b')!.isNonNull, q.get('b')!.isListNonNull, q.get('b')!.isListItemNonNull], [true, false, false])
  assert.deepEqual([q.get('c')!.isNonNull, q.get('c')!.isListNonNull, q.get('c')!.isListItemNonNull], [true, true, true])
})

test('arg facts on set args: type, default, description, enum values, hints', () => {
  const root = run(GLEAN, '{ glean_search(query: "a", operator: OR) { results { title } } }').roots[0]!
  const op = root.args.find(a => a.name === 'operator')!
  assert.equal(op.type, 'Glean_Op')
  assert.equal(op.defaultValue, 'AND')
  assert.deepEqual(op.enumValues, ['AND', 'OR'])
  assert.deepEqual(op.hints, ['one of AND|OR'])
  assert.match(op.description!, /How to combine/)
  assert.equal(root.args.find(a => a.name === 'query')!.enumValues, undefined)
})

test('unset pageSize is omitted with default 10; other omitted args listed', () => {
  const root = run(GLEAN, '{ glean_search(query: "a") { results { title } } }').roots[0]!
  const names = root.omittedArgs!.map(a => a.name)
  assert.deepEqual(names, ['pageSize', 'cursor', 'datasources', 'facetFilters', 'operator'])
  const page = root.omittedArgs!.find(a => a.name === 'pageSize')!
  assert.equal(page.default, '10')
  assert.equal(page.type, 'Int!')
  assert.equal(page.isRequired, false)
  assert.match(page.description!, /Maximum/)
  assert.equal(root.omittedArgs!.find(a => a.name === 'cursor')!.isRequired, false)
})

test('a required omitted arg is flagged', () => {
  const root = run(CONFLUENCE, '{ confluence_search { results { title } } }').roots[0]!
  assert.equal(root.omittedArgs!.find(a => a.name === 'cql')!.isRequired, true)
})

test('cursor paging on the first page', () => {
  const root = run(GLEAN, '{ glean_search(query: "a") { results { title } } }').roots[0]!
  assert.deepEqual(root.paging, { kind: 'cursor', via: ['cursor'], isFirstPage: true, moreField: 'cursor', flagField: 'hasMoreResults' })
})

test('cursor paging past the first page; confluence moreField is next', () => {
  const g = run(GLEAN, '{ glean_search(query: "a", cursor: "c") { results { title } } }').roots[0]!
  assert.equal(g.paging!.isFirstPage, false)
  const c = run(CONFLUENCE, '{ confluence_search(cql: "x") { results { title } } }').roots[0]!
  assert.deepEqual(c.paging, { kind: 'cursor', via: ['cursor'], isFirstPage: true, moreField: 'next' })
})

test('page paging for slack; count is not a paging arg; max hint extracted', () => {
  const root = run(SLACK, '{ slack_searchMessages(query: "a", count: 5) { total } }').roots[0]!
  assert.deepEqual(root.paging, { kind: 'page', via: ['page'], isFirstPage: true })
  assert.deepEqual(root.args.find(a => a.name === 'count')!.hints, ['max 100'])
  const omitted = run(SLACK, '{ slack_searchMessages(query: "a") { total } }').roots[0]!.omittedArgs!
  assert.deepEqual(omitted.find(a => a.name === 'count')!.description, 'Maximum of `100`.')
})

test('no paging for a non-list response or without paging args', () => {
  const none = run(['type Query { me(id: ID): User } type User { name: String }'], '{ me { name } }').roots[0]!
  assert.equal(none.paging, undefined)
  const noargs = run(['type Query { items: [Item] } type Item { a: Int }'], '{ items { a } }').roots[0]!
  assert.equal(noargs.paging, undefined)
  assert.equal(noargs.omittedArgs, undefined)
})

test('SDL without descriptions still works', () => {
  const root = run(['type Query { f(a: Int! = 3, after: String): [R] } type R { x: Int }'], '{ f { x } }').roots[0]!
  assert.equal(root.schema!.hints, undefined)
  assert.deepEqual(root.omittedArgs!.map(a => [a.name, a.default, a.description, a.isRequired]), [
    ['a', '3', undefined, false],
    ['after', undefined, undefined, false],
  ])
  assert.equal(root.paging!.kind, 'cursor')
})

test('defaults print as literals', () => {
  const def = indexSdl(['type Query { f(a: Int = 10, b: E = EQUALS, c: String = "and"): Int } enum E { EQUALS }']).get('Query')!.get('f')!
  assert.deepEqual([def.argDefs.a!.defaultValue, def.argDefs.b!.defaultValue, def.argDefs.c!.defaultValue], ['10', 'EQUALS', '"and"'])
})

test('enums are collected across SDL strings', () => {
  const index = indexSdl(['enum A { X Y }', 'type Query { a: Int }'])
  assert.deepEqual(enumsOf(index).get('A'), ['X', 'Y'])
})

test('hint patterns', () => {
  assert.deepEqual(hintsFrom('Maximum of `100`.'), ['max 100'])
  assert.deepEqual(hintsFrom('Defaults to `web`.'), ['default web'])
  assert.deepEqual(hintsFrom('Times are in Pacific Time.'), ['timezone Pacific Time'])
  assert.deepEqual(hintsFrom('Match mode (one of A|B|C).'), ['one of A|B|C'])
  assert.deepEqual(hintsFrom('Match mode (one of A, B or C).'), ['one of A|B|C'])
  assert.deepEqual(hintsFrom('Requires a bounded query.'), ['requires a bounded query'])
  assert.deepEqual(hintsFrom('Requires the search:confluence scopes.'), [])
  assert.deepEqual(hintsFrom(undefined), [])
  assert.deepEqual(hintsFrom('plain words'), [])
})

test('oversized hints are omitted while useful hints survive', () => {
  const long = `Requires a ${'very '.repeat(30)}bounded query.`
  const hints = hintsFrom(`${long} Defaults to \`${'x'.repeat(200)}\`. Maximum 50. Times are in Pacific Time.`)
  assert.deepEqual(hints, ['max 50', 'timezone Pacific Time'])
  for (const hint of hints) assert.ok(hint.length <= 80)
  // Exercise a recognized restriction near its parser boundary as well as
  // overlong text that should never become a hint.
  const bounded = hintsFrom(`Requires a ${'x'.repeat(35)} query.`)
  assert.equal(bounded.length, 1)
  assert.ok(bounded[0]!.length <= 80)
})

test('field hints appear on FieldSchema', () => {
  const ir = run(['type Query { """Requires a bounded query. Max 50.""" f: Int }'], '{ f }')
  assert.deepEqual(ir.roots[0]!.schema!.hints, ['max 50', 'requires a bounded query'])
})

test('max hint only when it describes the value itself', () => {
  assert.deepEqual(hintsFrom('It returns max 5000 issues.'), ['max 5000'])
  assert.deepEqual(hintsFrom('max 5000 issues'), ['max 5000'])
  assert.deepEqual(hintsFrom('Number of results (max 50).'), ['max 50'])
  assert.deepEqual(hintsFrom('Results per page, maximum is 25.'), ['max 25'])
  // A constraint about another clause is not this argument's max.
  assert.deepEqual(
    hintsFrom('A JQL query. Additionally, `orderBy` clause can contain a maximum of 7 fields.'),
    [],
  )
  assert.deepEqual(hintsFrom('Additionally, `orderBy` clause can contain a maximum of 7 fields.'), [])
})

test('a default hint is not shown on an argument the call set', () => {
  const sdl = ['type Query { f("Fields to return. The default is `id`." fields: [String!], "Page size. Maximum of `100`. Defaults to `10`." n: Int): R } type R { x: Int }']
  const set = run(sdl, '{ f(fields: ["a"], n: 5) { x } }').roots[0]!
  assert.equal(set.args.find(a => a.name === 'fields')!.hints, undefined)
  assert.deepEqual(set.args.find(a => a.name === 'n')!.hints, ['max 100'])
  const omitted = run(sdl, '{ f { x } }').roots[0]!.omittedArgs!
  assert.equal(omitted.find(a => a.name === 'fields')!.default, undefined)
  assert.equal(omitted.find(a => a.name === 'n')!.description!.includes('Defaults'), true)
})

test('a type condition equal to the parent type is not a branch; a real one is', () => {
  const sdl = ['type Query { s: Page } type Page { issues: [Node] } interface Node { id: ID } type Issue implements Node { id: ID key: String }']
  const op = 'fragment P on Page { issues { id ... on Issue { key } } } { s { ...P } }'
  const root = run(sdl, op).roots[0]!
  const issues = root.children.find(c => c.name === 'issues')!
  assert.equal(issues.onType, undefined)
  assert.equal(issues.coordinate, 'Page.issues')
  assert.equal(issues.schema?.type, '[Node]')
  assert.equal(issues.children.find(c => c.name === 'id')!.onType, undefined)
  assert.equal(issues.children.find(c => c.name === 'key')!.onType, 'Issue')
  assert.equal(issues.children.find(c => c.name === 'key')!.coordinate, 'Issue.key')
})

test('paging continues by a token field and names the flag separately', () => {
  const sdl = [
    'type Query { search(pageSize: Int, cursor: String): R jira(maxResults: Int, nextPageToken: String): J } type R { results: [A] hasMoreResults: Boolean cursor: String } type J { issues: [A] isLast: Boolean nextPageToken: String } type A { x: Int }',
  ]
  const g = run(sdl, '{ search { results { x } } }').roots[0]!
  assert.deepEqual(g.paging, { kind: 'cursor', via: ['cursor'], isFirstPage: true, moreField: 'cursor', flagField: 'hasMoreResults' })
  const j = run(sdl, '{ jira { issues { x } } }').roots[0]!
  assert.deepEqual(j.paging, { kind: 'token', via: ['nextPageToken'], isFirstPage: true, moreField: 'nextPageToken', flagField: 'isLast' })
})

const SLACK_PAGES = [
  'type Query { slack_searchMessages(query: String!, count: Int, page: Int): Slack_SearchMessagesResult }',
  'type Slack_SearchMessagesResult { query: String messages: Slack_SearchMessageResults }',
  'type Slack_SearchMessageResults { total: Int pagination: Slack_SearchPagination matches: [Slack_SearchMessageMatch!]! }',
  'type Slack_SearchMessageMatch { text: String }',
  'type Slack_SearchPagination { totalCount: Int page: Int perPage: Int pageCount: Int first: Int last: Int }',
]

test('page paging with a pagination object and the list one level down', async () => {
  const { pagingNote } = await import('../../src/view/paging.ts')
  const first = run(SLACK_PAGES, '{ slack_searchMessages(query: "a", count: 4) { messages { total matches { text } } } }').roots[0]!
  assert.deepEqual(first.paging, { kind: 'page', via: ['page'], isFirstPage: true, pageCountField: 'pageCount' })
  assert.equal(pagingNote(first.paging!), 'first page · next page: page ← page + 1 (of pageCount)')
  const later = run(SLACK_PAGES, '{ slack_searchMessages(query: "a", page: 2) { messages { total } } }').roots[0]!
  assert.equal(later.paging!.isFirstPage, false)
})
