import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import type { CallIR } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { MAX_CONFIRMS, confirmOf, confirmText } from '../../src/preview/confirm.ts'
import { outcomeOf } from '../../src/result.ts'
import { resultLines } from '../../src/view/outcome.ts'
import { resultBlockOf } from '../../src/view/transcript.ts'

const irOf = (operation: string, variables: Record<string, unknown> = {}): CallIR => buildIR('toolu_confirm', normalize(operation, variables))
const said = (ir: CallIR, data: Record<string, unknown>) => confirmOf(ir, data).map(confirmText)
const ESC = '\u001b'

const PAGE = 'mutation P { confluence_updatePage(id: "123", status: "current", title: "On-call runbook", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 13) { id title status version { number } } }'

test('a page update: the title and version the response says back are confirmed; the restated status is not', () => {
  const ir = irOf(PAGE)
  assert.deepEqual(said(ir, { confluence_updatePage: { id: '123', title: 'On-call runbook', status: 'current', version: { number: 13 } } }), ['title On-call runbook ✓', 'version 13 ✓'])
})

test('a value that came back different says what came back, and keeps what was sent for the card', () => {
  const ir = irOf(PAGE)
  const found = confirmOf(ir, { confluence_updatePage: { title: 'Old title', version: { number: 14 } } })
  assert.deepEqual(found.map(confirmText), ['title came back as Old title', 'version came back as 14'])
  assert.deepEqual(found.map(one => [one.state, one.sent]), [['differs', 'On-call runbook'], ['differs', '13']])
})

test('only what the call selected is compared, under the keys the model aliased it to', () => {
  const ir = irOf('mutation P { page: confluence_updatePage(id: "123", status: "current", title: "T", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 13) { v: version { n: number } } }')
  const found = confirmOf(ir, { page: { v: { n: 13 } } })
  assert.deepEqual(found.map(confirmText), ['version 13 ✓'])
  assert.equal(found[0]?.path, 'page.v.n')
  assert.deepEqual(confirmOf(irOf('mutation P { confluence_updatePage(id: "1", status: "current", title: "T", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 2) { id } }'), { confluence_updatePage: { id: '1' } }), [])
})

test("a Jira comment's body compares line by line once both sides are flattened; a difference is not quoted", () => {
  const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fixed in 2.4.' }] }] }
  const ir = irOf('mutation C($b: Jira_JSON) { jira_updateComment(issueIdOrKey: "DEV-1", id: "10042", body: $b) { id body } }', { b: body })
  assert.deepEqual(said(ir, { jira_updateComment: { id: '10042', body: { ...body, version: 1 } } }), ['body ✓'])
  assert.deepEqual(said(ir, { jira_updateComment: { id: '10042', body: { type: 'doc', content: [] } } }), ['body came back different'])
})

test('a create names the record it made: a Slack ts, a Jira key, a Confluence id; and its text as Slack stored it', () => {
  const post = irOf('mutation P { slack_sendMessage(channel: "C1", text: "Deploy done") { ts message { text } } }')
  assert.deepEqual(said(post, { slack_sendMessage: { ts: '1728.0001', message: { text: 'Deploy done' } } }), ['created message 1728.0001', 'text ✓'])
  const issue = irOf('mutation N { jira_createIssue(fields: { project: { key: "DEV" }, summary: "x" }) { key } }')
  assert.deepEqual(said(issue, { jira_createIssue: { key: 'DEV-901' } }), ['created issue DEV-901'])
  const page = irOf('mutation N { confluence_createPage(spaceId: "9", title: "Notes", bodyRepresentation: "storage", bodyValue: "<p>x</p>") { id title } }')
  assert.deepEqual(said(page, { confluence_createPage: { id: '98765', title: 'Notes' } }), ['created page 98765', 'title Notes ✓'])
})

test("inside opaque JSON the response's own keys are read: an edit that asked for the issue back confirms its fields", () => {
  const ir = irOf('mutation E($f: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", returnIssue: true, fields: $f) }', { f: { summary: 'New title', priority: { id: '2' } } })
  assert.deepEqual(said(ir, { jira_editIssue: { key: 'DEV-1', fields: { summary: 'New title', priority: { id: '2', name: 'High' } } } }), ['summary New title ✓', 'priority came back as High'])
})

test('nothing to confirm: a read, no data, a null or empty answer, a transition (Jira answers with no content)', () => {
  assert.deepEqual(confirmOf(irOf('query Q { confluence_page(id: "1") { title } }'), { confluence_page: { title: 'x' } }), [])
  assert.deepEqual(confirmOf(irOf(PAGE), undefined), [])
  assert.deepEqual(confirmOf(irOf(PAGE), { confluence_updatePage: null }), [])
  assert.deepEqual(confirmOf(irOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: "31" }) }'), { jira_doTransition: null }), [])
})

test('confirmations are bounded, short and escaped', () => {
  const fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, `v${i}`]))
  const ir = irOf('mutation E($f: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", returnIssue: true, fields: $f) }', { f: fields })
  assert.equal(confirmOf(ir, { jira_editIssue: { fields } }).length, MAX_CONFIRMS)
  const evil = `x${ESC}[31m${'y'.repeat(400)}`
  const long = irOf('mutation E($f: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", returnIssue: true, fields: $f) }', { f: { summary: 'a' } })
  const [one] = confirmOf(long, { jira_editIssue: { fields: { summary: evil } } })
  assert.ok(one !== undefined && !(one.value ?? '').includes(ESC) && (one.value ?? '').length <= 121)
})

test('the outcome keeps the confirmations; RESULT leads with them and drops a scalar they already say; the transcript block leads with them too', () => {
  const ir = irOf('mutation P { confluence_updatePage(id: "123", status: "current", title: "T", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 13) { title version { number } } }')
  const outcome = outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify({ data: { confluence_updatePage: { title: 'T', version: { number: 13 } } } }) }] })
  assert.deepEqual(outcome.confirms?.map(one => one.state), ['same', 'same'])
  const lines = resultLines(outcome, ir)
  assert.equal(lines[0]?.kind, 'confirm')
  assert.deepEqual(lines[0]?.kind === 'confirm' ? lines[0].parts.map(part => part.text) : [], ['title T ✓', 'version 13 ✓'])
  // A scalar the confirmation says is not a line of its own.
  const titled = irOf('mutation P { confluence_updatePage(id: "123", status: "current", title: "T", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 13) { title } }')
  const withScalar = outcomeOf(titled, { content: [{ type: 'text', text: JSON.stringify({ data: { confluence_updatePage: { title: 'T' } } }) }] })
  assert.ok(!resultLines(withScalar, titled).some(line => line.kind === 'scalar' && /title/.test(line.field)))
  assert.match(resultBlockOf(outcome, ir)?.heads[0] ?? '', /title T ✓ · version 13 ✓/)
  // A read's outcome has none.
  assert.equal(outcomeOf(irOf('query Q { confluence_page(id: "1") { title } }'), { content: [{ type: 'text', text: '{"data":{"confluence_page":{"title":"x"}}}' }] }).confirms, undefined)
})
