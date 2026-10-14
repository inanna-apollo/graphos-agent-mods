import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { resultLines } from '../../src/view/outcome.ts'
import type { CallOutcome } from '../../types/index.d.ts'

test('two aliases of one field keep their own values and observed denial in the preview', () => {
  const ir = buildIR('aliases', normalize('query People { jira_people { id allowed: email denied: email } }', {}))
  const outcome = outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify({ data: { jira_people: [{ id: 'person-1', allowed: 'visible@example.test', denied: null }] }, errors: [{ message: 'Hidden', path: ['jira_people', 0, 'denied'], extensions: { code: 'CONSTELLATION_ACCESS_DENIED' } }] }) }] })
  const preview = resultLines(outcome, ir).find(line => line.kind === 'preview')
  assert.equal(preview?.kind, 'preview')
  if (preview?.kind !== 'preview') return
  const fields = preview.items[0]?.fields ?? []
  assert.ok(fields.some(field => field.path === 'jira_people.allowed' && field.value === 'visible@example.test' && field.denial === undefined))
  assert.ok(fields.some(field => field.path === 'jira_people.denied' && field.denial !== undefined && field.value === undefined))
})

test('ambiguous legacy names leave a denial separate from sibling values', () => {
  const ir = buildIR('old-aliases', normalize('query People { jira_people { id allowed: email denied: email } }', {}))
  const outcome: CallOutcome = { rows: [{ field: 'jira_people', root: 'jira_people', count: 1 }], errors: [], authLinks: [], preview: [{ field: 'jira_people', root: 'jira_people', more: 0, items: [{ label: 'person-1', fields: [{ name: 'email', value: 'one@example.test' }, { name: 'email', value: 'two@example.test' }], denied: [{ field: 'email', classification: 'private', isRequestable: true }] }] }] }
  const preview = resultLines(outcome, ir).find(line => line.kind === 'preview')
  assert.equal(preview?.kind, 'preview')
  if (preview?.kind !== 'preview') return
  const fields = preview.items[0]?.fields ?? []
  assert.deepEqual(fields.filter(field => field.value !== undefined).map(field => field.value), ['one@example.test', 'two@example.test'])
  assert.equal(fields.filter(field => field.denial !== undefined).length, 1)
})
