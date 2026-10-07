import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { attentionOf } from '../../src/attention.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { classificationOf, outcomeOf } from '../../src/result.ts'
import { hintsFrom, indexSdl } from '../../src/schema.ts'
import { hasUnsetLimit, notesOf } from '../../src/view/notes.ts'
import { flagsOf, flagsText, requestDraft } from '../../src/view/flags.ts'
import { resultLines } from '../../src/view/outcome.ts'
import { personalFields } from '../../src/view/personal.ts'

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

/** A real-shaped denial_context: header.payload.signature, base64url, any signature. */
export function denialToken(blocked: unknown[] = [{ coord: 'Acme_Customer_Data_Member.email', classification: 'pii-high', reason: '', rule_id: 'rule-secret-1' }]): string {
  const payload = {
    app_id: 'app-secret',
    principal_id: 'principal-secret',
    service_id: 'service-secret',
    service_name: 'acme-customer-data',
    blocked_fields: blocked,
    timestamp: '2026-10-06T07:30:19Z',
    request_id: 'request-secret',
    schema_id: 'schema-secret',
    iat: 1790000000,
    exp: 1790000300,
  }
  return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.${b64('not-a-real-signature')}`
}

const OPERATION = 'query OrgAdmins($org: ID!) { acme_customer_data_listOrganizationMembers(orgId: $org) { id name role email } }'
const SDL = [
  'type Query { acme_customer_data_listOrganizationMembers(orgId: ID!): [Acme_Customer_Data_Member] }',
  'type Acme_Customer_Data_Member { id: ID name: String role: Acme_Customer_Data_Role """Personal contact data (x-data-classification: pii.contact in the source).""" email: String }',
]
const ROOT = 'acme_customer_data_listOrganizationMembers'

function irOf(sdl: string[] = SDL, deny = true) {
  const decisions = new Map<string, { decision: 'allow' | 'deny' }>(
    [ROOT, `${ROOT}.id`, `${ROOT}.name`, `${ROOT}.role`].map(path => [path, { decision: 'allow' as const }]),
  )
  decisions.set(`${ROOT}.email`, { decision: deny ? 'deny' : 'allow' })
  return annotate(buildIR('t', normalize(OPERATION, { org: 'o' })), {
    schema: indexSdl(sdl),
    access: { denyOperation: false, fields: decisions },
    validation: { valid: true, diagnostics: [] },
    scope: 'acme-customer-data',
    isIncomplete: false,
  })
}

const denial = (index: number, token = denialToken()) => ({
  extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: token, visibility: 'requestable', reason: '' },
  message: '',
  path: [ROOT, String(index), 'email'],
})
const response = (errors: unknown[], members = 4) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ data: { [ROOT]: Array.from({ length: members }, (_, i) => ({ id: `m${i}`, name: `n${i}`, role: 'ADMIN', email: null })) }, errors }),
    },
  ],
})

// Rows 0..4 are the shown preview; denials past them stay standalone and collapse.
test('denials past the preview collapse into one entry, by real field name', () => {
  const outcome = outcomeOf(irOf(), response([5, 6, 7].map(i => denial(i)), 8))
  assert.equal(outcome.errors.length, 1)
  const [one] = outcome.errors
  assert.equal(one?.path, `${ROOT}.*.email`)
  assert.equal(one?.field, 'email')
  assert.equal(one?.count, 3)
  assert.equal(one?.of, 8)
  assert.equal(one?.classification, 'pii-high')
  assert.equal(one?.isRequestable, true)
  assert.equal(one?.isExpected, true)
  const lines = resultLines(outcome, irOf()).filter(line => line.kind === 'error')
  assert.deepEqual(lines.map(line => line.text), ['email denied in 3 of 8 items · pii-high · requestable'])
})

test('identical denials collapse whatever code carries them, and whatever the index type', () => {
  const odd = (index: number | string, code?: string) => ({ ...denial(0), path: [ROOT, index, 'email'], extensions: { ...(code !== undefined && { code }), denial_context: denialToken() } })
  const outcome = outcomeOf(irOf(), response([odd(5), odd('6', 'CONSTELLATION_ACCESS_DENIED'), odd(7, 'OTHER_CODE')], 8))
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.errors[0]?.count, 3)
})

test('two of eight items read "2 of 8 items"', () => {
  const some = outcomeOf(irOf(), response([denial(5), denial(7)], 8))
  assert.equal(resultLines(some, irOf()).find(line => line.kind === 'error')?.text, 'email denied in 2 of 8 items · pii-high · requestable')
})

test('a denial inside a shown row is tagged on that row, not listed', () => {
  const outcome = outcomeOf(irOf(), response([0, 2, 3].map(i => denial(i))))
  assert.deepEqual(outcome.errors, [])
  const items = outcome.preview?.[0]?.items ?? []
  assert.deepEqual(items.map(item => item.denied?.map(one => one.field)), [['email'], undefined, ['email'], ['email']])
  assert.equal(items[0]?.denied?.[0]?.classification, 'pii-high')
  assert.equal(items[0]?.denied?.[0]?.isRequestable, true)
  const lines = resultLines(outcome, irOf())
  assert.ok(!lines.some(line => line.kind === 'error'))
  const preview = lines.find(line => line.kind === 'preview')
  assert.ok(preview?.kind === 'preview' && preview.items[2]?.denied?.[0]?.field === 'email')
})

test('rows split between tagged and standalone: shown rows tag, the rest collapse', () => {
  const outcome = outcomeOf(irOf(), response([0, 1, 2, 3, 4, 5, 6].map(i => denial(i)), 7))
  assert.equal(outcome.preview?.[0]?.items.every(item => item.denied?.[0]?.field === 'email'), true)
  // The rows shown count too: all seven, not the two past the preview.
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.errors[0]?.count, 7)
  assert.equal(resultLines(outcome, irOf()).find(line => line.kind === 'error')?.text, 'email denied in all 7 items · pii-high · requestable')
})

test('a nested denial is tagged by its relative real path; repeats are de-duplicated and the tags capped', () => {
  const nested = (path: (string | number)[]) => ({ ...denial(0), path })
  const outcome = outcomeOf(irOf(), response([nested([ROOT, 1, 'email']), nested([ROOT, 1, 'email']), nested([ROOT, 1, 'a']), nested([ROOT, 1, 'b']), nested([ROOT, 1, 'c']), nested([ROOT, 1, 'd', 'e']), nested([ROOT, 1, 'f'])], 3))
  const item = outcome.preview?.[0]?.items[1]
  assert.deepEqual(item?.denied?.map(one => one.field), ['email', 'a', 'b', 'c'])
  // Past the cap they stay standalone rather than vanish.
  assert.deepEqual(outcome.errors.map(error => error.field).sort(), ['e', 'f'])
})

test('a failure inside a shown row stays a standalone line', () => {
  const outcome = outcomeOf(irOf(), response([{ message: 'boom', path: [ROOT, 0, 'name'], extensions: { code: 'UPSTREAM' } }], 3))
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.preview?.[0]?.items[0]?.denied, undefined)
})

test('non-denial errors that share a code and a normalized path group too; other codes stay apart', () => {
  const failure = (index: number, code: string) => ({ message: `boom ${index}`, path: [ROOT, index, 'name'], extensions: { code } })
  const outcome = outcomeOf(irOf(), response([failure(0, 'UPSTREAM'), failure(1, 'UPSTREAM'), failure(2, 'OTHER')]))
  assert.equal(outcome.errors.length, 2)
  assert.equal(outcome.errors[0]?.count, 2)
  const texts = resultLines(outcome, irOf()).filter(line => line.kind === 'error').map(line => line.text)
  assert.deepEqual(texts, ['UPSTREAM at name in 2 of 4 items · boom 0', 'OTHER at name in 1 of 4 items · boom 2'])
})

test('a long field name is never cut: the line wraps', () => {
  const outcome = { rows: [], authLinks: [], errors: [{ message: 'x', code: 'C', path: 'a.*.' + 'z'.repeat(60), count: 2, of: 3 }] }
  const text = resultLines(outcome as never)[0]?.text ?? ''
  assert.ok(text.includes(`at ${'z'.repeat(60)} in 2 of 3 items`), text)
  assert.ok(!text.includes('…'))
})

test('the token decodes for its classification only; nothing else of it is kept', () => {
  assert.equal(classificationOf(denialToken(), 'email'), 'pii-high')
  const outcome = outcomeOf(irOf(), response([denial(0), denial(6)], 8))
  const kept = JSON.stringify(outcome)
  for (const secret of ['secret', 'JWT', 'ES256', 'rule-', 'principal', 'request-', 'eyJ']) assert.ok(!kept.includes(secret), secret)
  assert.ok(!JSON.stringify(resultLines(outcome, irOf())).includes('secret'))
})

test('a classification is a short [a-z0-9.-] string, matched to the field', () => {
  const blocked = (coord: string, classification: unknown) => ({ coord, classification })
  assert.equal(classificationOf(denialToken([blocked('T.email', 'x'.repeat(21))]), 'email'), undefined)
  assert.equal(classificationOf(denialToken([blocked('T.email', 'PII High')]), 'email'), undefined)
  assert.equal(classificationOf(denialToken([blocked('T.email', 42)]), 'email'), undefined)
  assert.equal(classificationOf(denialToken([blocked('T.phone', 'pii-low'), blocked('T.email', 'pii-high')]), 'email'), 'pii-high')
  assert.equal(classificationOf(denialToken([blocked('T.phone', 'pii-low'), blocked('T.fax', 'pii-mid')]), 'email'), undefined)
})

test('a malformed token is ignored: the denial still shows, without classification', () => {
  for (const token of ['', 'x', 'a.b.c', 'a.!!!.c', `a.${b64('not json')}.c`, `a.${b64('[1]')}.c`, `a.${b64({ blocked_fields: 'no' })}.c`, `a.${'A'.repeat(40_000)}.c`]) {
    assert.equal(classificationOf(token, 'email'), undefined, token.slice(0, 20))
  }
  const outcome = outcomeOf(irOf(), response([denial(5, 'garbage')], 6))
  assert.equal(outcome.errors[0]?.isDenied, true)
  assert.equal(outcome.errors[0]?.classification, undefined)
  assert.equal(resultLines(outcome, irOf()).find(line => line.kind === 'error')?.text, 'email denied in 1 of 6 items · requestable')
  const tagged = outcomeOf(irOf(), response([denial(0, 'garbage')], 1))
  assert.equal(tagged.preview?.[0]?.items[0]?.denied?.[0]?.classification, undefined)
})

test('a denied field\'s reason carries one classification: the schema\'s, else the one Agent Services gave once settled', () => {
  const ir = irOf()
  const outcome = outcomeOf(ir, response([0, 1, 2, 3].map(i => denial(i))))
  // The schema classifies email, pending or settled: that one, not Agent Services' as well.
  assert.deepEqual(attentionOf(ir, outcome).filter(one => one.coordinate.endsWith('.email')), [{ coordinate: 'Acme_Customer_Data_Member.email', reason: 'denied · pii.contact' }])
  assert.equal(attentionOf(ir).find(one => one.coordinate.endsWith('.email'))?.reason, 'denied · pii.contact')
  // With no classification in the schema, Agent Services' from the denial, once the call has run.
  const bare = irOf([SDL[0]!, SDL[1]!.replace('"""Personal contact data (x-data-classification: pii.contact in the source)."""', '')])
  assert.equal(attentionOf(bare, outcomeOf(bare, response([denial(0)]))).find(one => one.coordinate.endsWith('.email'))?.reason, 'denied · pii-high')
  assert.equal(attentionOf(bare).find(one => one.coordinate.endsWith('.email'))?.reason, 'denied')
})

test('x-data-classification and similar vendor annotations become hints', () => {
  assert.deepEqual(hintsFrom('Personal contact data (x-data-classification: pii.contact in the source).'), ['classified pii.contact'])
  assert.deepEqual(hintsFrom('Kept. x-retention: 30d. x-sensitivity: high'), ['retention 30d', 'sensitivity high'])
  assert.deepEqual(hintsFrom('x-unknown-thing: whatever'), [])
  const email = irOf().roots[0]?.children.find(child => child.name === 'email')
  assert.deepEqual(email?.schema?.hints, ['classified pii.contact'])
})

test('a schema-classified pii field is personal data even when its name is not', () => {
  const sdl = [SDL[0]!, SDL[1]!.replace('email: String', 'contactLine: String').replace('"""Personal', '"""x-data-classification: pii.contact. Personal')]
  const op = 'query Q($org: ID!) { acme_customer_data_listOrganizationMembers(orgId: $org) { id contactLine } }'
  const ir = annotate(buildIR('t', normalize(op, { org: 'o' })), { schema: indexSdl(sdl), isIncomplete: false })
  assert.deepEqual(personalFields(ir.roots).map(field => field.name), ['contactLine'])
  // One line per field: the name, then what it is and its classification.
  assert.equal(notesOf(ir).find(one => one.text === 'contactLine')?.detail, 'personal data · pii.contact')
  // A denied personal field says its policy first, on the same one line.
  const email = notesOf(irOf()).filter(one => one.text === 'email')
  assert.deepEqual(email.map(one => one.detail), ['denied · pii.contact'])
})

test('no limit is noted only when the root declares a limit or paging argument that is unset', () => {
  const none = irOf()
  assert.equal(hasUnsetLimit(none.roots[0]!), false)
  assert.ok(!notesOf(none).some(note => note.text.startsWith('no limit')))
  const withLimit = irOf([SDL[0]!.replace('orgId: ID!', 'orgId: ID!, limit: Int'), SDL[1]!])
  assert.equal(hasUnsetLimit(withLimit.roots[0]!), true)
  assert.ok(notesOf(withLimit).some(note => note.text.startsWith('no limit')))
  const withCursor = irOf([SDL[0]!.replace('orgId: ID!', 'orgId: ID!, cursor: String'), SDL[1]!])
  assert.ok(notesOf(withCursor).some(note => note.text.startsWith('no limit')))
})

test('the scope-derived prefix is stripped from a type, the headline and the rows label', async () => {
  const { fallbackLine, humanType } = await import('../../src/view/kit.ts')
  assert.equal(humanType('Acme_Customer_Data_Member', 'acme-customer-data'), 'member')
  assert.equal(humanType('Acme_Customer_Data_Member'), 'customer data member')
  assert.equal(fallbackLine(irOf()), `${ROOT} · list of members`)
  const outcome = outcomeOf(irOf(), response([], 4))
  const rows = resultLines(outcome, irOf()).find(line => line.kind === 'rows')
  assert.ok(rows?.kind === 'rows' && rows.field === '' && rows.text === '4 members')
})

test('a row keeps its selected fields in selection order; a denied one has a tag and no value', () => {
  const outcome = outcomeOf(irOf(), response([denial(1)], 3))
  const items = outcome.preview?.[0]?.items ?? []
  assert.deepEqual(items[0]?.fields, [{ name: 'id', value: 'm0' }, { name: 'name', value: 'n0' }, { name: 'role', value: 'ADMIN' }, { name: 'email', value: 'null' }])
  assert.deepEqual(items[1]?.fields?.map(one => one.name), ['id', 'name', 'role', 'email'])
  assert.equal(items[1]?.fields?.find(one => one.name === 'email')?.value, undefined)
  const line = resultLines(outcome, irOf()).find(one => one.kind === 'preview')
  const card = line?.kind === 'preview' ? line.items[1]?.fields : undefined
  assert.deepEqual(card?.find(one => one.name === 'email')?.denial, { classification: 'pii-high', isRequestable: true })
  assert.equal(card?.find(one => one.name === 'id')?.value, 'm1')
  assert.ok(line?.kind === 'preview' && line.size === 3)
})

test('nested scalars read as user.email, values are cut, and fields are capped', () => {
  const op = 'query Q { r: things { id title u: user { mail: email } a b c d e f g h i j k l } }'
  const ir = buildIR('t', normalize(op, {}))
  const item = { id: '1', title: 'T', u: { mail: 'x'.repeat(400) }, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, extra: 'unselected' }
  const outcome = outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify({ data: { r: [item] } }) }] })
  const fields = outcome.preview?.[0]?.items[0]?.fields ?? []
  assert.equal(fields.length, 12)
  assert.deepEqual(fields.slice(0, 2).map(one => one.name), ['id', 'title'])
  assert.equal(fields[2]?.name, 'user.email')
  assert.ok((fields[2]?.value ?? '').length <= 256)
  assert.ok(!fields.some(one => one.name === 'extra'))
})

test('a field denied under two roots is a flag for each, counted against its own rows', () => {
  const op = 'query Two($org: ID!) { members: acme_customer_data_listOrganizationMembers(orgId: $org) { id name email } admins: acme_customer_data_listOrganizationMembers(orgId: $org) { id name email } }'
  const decisions = new Map<string, { decision: 'allow' | 'deny' }>()
  for (const root of ['members', 'admins']) {
    for (const path of [root, `${root}.id`, `${root}.name`]) decisions.set(path, { decision: 'allow' })
    decisions.set(`${root}.email`, { decision: 'deny' })
  }
  const ir = annotate(buildIR('t', normalize(op, { org: 'o' })), { schema: indexSdl(SDL), access: { denyOperation: false, fields: decisions }, validation: { valid: true, diagnostics: [] }, scope: 'acme-customer-data', isIncomplete: false })
  const people = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, name: `n${i}`, email: null }))
  const denied = (root: string, index: number) => ({ extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: denialToken(), visibility: 'requestable' }, message: '', path: [root, String(index), 'email'] })
  const errors = [...[0, 1, 2, 3].map(i => denied('members', i)), ...[0, 1].map(i => denied('admins', i))]
  const outcome = outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify({ data: { members: people(4), admins: people(2) }, errors }) }] })
  assert.deepEqual(
    flagsText(flagsOf(ir, outcome, true)).split(' · ').filter(part => part !== 'access request can be filed'),
    ['email denied for 4 members', 'email denied for 2 members'],
  )
  // Access is granted per field of a type, not per root: one request covers both, said once.
  const draft = requestDraft(flagsOf(ir, outcome, true), ir.opName) ?? ''
  assert.equal(draft.split('`email`').length - 1, 1, draft)
  assert.match(draft, /^File an Agent Services access request for `email` on /)
  // Pending, each by its own path.
  assert.deepEqual(flagsOf(ir).map(flag => flag.text.split(' · ')[0]), ['members.email denied', 'admins.email denied'])
})

// ---- Counts are rows, and what is offered is what can be done

/** A call over a custom schema; every path in `deny` is denied, the rest allowed (with `hasPolicy` false, unknown). */
function callOf(operation: string, sdl: string[], deny: string[], hasPolicy = true) {
  const ir = buildIR('t', normalize(operation, {}))
  const fields = new Map<string, { decision: 'allow' | 'deny'; denialContext?: string }>()
  const visit = (field: (typeof ir.roots)[number]) => {
    fields.set(field.path, deny.includes(field.path) ? { decision: 'deny', denialContext: denialToken() } : { decision: 'allow' })
    field.children.forEach(visit)
  }
  ir.roots.forEach(visit)
  return annotate(ir, { schema: indexSdl(sdl), ...(hasPolicy && { access: { denyOperation: false, fields } }), validation: { valid: true, diagnostics: [] }, scope: 'acme-customer-data', isIncomplete: false })
}
const send = (data: unknown, errors: unknown[]) => ({ content: [{ type: 'text', text: JSON.stringify({ data, errors }) }] })
const deniedAt = (path: (string | number)[], extensions: Record<string, unknown> = {}) => ({ message: '', path, extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: denialToken(), visibility: 'requestable', ...extensions } })

const INCIDENT_SDL = [
  'type Query { incidentio_incidents: [IncidentIO_Incident] }',
  'type IncidentIO_Incident { reference: String creator: IncidentIO_Actor assignee: IncidentIO_Actor }',
  'type IncidentIO_Actor { user: IncidentIO_User }',
  'type IncidentIO_User { name: String email: String }',
]
const flagTexts = (ir: Parameters<typeof flagsOf>[0], outcome: Parameters<typeof flagsOf>[1]) => flagsOf(ir, outcome, true).map(flag => flag.text.split(' · ')[0])

test('a field denied by two paths in the same rows counts those rows once', () => {
  const ir = callOf('query I { incidentio_incidents { reference creator { user { email } } assignee { user { email } } } }', INCIDENT_SDL, ['incidentio_incidents.creator.user.email', 'incidentio_incidents.assignee.user.email'])
  const rows = Array.from({ length: 8 }, (_, i) => ({ reference: `INC-${i}`, creator: { user: { email: null } }, assignee: { user: { email: null } } }))
  const errors = rows.flatMap((_, i) => [deniedAt(['incidentio_incidents', i, 'creator', 'user', 'email']), deniedAt(['incidentio_incidents', i, 'assignee', 'user', 'email'])])
  const outcome = outcomeOf(ir, send({ incidentio_incidents: rows }, errors))
  assert.deepEqual(flagTexts(ir, outcome), ['email denied for 8 incidents'])
})

test('a denial never counts more rows than the list returned', () => {
  const ir = callOf('query I { incidentio_incidents { reference creator { user { email } } } }', INCIDENT_SDL, [])
  const rows = Array.from({ length: 3 }, (_, i) => ({ reference: `INC-${i}`, creator: { user: { email: null } } }))
  // A service that repeats itself, and names a row it did not return.
  const errors = [0, 0, 1, 2, 7].map(i => deniedAt(['incidentio_incidents', i, 'creator', 'user', 'email']))
  const [flag] = flagsOf(ir, outcomeOf(ir, send({ incidentio_incidents: rows }, errors)), true)
  assert.match(flag?.text ?? '', /^email denied for 3 incidents/)
})

test('a root that is not a list says the field is denied, with no count', () => {
  const sdl = ['type Query { acme_customer_data_getMember(id: ID): Acme_Customer_Data_Member }', 'type Acme_Customer_Data_Member { id: ID email: String }']
  const ir = callOf('query M { acme_customer_data_getMember(id: "1") { id email } }', sdl, ['acme_customer_data_getMember.email'])
  const outcome = outcomeOf(ir, send({ acme_customer_data_getMember: { id: '1', email: null } }, [deniedAt(['acme_customer_data_getMember', 'email'])]))
  const [flag] = flagsOf(ir, outcome, true)
  assert.match(flag?.text ?? '', /^email denied( · |$)/)
  assert.doesNotMatch(flag?.text ?? '', /\d|row/)
})

test('a list inside a list counts the inner rows, not the outer ones', () => {
  const sdl = ['type Query { teams: [Team] }', 'type Team { name: String members: [Member] }', 'type Member { email: String }']
  const ir = callOf('query T { teams { name members { email } } }', sdl, ['teams.members.email'])
  const teams = [{ name: 'a', members: [{ email: null }, { email: null }, { email: null }] }, { name: 'b', members: [{ email: null }, { email: null }] }]
  const errors = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]].map(([team, member]) => deniedAt(['teams', team!, 'members', member!, 'email']))
  const outcome = outcomeOf(ir, send({ teams }, errors))
  // The denial is not a tag on a team's row, and it groups under the inner list's own path.
  assert.ok(!outcome.preview?.[0]?.items.some(item => item.denied !== undefined))
  assert.deepEqual(outcome.errors.map(error => [error.path, error.count]), [['teams.*.members.*.email', 5]])
  assert.deepEqual(flagTexts(ir, outcome), ['email denied for 5 members'])
})

test('every row denied, shown or not, reads as all of them', () => {
  const outcome = outcomeOf(irOf(), response(Array.from({ length: 12 }, (_, i) => denial(i)), 12))
  assert.equal(outcome.preview?.[0]?.items.filter(item => item.denied !== undefined).length, 12)
  assert.deepEqual(resultLines(outcome, irOf()).filter(line => line.kind === 'error').map(line => line.text), ['email denied in all 12 items · pii-high · requestable'])
  assert.deepEqual(flagTexts(irOf(), outcome), ['email denied for 12 members'])
})

test('a denial the policy check did not predict is a flag, with the request Agent Services sent a token for', () => {
  for (const hasPolicy of [true, false]) {
    const ir = callOf('query I { incidentio_incidents { reference creator { user { email } } } }', INCIDENT_SDL, [], hasPolicy)
    const rows = Array.from({ length: 2 }, (_, i) => ({ reference: `INC-${i}`, creator: { user: { email: null } } }))
    const outcome = outcomeOf(ir, send({ incidentio_incidents: rows }, [0, 1].map(i => deniedAt(['incidentio_incidents', i, 'creator', 'user', 'email']))))
    const flags = flagsOf(ir, outcome, true)
    assert.equal(flags[0]?.tone, 'deny')
    assert.match(flags[0]?.text ?? '', /^email denied for 2 incidents/)
    assert.ok(flags[0]?.request !== undefined, 'the response carried a token')
    assert.ok(requestDraft(flags, ir.opName) !== undefined)
  }
})

test('an access request is offered only for a denial the response itself carried a token for, and that is requestable', () => {
  const ir = callOf('query I { incidentio_incidents { reference creator { user { email } } } }', INCIDENT_SDL, ['incidentio_incidents.creator.user.email'])
  const rows = [{ reference: 'INC-1', creator: { user: { email: null } } }]
  const ran = (extensions: Record<string, unknown>) => flagsOf(ir, outcomeOf(ir, send({ incidentio_incidents: rows }, [{ ...deniedAt(['incidentio_incidents', 0, 'creator', 'user', 'email']), extensions }])), true)
  // dry_run's token is not the agent's: before the call ran, and in a response with none, there is nothing to file.
  assert.equal(flagsOf(ir)[0]?.request, undefined)
  assert.equal(ran({ code: 'CONSTELLATION_ACCESS_DENIED', visibility: 'requestable' })[0]?.request, undefined)
  // A private denial is not requestable, token or not.
  const privateOne = ran({ code: 'CONSTELLATION_ACCESS_DENIED', denial_context: denialToken(), visibility: 'private' })
  assert.equal(privateOne[0]?.request, undefined)
  assert.doesNotMatch(flagsText(privateOne), /access request/)
  assert.ok(ran({ code: 'CONSTELLATION_ACCESS_DENIED', denial_context: denialToken(), visibility: 'requestable' })[0]?.request !== undefined)
})

test('the draft names the call by its operation name, and never as "the last" call', () => {
  const flags = [{ text: 'x', detail: 'x', tone: 'deny' as const, request: { what: '`email` on members' } }]
  assert.match(requestDraft(flags, 'OrgAdmins') ?? '', /denied in the OrgAdmins call/)
  const unnamed = requestDraft(flags, undefined) ?? ''
  assert.match(unnamed, /`email` on members/)
  assert.doesNotMatch(unnamed, /last/)
})

test('a denied object is flagged though it has children', () => {
  const ir = callOf('query I { incidentio_incidents { reference creator { user { name email } } } }', INCIDENT_SDL, ['incidentio_incidents.creator'])
  assert.deepEqual(flagsOf(ir).map(flag => flag.text), ['creator denied'])
  const outcome = outcomeOf(ir, send({ incidentio_incidents: [{ reference: 'INC-1', creator: null }] }, [deniedAt(['incidentio_incidents', 0, 'creator'])]))
  assert.deepEqual(flagTexts(ir, outcome), ['creator denied for 1 incident'])
})
