import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { argKind, classificationNote, serviceFacts, typeSaid, valuesBack } from '../../src/view/card-facts.ts'
import { CLOSED } from '../../src/view/kit.ts'
import { notesOf } from '../../src/view/notes.ts'
import { flowLayout, planOf, seamRows } from '../../src/view/plan.ts'
import { productOf } from '../../src/view/flags.ts'
import { humanPlural, humanSingular, humanType } from '../../src/view/kit.ts'
import { continuationArg, pagingNote, pagingRole } from '../../src/view/paging.ts'

test('humanType drops Java-ish wrapper suffixes but keeps Response', () => {
  assert.equal(humanType('Jira_IssueBean'), 'issue')
  assert.equal(humanPlural(humanType('[Jira_IssueBean!]')), 'issues')
  assert.equal(humanType('Foo_UserDTO'), 'user')
  assert.equal(humanType('Foo_UserDto'), 'user')
  assert.equal(humanType('Foo_ThingImpl'), 'thing')
  assert.equal(humanType('Glean_SearchResponse'), 'search response')
  assert.equal(humanType('Confluence_SearchResultItem'), 'search result item')
  assert.equal(humanType('Bean'), 'bean')
})

test('an opaque JSON scalar is untyped JSON everywhere the pane names it: in words, in a card, and as an argument kind', () => {
  // By its name: JSON, or a service's *_JSON, wherever the marks are.
  for (const sdl of ['JSON', 'Jira_JSON', 'Jira_JSON!', '[Jira_JSON!]!', 'acme_JSON']) assert.equal(humanType(sdl), 'untyped JSON', sdl)
  assert.equal(humanPlural(humanType('[Jira_JSON]')), 'untyped JSON values')
  assert.equal(humanPlural(humanType('Jira_JSON'), 1), 'untyped JSON')
  // Not a name that only holds the letters.
  assert.notEqual(humanType('Jira_JSONResult'), 'untyped JSON')
  assert.notEqual(humanType('Foo_Jsonish'), 'untyped JSON')
  // A card's type in words never says `a Jira_JSON`.
  assert.match(typeSaid('Jira_JSON'), /untyped JSON.*may be null/)
  assert.match(typeSaid('JSON!'), /untyped JSON.*never null/)
  assert.match(typeSaid('[Jira_JSON!]!'), /list.*never null.*untyped JSON.*never null/)
  // A scalar the schema says is opaque JSON, whatever its name.
  assert.match(typeSaid('Glean_Any', undefined, true), /untyped JSON.*may be null/)
  assert.match(typeSaid('Glean_Any'), /Glean_Any.*may be null/)
  // An argument of it, an object set or not, takes untyped JSON rather than an input object.
  const root = buildIR('t', normalize('mutation M { jira_editIssue(issueIdOrKey: "DEV-1") }', {})).roots[0]!
  assert.match(argKind({ name: 'fields', type: 'Jira_JSON', value: { summary: 'x' } }, root) ?? '', /^untyped JSON: /)
  assert.match(argKind({ name: 'update', type: 'JSON!' }, root) ?? '', /^untyped JSON: /)
  assert.match(argKind({ name: 'input', type: 'Foo_Input', value: { a: 1 } }, root) ?? '', /^an input object/)
})

test('a service reads by its product name, else its scope in sentence case; its scope id is said only where it adds something', () => {
  assert.equal(productOf('jira'), 'Jira')
  assert.equal(productOf('incidentio'), 'incident.io')
  assert.equal(productOf('acme-customer-data'), 'Acme customer data')
  assert.equal(productOf('acme_customer_data'), 'Acme customer data')
  assert.equal(productOf(''), undefined)
  assert.equal(productOf(undefined), undefined)
  // A scope named like an object's own key is still words, never the key's value.
  for (const scope of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(typeof productOf(scope), 'string', scope)
  const ir = buildIR('t', normalize('query Q { jira_search(jql: "x") { total } incidentio_list { id } acme_customer_data_members { id } other_thing { id } }', {}))
  const services = ['jira', 'incidentio', 'acme-customer-data', 'other-scope']
  ir.roots.forEach((root, index) => (root.service = services[index]))
  assert.deepEqual(serviceFacts(ir).map(one => one.service), ['Jira', 'incident.io', 'Acme customer data', 'Other scope'])
})

test("paging reads a response field named like an object's own member (constructor, toString) as no paging field, never throwing", () => {
  const ir = buildIR('t', normalize('query Q { x_list(cursor: "a") { items { id } constructor toString __proto__: id valueOf } }', {}))
  const root = ir.roots[0]!
  for (const field of root.children) {
    assert.doesNotThrow(() => continuationArg(field, root), field.name)
    assert.equal(continuationArg(field, root), undefined, field.name)
    assert.doesNotThrow(() => pagingRole(field, root, root), field.name)
  }
})

test('a name wraps at a word boundary beside its alias, or moves whole when no boundary fits', () => {
  const name = 'acme_customer_data_listOrganizationMembers'
  const rows = seamRows(name, 38) ?? []
  assert.equal(rows.join(''), name)
  assert.ok(rows.length === 2 && rows.every(row => row.length <= 38), rows.join(' / '))
  assert.equal(seamRows('abcdefghijklmnopqrstu', 8), undefined)
  assert.equal(seamRows('short', 10), undefined)
  // `members: ` then the name, at 47 cells: the name breaks beside the alias, on the alias's row.
  const items = ['', '', 'members: ', { text: name, name: 'members' }]
  const { places, spots } = flowLayout(items, 47)
  assert.equal(places[3]?.row, 0)
  assert.deepEqual(spots[3]?.rows, seamRows(name, 38))
  // A name with no word boundary at the available width moves whole.
  const seamless = flowLayout(['members: ', { text: 'x'.repeat(42), name: 'members' }], 47)
  assert.equal(seamless.places[1]?.row, 1)
  assert.equal(seamless.spots[1]?.rows, undefined)
  // A second name on a line moves whole to the next: only the first would leave a lead-in alone.
  const second = flowLayout([{ text: 'id', name: 'a.id' }, ' · ', { text: 'listOrganization', name: 'a.b' }], 20)
  assert.equal(second.spots[2]?.rows, undefined)
})

test("a field's classification is said one way: the schema's, else the one Agent Services gave its denial", () => {
  const field = { name: 'email', coordinate: 'Member.email', path: 'members.email', args: [], children: [], policy: 'deny' as const }
  const outcome = { rows: [], authLinks: [], errors: [{ message: '', isDenied: true, field: 'email', classification: 'pii-high', isRequestable: true }] } as never
  assert.equal(classificationNote(field, outcome), 'classified pii-high · requestable')
  assert.equal(classificationNote(field, outcome, false), 'classified pii-high')
  const classified = { ...field, schema: { type: 'String', isList: false, scopes: [], tags: [], hints: ['classified pii.contact'] } }
  assert.equal(classificationNote(classified as never, outcome), 'classified pii.contact · requestable')
})

test('what came back for a field names its values whole, four when one would be left, never ending in …', () => {
  const field = { name: 'name', coordinate: 'Member.name', path: 'members.name', args: [], children: [], policy: 'allow' as const }
  const parent = { name: 'members', coordinate: 'Query.members', path: 'members', args: [], children: [field], policy: 'allow' as const }
  const rows = (count: number) => ({ rows: [], authLinks: [], errors: [], preview: [{ field: 'members', items: Array.from({ length: count }, (_, i) => ({ label: `m${i}`, fields: [{ name: 'name', value: `A rather long member name number ${i} that would have been cut at forty` }] })), more: 0 }] }) as never
  const four = valuesBack(field, parent, rows(4)) ?? ''
  assert.match(four, /^4 of the 4 rows shown: /)
  assert.ok(four.includes('number 3 that would have been cut at forty'))
  assert.doesNotMatch(four, /…|more/)
  const five = valuesBack(field, parent, rows(5)) ?? ''
  assert.match(five, /, and 2 more$/)
  assert.doesNotMatch(five, /…/)
})

test("a call that already ran never says checking policy, even while its checks are still out; its unread type says so rather than a blank row", () => {
  const ir = buildIR('t', normalize('query Keys { jira_searchIssues(jql: "project = DEV") { issues { key } } }', {}))
  assert.equal(ir.state, 'analyzing')
  assert.ok(notesOf(ir).some(note => note.text === 'checking policy…'))
  assert.ok(!notesOf(ir, () => false, true).some(note => note.text === 'checking policy…'))
  const plan = planOf(ir, { rows: Infinity, columns: 64, isPending: false, open: CLOSED, now: 0 })
  assert.equal(plan.roots[0]?.returns.lead, 'type not read yet')
  assert.equal(plan.roots[0]?.returns.isLeadUnread, true)
})

test('the paging line names the continuation and mentions the flag separately', () => {
  for (const [kind, argument, flag, condition] of [
    ['cursor', 'cursor', 'hasMoreResults', 'while'],
    ['token', 'nextPageToken', 'isLast', 'until'],
  ] as const) {
    const note = pagingNote({ kind, via: [argument], isFirstPage: true, moreField: argument, flagField: flag })
    for (const fact of ['first page', argument, flag, condition]) assert.ok(note.includes(fact), note)
  }
  const note = pagingNote({ kind: 'cursor', via: ['cursor'], isFirstPage: true, moreField: 'next' })
  for (const fact of ['cursor', 'next']) assert.ok(note.includes(fact), note)
})

test('a list\'s name for one of its items: nouns that end in s keep it', () => {
  assert.equal(humanSingular('statuses'), 'status')
  assert.equal(humanSingular('incident statuses'), 'incident status')
  assert.equal(humanSingular('incidentStatuses'), 'incidentStatus')
  assert.equal(humanSingular('aliases'), 'alias')
  assert.equal(humanSingular('issues'), 'issue')
  assert.equal(humanSingular('cases'), 'case')
  assert.equal(humanSingular('responses'), 'response')
  assert.equal(humanSingular('addresses'), 'address')
  assert.equal(humanSingular('entries'), 'entry')
  assert.equal(humanSingular('status'), 'status')
  // And it round-trips with the plural.
  for (const word of ['status', 'alias', 'issue', 'match', 'entry']) assert.equal(humanSingular(humanPlural(word)), word)
})

test('a later page is not said for a paging argument set to the start', () => {
  const first = pagingNote({ kind: 'offset', via: ['startAt'], isFirstPage: true })
  assert.match(first, /first page/)
  assert.ok(first.includes('startAt'))
  assert.match(pagingNote({ kind: 'offset', via: ['startAt'], isFirstPage: false }), /^a later page/)
})
