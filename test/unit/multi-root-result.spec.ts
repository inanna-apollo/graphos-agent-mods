import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { indexSdl } from '../../src/schema.ts'
import { cameBack } from '../../src/view/card-facts.ts'
import { flagsOf } from '../../src/view/flags.ts'
import { humanType, limitOf } from '../../src/view/kit.ts'
import { notesOf } from '../../src/view/notes.ts'
import { failureCount, resultLines } from '../../src/view/outcome.ts'
import { linkLabel, returnLines } from '../../src/view/plan.ts'

const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

const OPERATION = `query Four {
  open: jira_searchAndReconsileIssuesUsingJql(jql: "x", maxResults: 3) { issues { key } isLast }
  total: jira_countIssues(jql: "x") { count }
  incidents: incidentio_incidents(pageSize: 3) { name createdAt }
  members: acme_customer_data_listOrganizationMembers { id name email }
}`

const irOf = () => {
  const ir = buildIR('m', normalize(OPERATION, {}))
  const [, , incidents, members] = ir.roots
  if (incidents) incidents.schema = { type: '[IncidentIO_Incident]', isList: true } as never
  if (members) {
    members.schema = { type: '[Customer_Data_Member]', isList: true } as never
    members.service = 'acme-customer-data'
  }
  return ir
}

// The response lists roots in discovery order, not the operation's.
const response = {
  data: {
    incidents: [{ name: 'A', createdAt: '2026-10-06T00:00:00Z' }],
    members: [{ id: 'mem_leo', email: null }],
    total: { count: null },
    open: { issues: [{ key: 'DEV-634', fields: { summary: 'Fix the thing', status: { name: 'Open' } } }], isLast: false },
  },
}

test('RESULT blocks follow root order and are headed by alias when there are several roots', () => {
  const ir = irOf()
  const lines = resultLines(outcomeOf(ir, mcp(response)), ir)
  const heads = lines.flatMap(line => ((line.kind === 'rows' || line.kind === 'scalar') && line.field !== '' ? [line.field.split('  ')[0]] : []))
  assert.deepEqual(heads, ['open', 'total', 'incidents', 'members'])
  const rows = lines.flatMap(line => (line.kind === 'rows' ? [`${line.field}  ${line.text}`] : []))
  // Under a head that already names the items, the count stands alone.
  assert.ok(rows.includes('incidents  1'), rows.join('|'))
  assert.ok(rows.includes('members  1'), rows.join('|'))
  // Count, then the list's items in words, by number.
  assert.ok(rows.includes('open  1 issue'), rows.join('|'))
  const total = lines.find(line => line.kind === 'scalar' && line.field.startsWith('total'))
  assert.ok(total?.kind === 'scalar' && total.text === 'none returned' && total.isDim === true)
})

test('a single root keeps its output without a head', () => {
  const ir = buildIR('s', normalize('query S { jira_countIssues(jql: "x") { count } }', {}))
  // The context line closing RESULT is not what this is about.
  const lines = resultLines(outcomeOf(ir, mcp({ data: { jira_countIssues: { count: null } } })), ir).filter(line => line.kind !== 'weight')
  assert.deepEqual(lines, [{ kind: 'scalar', field: 'count', text: 'none returned', isDim: true }])
})

test('a root that came back null says none returned, dim, alone or under its head; never `null` as a value', () => {
  const single = buildIR('n', normalize('query N { acme_order(id: "1") { id total } }', {}))
  const lines = resultLines(outcomeOf(single, mcp({ data: { acme_order: null } })), single).filter(line => line.kind !== 'weight')
  assert.deepEqual(lines, [{ kind: 'scalar', field: 'acme_order', text: 'none returned', isDim: true }])
  const two = buildIR('t', normalize('query T { a: acme_order(id: "1") { id } b: acme_order(id: "2") { id } }', {}))
  const both = resultLines(outcomeOf(two, mcp({ data: { a: null, b: { id: 'ord_2' } } })), two).filter(line => line.kind === 'scalar')
  assert.deepEqual(both.find(line => line.kind === 'scalar' && line.field === 'a'), { kind: 'scalar', field: 'a', text: 'none returned', isDim: true })
  assert.ok(!both.some(line => line.kind === 'scalar' && line.text === 'null'), JSON.stringify(both))
  // A root whose value is a scalar still says it.
  const count = buildIR('c', normalize('query C { acme_count }', {}))
  assert.deepEqual(resultLines(outcomeOf(count, mcp({ data: { acme_count: 7 } })), count).filter(line => line.kind === 'scalar'), [{ kind: 'scalar', field: 'acme_count', text: '7' }])
})

test('an id-like key labels the row and its nested summary is the text', () => {
  const ir = irOf()
  const item = outcomeOf(ir, mcp(response)).preview?.find(one => one.field === 'issues')?.items[0]
  assert.equal(item?.label, 'DEV-634')
  assert.equal(item?.text, 'Fix the thing')
  const line = resultLines(outcomeOf(ir, mcp(response)), ir).find(one => one.kind === 'preview' && one.field === 'issues')
  assert.ok(line?.kind === 'preview' && line.items[0]?.text === 'Fix the thing')
  const plain = outcomeOf(ir, mcp({ data: { open: { issues: [{ key: 'some words', fields: { summary: 'S' } }] } } })).preview?.[0]?.items[0]
  assert.equal(plain?.text, undefined)
})

test('humanType drops the service words that lead a type', () => {
  assert.equal(humanType('Customer_Data_Member', 'acme-customer-data'), 'member')
  assert.equal(humanType('[CustomerDataMember!]', 'acme-customer-data'), 'member')
  assert.equal(humanType('Data', 'acme-customer-data'), 'data')
})

test('policy denials are not counted as errors; real failures are', () => {
  const denied = { message: 'no', isDenied: true, isExpected: true, count: 4 }
  const failed = { message: 'boom', code: 'INTERNAL', count: 2 }
  assert.equal(failureCount({ errors: [denied] } as never), 0)
  assert.equal(failureCount({ errors: [denied, { message: 'x', isDenied: true }, failed] } as never), 2)
})

test('an outcome stored before row attribution draws its denials on the rows, like a new one', () => {
  const ir = irOf()
  const outcome = outcomeOf(ir, mcp({ data: { members: [{ id: 'mem_leo', name: 'Leo', email: null }, { id: 'mem_sam', name: 'Sam', email: null }] } }))
  const old = {
    ...outcome,
    errors: [0, 1].map(index => ({ message: '', path: `members.${index}.email`, field: 'email', isDenied: true, isExpected: true, classification: 'pii-high', isRequestable: true })),
  }
  const lines = resultLines(old, ir)
  assert.ok(!lines.some(line => line.kind === 'error'), 'no standalone denial lines')
  const preview = lines.find(line => line.kind === 'preview')
  assert.ok(preview?.kind === 'preview')
  assert.deepEqual(preview.items.map(item => item.denied?.map(one => one.field)), [['email'], ['email']])
  // The stored outcome is left as it was.
  assert.equal(old.errors.length, 2)
})

test('two roots whose lists share a field name each show their own rows, under their own keys', () => {
  const ir = buildIR('t', normalize('query T { open: jira_search(jql: "a") { issues { key } } closed: jira_search(jql: "b") { issues { key } } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { open: { issues: [{ key: 'DEV-1' }] }, closed: { issues: [{ key: 'DEV-2' }, { key: 'DEV-3' }] } } }))
  const lines = resultLines(outcome, ir)
  const rows = lines.flatMap(line => (line.kind === 'rows' ? [`${line.field}  ${line.text}`] : []))
  assert.deepEqual(rows, ['open  1 issue', 'closed  2 issues'])
  const previews = lines.flatMap(line => (line.kind === 'preview' ? [{ root: line.root, labels: line.items.map(item => item.label) }] : []))
  assert.deepEqual(previews, [
    { root: 'open', labels: ['DEV-1'] },
    { root: 'closed', labels: ['DEV-2', 'DEV-3'] },
  ])
})

test('a denial stored before row attribution lands on the row it came from, though an unlabelled item was skipped', () => {
  const ir = irOf()
  // The first member has no label (no name, no id): the preview skips it, so response index 1 is the first row shown.
  const outcome = outcomeOf(ir, mcp({ data: { members: [{ email: null }, { id: 'mem_leo', name: 'Leo', email: null }, { id: 'mem_sam', name: 'Sam', email: null }] } }))
  const old = { ...outcome, errors: [{ message: '', path: 'members.2.email', field: 'email', isDenied: true, isExpected: true }] }
  const preview = resultLines(old, ir).find(line => line.kind === 'preview')
  assert.ok(preview?.kind === 'preview')
  assert.deepEqual(preview.items.map(item => [item.label, item.denied?.map(one => one.field) ?? []]), [['Leo', []], ['Sam', ['email']]])
})

// ---- Aliases of one field are two roots

const ALIASED = 'query Counts { open: jira_countIssues(jql: "project = DEV AND status = Open") { count } closed: jira_countIssues(jql: "project = DEV AND status = Done") { count } }'

test('two aliases of one field each show their own value', () => {
  const ir = buildIR('a', normalize(ALIASED, {}))
  const outcome = outcomeOf(ir, mcp({ data: { open: { count: 5 }, closed: { count: 9 } } }))
  const lines = resultLines(outcome, ir)
  const said = lines.flatMap(line => (line.kind === 'scalar' ? [`${line.field}=${line.text}`] : []))
  assert.deepEqual(said, ['open=5', 'closed=9'])
  // The card of each root's `count` says that root's value.
  const [open, closed] = ir.roots
  assert.deepEqual(cameBack(open!.children[0]!, outcome), ['value 5'])
  assert.deepEqual(cameBack(closed!.children[0]!, outcome), ['value 9'])
})

test('a deep link says the count of the root whose search it opens', () => {
  const ir = buildIR('a', normalize(ALIASED, {}))
  const outcome = outcomeOf(ir, mcp({ data: { open: { count: 5 }, closed: { count: 9 } } }))
  const link = { label: 'Open in Jira', url: `https://acme.example/issues/?jql=${encodeURIComponent('project = DEV AND status = Done')}` }
  const label = linkLabel(link, ir, outcome, true)
  assert.match(label, /^9 issues in Jira/)
  assert.doesNotMatch(label, /\b5\b/)
})

test('a deep link counts what says how many exist, not the first number in the response', () => {
  const ir = buildIR('s', normalize('query S { jira_search(jql: "project = DEV") { startAt issues { key } } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { jira_search: { startAt: 0, issues: [{ key: 'DEV-1' }] } } }))
  const link = { label: 'Open in Jira', url: `https://acme.example/issues/?jql=${encodeURIComponent('project = DEV')}` }
  const label = linkLabel(link, ir, outcome, false)
  assert.doesNotMatch(label, /^0 /)
  assert.match(label, /^this search in Jira/)
})

// ---- The list a limit governs

const SEARCH_SDL = [
  'type Query { jira_search(jql: String, maxResults: Int): Jira_Results incidentio_things(size: Int, page: Int): [Thing] }',
  'type Jira_Results { facets: [Jira_Facet] issues: [Jira_Issue] }',
  'type Jira_Facet { name: String }',
  'type Jira_Issue { key: String }',
  'type Thing { name: String }',
]
const searchIr = (operation: string) => annotate(buildIR('l', normalize(operation, {})), { schema: indexSdl(SEARCH_SDL), scope: 'jira', isIncomplete: false })

test('an over-limit flag is about the rows the limit governs, not a facet list beside them', () => {
  const ir = searchIr('query L { jira_search(jql: "x", maxResults: 3) { facets { name } issues { key } } }')
  const response = { data: { jira_search: { facets: Array.from({ length: 8 }, (_, i) => ({ name: `f${i}` })), issues: [{ key: 'A-1' }, { key: 'A-2' }, { key: 'A-3' }] } } }
  const outcome = outcomeOf(ir, mcp(response))
  assert.equal(outcome.rows[0]?.field, 'issues')
  assert.equal(outcome.rows[0]?.count, 3)
  assert.deepEqual(flagsOf(ir, outcome, true).filter(flag => /returned/.test(flag.text)), [])
  // The same without a schema to name the list.
  const bare = buildIR('l', normalize('query L { jira_search(jql: "x", maxResults: 3) { facets { name } issues { key } } }', {}))
  const bareOutcome = outcomeOf(bare, mcp(response))
  assert.equal(bareOutcome.rows[0]?.field, 'issues')
  // And a real overshoot of the governed list is still said.
  const over = outcomeOf(ir, mcp({ data: { jira_search: { facets: [{ name: 'f' }], issues: Array.from({ length: 7 }, (_, i) => ({ key: `A-${i}` })) } } }))
  assert.match(flagsOf(ir, over, true).find(flag => /returned/.test(flag.text))?.text ?? '', /returned 7 \(asked 3\)/)
})

test('the return tree says what the call asks for, on the one list it governs', () => {
  const ir = searchIr('query L { jira_search(jql: "x", maxResults: 3) { facets { name } issues { key } } }')
  const notes = returnLines(ir.roots[0]!).flatMap(line => (line.head === undefined || line.note === undefined ? [] : [[line.head.name, line.note]]))
  assert.deepEqual(notes.map(([name]) => name), ['facets', 'issues'])
  assert.match(notes[1]?.[1] ?? '', /^asks for 3 /)
  assert.doesNotMatch(notes[0]?.[1] ?? '', /\d/)
})

test('size and take are limits wherever the pane reads one', () => {
  const ir = searchIr('query L { incidentio_things(size: 20) { name } }')
  assert.equal(limitOf(ir.roots[0]!), 20)
  assert.ok(!notesOf(ir).some(note => note.text.startsWith('no limit')))
  const unset = searchIr('query L { incidentio_things { name } }')
  assert.ok(notesOf(unset).some(note => note.text.startsWith('no limit')))
})

// ---- Services

test('an over-limit flag on a root no scope claimed names that root\'s own product', () => {
  const ir = buildIR('o', normalize('query O { jira_search(jql: "x", maxResults: 1) { issues { key } } slack_things(limit: 1) { name } }', {}))
  // The first root was resolved to Jira; the second was left unclaimed.
  const roots = [{ ...ir.roots[0]!, service: 'jira' }, ir.roots[1]!]
  const resolved = { ...ir, service: 'jira', roots }
  const outcome = outcomeOf(resolved, mcp({ data: { jira_search: { issues: [{ key: 'A-1' }] }, slack_things: [{ name: 'a' }, { name: 'b' }] } }))
  const flag = flagsOf(resolved, outcome, true).find(one => /returned/.test(one.text))
  assert.match(flag?.text ?? '', /^Slack returned/)
})
