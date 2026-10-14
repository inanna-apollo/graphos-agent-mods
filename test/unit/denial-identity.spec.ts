import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import { annotate } from '../../src/annotate.ts'
import { attentionOf } from '../../src/attention.ts'
import { buildIR } from '../../src/build.ts'
import { denialFor, observedDenials } from '../../src/denials.ts'
import type { CallIR, CallOutcome, FieldIR } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { denialFactsOf, outcomeOf } from '../../src/result.ts'
import { indexSdl } from '../../src/schema.ts'
import { annotationIndex } from '../../src/view/annotations.ts'
import { completeFieldFacts, denialsOf } from '../../src/view/card-facts.ts'
import { flagsOf, requestDraft, requestDraftFor } from '../../src/view/flags.ts'
import { resultLines } from '../../src/view/outcome.ts'

const SDL = ['type Query { atlas_people: [Person] }', 'type Person { id: ID email: String phone: String user: Person }']
const token = (classification = 'pii.contact', blocked: unknown[] = [{ coord: 'Person.email', classification }]) => `e30.${Buffer.from(JSON.stringify({ service_name: 'atlas', blocked_fields: blocked })).toString('base64url')}.signature`
const mcp = (data: unknown, errors: unknown[] = []) => JSON.stringify({ data, errors })
const denied = (path: (string | number)[], classification = 'pii.contact', visibility = 'requestable') => ({ path, message: 'policy denied this field', extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: token(classification), visibility } })
const call = (operation: string): CallIR => annotate(buildIR('t', normalize(operation, {})), { schema: indexSdl(SDL), scope: 'atlas', isIncomplete: false })
const fields = (roots: readonly FieldIR[]): FieldIR[] => roots.flatMap(one => [one, ...fields(one.children)])
const metadata = (one: ReturnType<typeof denialFor>) => one === undefined ? undefined : ({ rows: one.rows, of: one.of, classification: one.classification, isRequestable: one.isRequestable, coord: one.coord, service: one.service })

test('aliased occurrences share a schema coordinate but keep separate response evidence and pins', () => {
  const ir = call('{ first: atlas_people { id mail: email other: email } second: atlas_people { id email } }')
  const outcome = outcomeOf(ir, mcp({ first: [{ id: '1', mail: null, other: 'visible@example.test' }], second: [{ id: '2', email: 'second@example.test' }] }, [denied(['first', 0, 'mail'])]))
  const mail = fields(ir.roots).find(one => one.path === 'first.mail')!
  const other = fields(ir.roots).find(one => one.path === 'first.other')!
  const second = fields(ir.roots).find(one => one.path === 'second.email')!
  assert.equal(mail.coordinate, other.coordinate)
  assert.equal(outcome.denials?.[0]?.path, 'first.mail')
  assert.equal(outcome.preview?.[0]?.items[0]?.denied?.[0]?.path, 'first.mail')
  assert.equal(denialFor(mail, outcome, ir.roots)?.classification, 'pii.contact')
  assert.equal(denialFor(other, outcome, ir.roots), undefined)
  assert.equal(denialFor(second, outcome, ir.roots), undefined)
  const values = outcome.preview?.[0]?.items[0]?.fields
  assert.equal(values?.find(one => one.path === 'first.mail')?.value, undefined)
  assert.equal(values?.find(one => one.path === 'first.other')?.value, 'visible@example.test')
  assert.match(annotationIndex(ir, 'attention', outcome).field(mail.path)?.note ?? '', /denied/)
  assert.doesNotMatch(annotationIndex(ir, 'attention', outcome).field(other.path)?.note ?? '', /denied/)
  assert.equal(flagsOf(ir, outcome, true).filter(one => one.tone === 'deny').length, 1)
  assert.equal(flagsOf(ir, outcome, true)[0]?.request?.path, 'first.mail')
})

test('two nested occurrences retain their own classification, visibility, and counts', () => {
  const ir = call('{ people: atlas_people { id email user { email } } }')
  const outcome = outcomeOf(ir, mcp({ people: [{ id: '1', email: null, user: { email: null } }, { id: '2', email: 'visible', user: { email: null } }] }, [denied(['people', 0, 'email'], 'pii.low'), denied(['people', 0, 'user', 'email'], 'pii.high', 'private'), denied(['people', 1, 'user', 'email'], 'pii.high', 'private')]))
  const own = fields(ir.roots).find(one => one.path === 'people.email')!
  const nested = fields(ir.roots).find(one => one.path === 'people.user.email')!
  assert.deepEqual(metadata(denialFor(own, outcome, ir.roots)), { rows: 1, of: 2, classification: 'pii.low', isRequestable: true, coord: 'Person.email', service: 'atlas' })
  assert.deepEqual(metadata(denialFor(nested, outcome, ir.roots)), { rows: 2, of: 2, classification: 'pii.high', isRequestable: false, coord: 'Person.email', service: 'atlas' })
  assert.equal(flagsOf(ir, outcome, true).filter(one => one.request !== undefined).length, 1)
  const visible = flagsOf(ir, outcome, true).map(one => one.text)
  assert.ok(visible.some(one => one.startsWith('email denied')))
  assert.ok(visible.some(one => one.startsWith('user.email denied')))
  assert.equal(denialsOf(outcome, nested, undefined, ir.roots).count, 2)
})

test('ambiguous legacy aggregates remain observed but are not pinned or drafted for a sibling', () => {
  const ir = call('{ people: atlas_people { id email user { email } } }')
  const old: CallOutcome = { rows: [], errors: [], authLinks: [], denials: [{ root: 'people', field: 'email', rows: 2, classification: 'pii.high', isRequestable: true, hasToken: true, coord: 'Person.email', service: 'atlas' }] }
  assert.equal(observedDenials(old, ir.roots).length, 1)
  for (const field of fields(ir.roots).filter(one => one.name === 'email')) {
    assert.equal(denialFor(field, old, ir.roots), undefined)
    assert.doesNotMatch(annotationIndex(ir, 'attention', old).field(field.path)?.note ?? '', /denied/)
    assert.doesNotMatch(completeFieldFacts(field, old, false, ir.roots).join('\n'), /execution response: denied|pii.high/)
  }
  const flags = flagsOf(ir, old, true)
  assert.equal(flags.filter(one => one.tone === 'deny').length, 1)
  assert.equal(requestDraft(flags, ir.opName), undefined)
})

test('unique legacy occurrences and exact legacy error paths can still be attributed', () => {
  const ir = call('{ people: atlas_people { id email user { phone } } }')
  const email = fields(ir.roots).find(one => one.path === 'people.email')!
  const aggregate: CallOutcome = { rows: [], errors: [], authLinks: [], denials: [{ root: 'people', field: 'email', rows: 2, isRequestable: true }] }
  assert.equal(denialFor(email, aggregate, ir.roots)?.rows, 2)
  const repeated = call('{ people: atlas_people { id email user { email } } }')
  const error: CallOutcome = { rows: [], errors: [{ message: 'denied', path: 'people.*.user.email', field: 'email', isDenied: true, classification: 'pii.high' }], authLinks: [] }
  assert.equal(denialFor(fields(repeated.roots).find(one => one.path === 'people.email')!, error, repeated.roots), undefined)
  assert.equal(denialFor(fields(repeated.roots).find(one => one.path === 'people.user.email')!, error, repeated.roots)?.classification, 'pii.high')
})

test('unselected payload denial and pathless legacy denial remain visible', () => {
  const ir = call('{ people: atlas_people { id } }')
  const outcome = outcomeOf(ir, mcp({ people: [{ id: '1' }] }, [denied(['people', 0, 'payload', 'email'])]))
  assert.equal(observedDenials(outcome, ir.roots)[0]?.path, 'people.payload.email')
  assert.equal(observedDenials(outcome, ir.roots)[0]?.field, undefined)
  assert.equal(flagsOf(ir, outcome, true).filter(one => one.tone === 'deny').length, 1)
  const pathless: CallOutcome = { rows: [], errors: [{ message: 'denied', isDenied: true }], authLinks: [] }
  assert.equal(flagsOf(ir, pathless, true).filter(one => one.tone === 'deny').length, 1)
  assert.ok(resultLines(pathless, ir).some(one => one.kind === 'error'))
})

test('token claims require an exact known coordinate or an unambiguous leaf', () => {
  const jwt = token('unused', [{ coord: 'Person.email', classification: 'pii.low' }, { coord: 'Account.email', classification: 'pii.high' }])
  assert.equal(denialFactsOf(jwt, 'email').classification, undefined)
  assert.equal(denialFactsOf(jwt, 'email', 'Account.email').classification, 'pii.high')
  assert.equal(denialFactsOf(jwt, 'email', 'Unknown.email').coord, undefined)
})

test('drafts preserve source identity while requesting each schema coordinate once', () => {
  const draft = requestDraftFor([{ what: '`email` on people', service: 'atlas', coord: 'Person.email', path: 'a.email' }, { what: '`email` on people', service: 'atlas', coord: 'Account.email', path: 'b.email' }, { what: '`email` on people', service: 'atlas', coord: 'Person.email', path: 'c.email' }], 'Read')!
  assert.match(draft, /requestedFields \["Person.email", "Account.email"\]/)
  assert.match(draft, /wait for my yes/)
})

test('standalone result drafts use the same exact identity and token boundary as flags', () => {
  const ir = call('{ people: atlas_people { id email user { email } } }')
  const base = { message: 'denied', isDenied: true, field: 'email', isRequestable: true }
  const errors = (error: typeof base & { path?: string; hasToken?: boolean }): CallOutcome => ({ rows: [], errors: [error], authLinks: [] })
  const requests = (outcome: CallOutcome) => resultLines(outcome, ir).flatMap(one => one.kind === 'error' && one.request !== undefined ? [one.request] : [])
  assert.deepEqual(requests(errors({ ...base, path: 'people.*.email' })), [])
  assert.deepEqual(requests(errors({ ...base, hasToken: true })), [])
  assert.equal(requests(errors({ ...base, hasToken: true, path: 'people.*.user.email' }))[0]?.path, 'people.user.email')
  const mixed = outcomeOf(ir, mcp({ people: Array.from({ length: 7 }, (_, index) => ({ id: String(index), email: null })) }, [denied(['people', 5, 'email']), denied(['people', 6, 'email'], 'pii.contact', 'private')]))
  assert.equal(mixed.errors[0]?.isRequestable, true) // The first reported row.
  assert.equal(mixed.denials?.[0]?.isRequestable, false) // Aggregate evidence is conservative.
  assert.deepEqual(requests(mixed), [])
  assert.ok(resultLines(mixed, ir).some(one => one.kind === 'error' && one.text.includes('not requestable')))
  assert.equal(flagsOf(ir, mixed, true).some(one => one.request !== undefined), false)
})

test('successful execution does not turn preflight denial or masking into an observed failure', () => {
  const ir = call('{ people: atlas_people { id email phone } }')
  ir.roots[0]!.children.find(one => one.name === 'email')!.policy = 'deny'
  ir.roots[0]!.children.find(one => one.name === 'phone')!.policy = 'mask'
  ir.isOperationDenied = true
  ir.checks = { policy: 'failed', schema: 'failed', validation: 'ok', error: 'auth timeout permission denied' }
  const outcome = outcomeOf(ir, mcp({ people: [{ id: '1', email: 'visible@example.test', phone: '123' }] }))
  assert.deepEqual(flagsOf(ir, outcome, true), [])
  assert.ok(!attentionOf(ir, outcome).some(one => /denied|masked/.test(one.reason)))
  const email = ir.roots[0]!.children.find(one => one.name === 'email')!
  assert.match(completeFieldFacts(email, outcome, false, ir.roots).join('\n'), /dry_run: denial/)
  assert.doesNotMatch(completeFieldFacts(email, outcome, false, ir.roots).join('\n'), /execution response: denied/)
})

const suffix = fc.stringMatching(/^[a-z]{1,10}$/)
test('property: renaming aliases preserves denial metadata and the denied occurrence', () => {
  fc.assert(fc.property(suffix, suffix, fc.integer({ min: 1, max: 8 }), (rootSuffix, leafSuffix, count) => {
    const run = (root: string, leaf: string) => {
      const ir = call(`{ ${root}: atlas_people { id ${leaf}: email } }`)
      const rows = Array.from({ length: count }, (_, index) => ({ id: `${index}`, [leaf]: null }))
      const outcome = outcomeOf(ir, mcp({ [root]: rows }, rows.map((_, index) => denied([root, index, leaf]))))
      const field = ir.roots[0]!.children.find(one => one.name === 'email')!
      const evidence = denialFor(field, outcome, ir.roots)
      assert.equal(evidence?.path, `${root}.${leaf}`)
      assert.equal(annotationIndex(ir, 'attention', outcome).field(field.path)?.note.includes('denied'), true)
      return metadata(evidence)
    }
    assert.deepEqual(run('people', 'mail'), run(`r${rootSuffix}`, `m${leafSuffix}`))
  }), { numRuns: 100 })
})

test('property: adding an unrelated same-named denial cannot change another occurrence', () => {
  fc.assert(fc.property(suffix, suffix, (a, b) => {
    const left = `l${a}`
    const right = `r${b}`
    const ir = call(`{ ${left}: atlas_people { id email } ${right}: atlas_people { id email } }`)
    const data = { [left]: [{ id: '1', email: null }], [right]: [{ id: '2', email: null }] }
    const base = outcomeOf(ir, mcp(data, [denied([left, 0, 'email'], 'pii.low')]))
    const more = outcomeOf(ir, mcp(data, [denied([left, 0, 'email'], 'pii.low'), denied([right, 0, 'email'], 'pii.high', 'private')]))
    const field = fields(ir.roots).find(one => one.path === `${left}.email`)!
    const original = denialFor(field, base, ir.roots)
    assert.ok(original, 'the original denied occurrence must be attributable')
    assert.equal(original.classification, 'pii.low')
    assert.equal(original.isRequestable, true)
    assert.deepEqual(metadata(original), metadata(denialFor(field, more, ir.roots)))
    const request = flagsOf(ir, base, true).find(one => one.request?.path === field.path)?.request
    assert.ok(request, 'the original requestable denial must offer a draft')
    assert.equal(request.coord, 'Person.email')
    assert.equal(request.service, 'atlas')
    assert.deepEqual(request, flagsOf(ir, more, true).find(one => one.request?.path === field.path)?.request)
  }), { numRuns: 100 })
})
