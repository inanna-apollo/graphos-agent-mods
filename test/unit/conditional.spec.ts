import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { indexSdl, isOpaqueJson, requiresIncludeFrom, scopesFrom } from '../../src/schema.ts'
import { summaryOfDescription, tagsOf } from '../../src/view/kit.ts'
import { notesOf } from '../../src/view/notes.ts'
import { resultLines, shownScalars } from '../../src/view/outcome.ts'
import { returnLines } from '../../src/view/plan.ts'

const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

test('scopesFrom reads Scoped OAuth, OAuth scope(s) and Required scopes phrasings', () => {
  assert.deepEqual(scopesFrom('List incidents.\n\nScoped OAuth requires: `incidents.read`'), ['incidents.read'])
  assert.deepEqual(scopesFrom('Scoped OAuth requires: `incidents.read`, `incidents.write`'), ['incidents.read', 'incidents.write'])
  assert.deepEqual(scopesFrom('Scoped OAuth requires: `a.read` and `b.read`. More text.'), ['a.read', 'b.read'])
  assert.deepEqual(scopesFrom('OAuth scope: read:jira-work'), ['read:jira-work'])
  assert.deepEqual(scopesFrom('OAuth scopes: x:y, z:w'), ['x:y', 'z:w'])
  assert.deepEqual(scopesFrom('Required scopes: x:y, z:w\nOther line'), ['x:y', 'z:w'])
  // The existing Agent Services phrasing still works, and prose is not a scope.
  assert.deepEqual(scopesFrom('Requires the search:confluence and read:jira-work scopes.'), ['search:confluence', 'read:jira-work'])
  assert.deepEqual(scopesFrom('Required scopes: none really'), [])
})

test('summaryOfDescription: the body sentence, no repeated title, no boilerplate', () => {
  const raw =
    'List incidents\n\nList existing incidents.\n\nAn incident represents a problem.\n\nFor more information see the [API Concepts Document](../x#incidents)\n\nScoped OAuth requires: `incidents.read`'
  assert.equal(summaryOfDescription(raw), 'List existing incidents.')
  assert.equal(summaryOfDescription('Search pages.  Needs\n a   query. Returns: hits'), 'Search pages.')
  assert.equal(summaryOfDescription('For more information see x. Scoped OAuth requires: `a.b`'), undefined)
  assert.equal(summaryOfDescription('Get a thing\n\nFetch one record by id.'), 'Get a thing')
  assert.equal(summaryOfDescription('Requires the a:b scope. Lists spaces.'), 'Lists spaces.')
  assert.equal(summaryOfDescription(undefined), undefined)
  assert.match(summaryOfDescription('Hi \u001b[31mred') ?? '', /\\x1b/)
})

test('requiresIncludeFrom and isOpaqueJson read field descriptions', () => {
  assert.deepEqual(requiresIncludeFrom('Only returned if the `include[]=body` query parameter is provided.'), { arg: 'include', value: 'body', mode: 'only' })
  assert.deepEqual(requiresIncludeFrom('The service. If the `include[]=services` query parameter is provided, the full service definition will be returned.'), {
    arg: 'include',
    value: 'services',
    mode: 'full',
  })
  assert.equal(requiresIncludeFrom('Plain description.'), undefined)
  assert.equal(isOpaqueJson('Pagerduty_JSON', undefined), true)
  assert.equal(isOpaqueJson('JSON', undefined), true)
  assert.equal(isOpaqueJson('String', 'Opaque JSON blob'), true)
  assert.equal(isOpaqueJson('String', 'Polymorphic schema (oneOf/anyOf) -- not yet modeled as a GraphQL union.'), true)
  assert.equal(isOpaqueJson('String', 'Plain'), false)
})

const SDL = [
  'type Query { pd_list(limit: Int, offset: Int, include: String): Resp }',
  'type Resp { """Echoes limit pagination property.""" limit: Int more: Boolean offset: Int total: Int items: [Item!]! }',
  `type Item {
    id: ID
    """Only returned if the \`include[]=body\` query parameter is provided."""
    body: String
    """If the \`include[]=services\` query parameter is provided, the full service definition will be returned."""
    service: PD_JSON
  }`,
]
const irOf = (query: string) =>
  annotate(buildIR('t', normalize(query, {})), { schema: indexSdl(SDL), validation: { valid: true, diagnostics: [] }, scope: 'pd', isIncomplete: false })
const FIELDS = '{ items { id body service } more total limit offset }'

test('annotation carries requiresInclude and isOpaque', () => {
  const root = irOf(`query Q { pd_list(limit: 5) ${FIELDS} }`).roots[0]!
  const items = root.children.find(child => child.name === 'items')!
  assert.deepEqual(items.children.find(c => c.name === 'body')?.schema?.requiresInclude, { arg: 'include', value: 'body', mode: 'only' })
  assert.equal(items.children.find(c => c.name === 'service')?.schema?.isOpaque, true)
})

test('tags and notes follow the root include argument', () => {
  const unset = irOf(`query Q { pd_list(limit: 5) ${FIELDS} }`)
  const root = unset.roots[0]!
  const items = root.children.find(child => child.name === 'items')!
  const [body, service] = [items.children[1]!, items.children[2]!]
  assert.deepEqual(tagsOf(root, body), [{ text: ' · only with include=body', isWarn: true }])
  assert.deepEqual(tagsOf(root, service), [
    { text: '  untyped JSON', isWarn: false },
    { text: ' · reference only (full with include=services)', isWarn: false },
  ])
  const texts = notesOf(unset).map(note => note.text)
  assert.ok(texts.some(text => text === "body won't be returned: set include=body"))
  assert.ok(texts.some(text => text.startsWith('service is a reference only: set include=services')))
  // Given include=body, body is quiet; a list value counts too.
  const given = irOf(`query Q { pd_list(limit: 5, include: "body,services") ${FIELDS} }`)
  const g = given.roots[0]!
  assert.deepEqual(tagsOf(g, g.children[0]!.children[1]!), [])
  assert.ok(!notesOf(given).some(note => /include=/.test(note.text)))
  const listed = irOf(`query Q { pd_list(limit: 5, include: ["body"]) ${FIELDS} }`)
  assert.deepEqual(tagsOf(listed.roots[0]!, listed.roots[0]!.children[0]!.children[1]!), [])
  // The RETURNS lines carry the tags, the tagged leaves on rows of their own.
  const lines = returnLines(root)
  assert.ok(lines.some(line => line.tags !== undefined && line.fields.length === 1 && line.fields[0]?.name === 'service'))
})

test('a denied field gets one notes line of its own: its name, then `denied`', () => {
  const ir = irOf(`query Q { pd_list(limit: 5) ${FIELDS} }`)
  const denied = { ...ir, roots: ir.roots.map(root => ({ ...root, children: root.children.map(child => (child.name === 'more' ? { ...child, policy: 'deny' as const } : child)) })) }
  const lines = notesOf(denied).filter(note => note.text === 'more')
  assert.equal(lines.length, 1)
  assert.match(lines[0]?.detail ?? '', /^denied/)
  assert.ok(!notesOf(denied).some(note => /field denied/.test(note.text)))
})

test('RESULT scalars: echoes and nulls are hidden, the more flag reads in words', () => {
  const ir = irOf(`query Q { pd_list(limit: 5) ${FIELDS} }`)
  const outcome = outcomeOf(ir, mcp({ data: { pd_list: { items: [{ id: '1' }], more: true, total: null, limit: 5, offset: 0 } } }))
  assert.deepEqual(shownScalars(outcome, ir).map(one => one.field), ['more'])
  const lines = resultLines(outcome, ir)
  // Count, then the items in words, by number: one row is `1 item`.
  assert.deepEqual(lines.find(line => line.kind === 'rows'), { kind: 'rows', field: '', text: '1 item', note: 'first page · more available' })
  assert.ok(!lines.some(line => line.kind === 'scalar'))
  // A described echo is hidden whatever its value; an undescribed offset of 0 that was never set is one too.
  const other = outcomeOf(ir, mcp({ data: { pd_list: { items: [], limit: 10, offset: 0 } } }))
  assert.deepEqual(shownScalars(other, ir), [])
  const last = outcomeOf(ir, mcp({ data: { pd_list: { more: false } } }))
  assert.deepEqual(resultLines(last, ir).filter(line => line.kind === 'scalar'), [{ kind: 'scalar', field: '', text: 'last page' }])
})

test('a root that returns only a null scalar keeps it; isLast reads as a page', () => {
  const ir = buildIR('c', normalize('query C { jira_countIssues(jql: "x") { count } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { jira_countIssues: { count: null } } }))
  assert.deepEqual(resultLines(outcome, ir).filter(line => line.kind === 'scalar'), [{ kind: 'scalar', field: 'count', text: 'none returned', isDim: true }])
  const page = buildIR('p', normalize('query P { s(q: "x") { isLast } }', {}))
  assert.deepEqual(resultLines(outcomeOf(page, mcp({ data: { s: { isLast: false } } })), page).filter(line => line.kind === 'scalar'), [
    { kind: 'scalar', field: '', text: 'more results available' },
  ])
  assert.deepEqual(resultLines(outcomeOf(page, mcp({ data: { s: { isLast: true } } })), page).filter(line => line.kind === 'scalar'), [
    { kind: 'scalar', field: '', text: 'last page' },
  ])
})

test('preview rows prefer a created/updated date over the status', () => {
  const ir = buildIR('p', normalize('query P { items { id } }', {}))
  for (const key of ['created_at', 'createdAt', 'updated_at', 'updatedAt', 'created', 'last_status_change_at', 'timestamp']) {
    const outcome = outcomeOf(ir, mcp({ data: { items: [{ title: 'T', status: 'open', [key]: '2026-10-02T07:00:00Z' }] } }))
    assert.equal(outcome.preview?.[0]?.items[0]?.extra, 'Oct 2 2026', key)
  }
})
