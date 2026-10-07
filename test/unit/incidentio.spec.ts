// The incident.io shape: verb fallback, people marked once, argument-name cap, view-time scalar filtering.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { attentionOf } from '../../src/attention.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { indexSdl } from '../../src/schema.ts'
import { rootVerb, tagsOf } from '../../src/view/kit.ts'
import { notesOf } from '../../src/view/notes.ts'
import { resultLines, shownScalars } from '../../src/view/outcome.ts'
import { argNameMax } from '../../src/view/ui/theme.ts'

const OP = `query RecentIncidents($size: Int) { incidentio_incidents(pageSize: $size, statusCategory: ["live","closed"]) { reference name createdAt severity { name rank } incidentStatus { name category } creator { user { name email } } incidentRoleAssignments { role { name } assignee { name email } } } }`
const SDL = [
  `type Query { "List all incidents for an organisation." incidentio_incidents(pageSize: Int, statusCategory: [String]): [IncidentIO_Incident] }`,
  `type IncidentIO_Incident { reference: String! name: String! createdAt: String! severity: IncidentIO_Severity incidentStatus: IncidentIO_Status creator: IncidentIO_Actor incidentRoleAssignments: [IncidentIO_IncidentRoleAssignment] }`,
  `type IncidentIO_Severity { name: String! rank: Int! } type IncidentIO_Status { name: String! category: String! }`,
  `type IncidentIO_Actor { user: IncidentIO_UserSlim } type IncidentIO_UserSlim { id: ID! name: String! email: String }`,
  `type IncidentIO_IncidentRoleAssignment { role: IncidentIO_IncidentRoleEmbed assignee: IncidentIO_UserSlim } type IncidentIO_IncidentRoleEmbed { name: String! }`,
]
const arrival = () => buildIR('t', normalize(OP, { size: 4 }))
const enriched = () => annotate(arrival(), { schema: indexSdl(SDL), isIncomplete: false })

test('verb falls back by shape: LIST, GET, COUNT, CALL; never blank', () => {
  assert.equal(rootVerb(enriched().roots[0]!, 'query'), 'LIST')
  const one = annotate(buildIR('t', normalize('query Q { acme_widget { id } }', {})), { schema: indexSdl(['type Query { acme_widget: Acme_Widget } type Acme_Widget { id: ID }']), isIncomplete: false })
  assert.equal(rootVerb(one.roots[0]!, 'query'), 'GET')
  assert.equal(rootVerb(buildIR('t', normalize('query Q { acme_tally { total } }', {})).roots[0]!, 'query'), 'COUNT')
  assert.equal(rootVerb(buildIR('t', normalize('mutation Q { acme_ping { ok } }', {})).roots[0]!, 'mutation'), 'CALL')
  assert.equal(rootVerb(buildIR('t', normalize('query Q { acme_search { id } }', {})).roots[0]!, 'query'), 'SEARCH')
})

test('a root name with no service prefix keeps its first word: deleteUser is DELETE, not CALL', () => {
  const verb = (name: string, opType: 'query' | 'mutation' = 'mutation') => rootVerb(buildIR('t', normalize(`${opType} Q { ${name} { id } }`, {})).roots[0]!, opType)
  assert.equal(verb('deleteUser'), 'DELETE')
  assert.equal(verb('createOrder'), 'CREATE')
  assert.equal(verb('updateInvoiceStatus'), 'UPDATE')
  assert.equal(verb('searchProducts', 'query'), 'SEARCH')
  // A service prefix is still skipped, so the service's name is never read as a verb.
  assert.equal(verb('send_status'), 'CALL')
  assert.equal(verb('acme_customer_data_deleteRecord'), 'DELETE')
  assert.equal(verb('jira_createIssue'), 'CREATE')
  // A name that only starts or ends with `_` has no prefix.
  assert.equal(verb('_deleteAll'), 'DELETE')
  assert.equal(verb('ping'), 'CALL')
})

test('people are tagged once; only the email leaves get the triangle', () => {
  const ir = enriched()
  // Marks are by coordinate: both email leaves share it, so both draw the triangle.
  assert.deepEqual(attentionOf(ir).map(one => one.coordinate), ['IncidentIO_UserSlim.email'])
  const root = ir.roots[0]!
  const creator = root.children.find(child => child.name === 'creator')!
  assert.deepEqual(tagsOf(root, creator).map(tag => tag.text), ['  person'])
  assert.deepEqual(tagsOf(root, creator.children[0]!).map(tag => tag.text), ['  person'])
  const status = root.children.find(child => child.name === 'incidentStatus')!
  assert.deepEqual(tagsOf(root, status), [])
  // Without a schema the person names still read as people.
  assert.deepEqual(tagsOf(arrival().roots[0]!, arrival().roots[0]!.children.find(child => child.name === 'creator')!).map(tag => tag.text), ['  person'])
})

test('the note lists field names with short parent paths', () => {
  const note = notesOf(enriched()).find(one => one.text === 'email')
  assert.equal(note?.detail, 'personal data · creator.user · assignee')
})

test('a top-level email scalar is still personal data', () => {
  const ir = buildIR('t', normalize('query Q { acme_me { email } }', {}))
  assert.deepEqual(attentionOf(ir).map(one => one.reason), ['personal data'])
  assert.equal(notesOf(ir).find(one => one.text === 'email')?.detail, 'personal data')
  const top = buildIR('t', normalize('query Q { email }', {}))
  assert.equal(notesOf(top).find(one => one.text === 'email')?.detail, 'personal data')
})

test('past three personal fields, the rest share one line', () => {
  const ir = buildIR('t', normalize('query Q { r { a { b { creator { user { email phone address birthday ssn salary } } } } } }', {}))
  const personal = notesOf(ir).filter(one => one.glyph === '◆')
  assert.deepEqual(personal.map(one => one.text), ['email', 'phone', 'address', '3 more personal data:'])
  assert.deepEqual(personal[3]?.names, ['birthday', 'ssn', 'salary'])
})

test('argument names are capped at clamp(columns / 4, 10, 18)', () => {
  assert.deepEqual([40, 50, 64, 84, 120].map(argNameMax), [10, 12, 16, 18, 18])
})

const RESPONSE = { data: { acme_list: { items: [{ id: '1' }], more: true, total: null, limit: 5, offset: 0 } } }
const OP2 = 'query Q { acme_list(limit: 5) { items { id } more total limit offset } }'
const SDL2 = ['type Query { acme_list(limit: Int, offset: Int): Acme_List } type Acme_List { """Echoes offset pagination property.""" offset: Int limit: Int more: Boolean total: Int items: [Acme_Item] } type Acme_Item { id: ID }']
const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

test('an outcome computed without a schema hides the echo once the IR is annotated; nothing is lost at settle', () => {
  const bare = buildIR('t', normalize(OP2, {}))
  const rich = annotate(bare, { schema: indexSdl(SDL2), isIncomplete: false })
  const outcome = outcomeOf(bare, mcp(RESPONSE))
  // All raw facts are kept: nulls and echoes included.
  assert.deepEqual(outcome.scalars?.map(one => one.field), ['more', 'total', 'limit', 'offset'])
  assert.deepEqual(shownScalars(outcome, rich).map(one => one.field), ['more'])
  assert.deepEqual(resultLines(outcome, rich).filter(line => line.kind === 'scalar'), [])
})

test('the reverse: an outcome computed with a schema shows a described field when the IR has none', () => {
  const rich = annotate(buildIR('t', normalize(OP2.replace('limit: 5', 'limit: 7'), {})), { schema: indexSdl(SDL2), isIncomplete: false })
  const outcome = outcomeOf(rich, mcp({ data: { acme_list: { items: [], more: false, offset: 3 } } }))
  // offset 3 is not an unset 0 and nothing says it echoes without the schema: shown. With the schema: hidden.
  const bare = buildIR('t', normalize(OP2.replace('limit: 5', 'limit: 7'), {}))
  assert.deepEqual(shownScalars(outcome, bare).map(one => one.field), ['more', 'offset'])
  assert.deepEqual(shownScalars(outcome, rich).map(one => one.field), ['more'])
  // An unset offset of 0 is hidden against either IR.
  const zero = outcomeOf(bare, mcp({ data: { acme_list: { offset: 0, more: true } } }))
  assert.deepEqual(shownScalars(zero, bare).map(one => one.field), ['more'])
})
