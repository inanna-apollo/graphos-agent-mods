import assert from 'node:assert/strict'
import { test } from 'node:test'

import { spinnerTextOf } from '../../src/view/spinner.ts'
import { reviewCall } from '../../tests/review-fixtures.ts'

const withSummary = (headline: string | undefined) => {
  const { ir } = reviewCall('pending')
  const { summary: _dropped, ...bare } = ir
  return headline === undefined ? bare : { ...bare, summary: { headline } }
}

test('the spinner reads the headline as one line, without its closing full stop (the spinner adds its own ellipsis)', () => {
  assert.equal(spinnerTextOf(withSummary('Search Jira for open DEV issues.')), 'Search Jira for open DEV issues')
  assert.equal(spinnerTextOf(withSummary('Reads\n  two   things.  ')), 'Reads two things')
})

test('a headline’s field refs read as the bare field name', () => {
  assert.equal(spinnerTextOf(withSummary('List the [[Acme_Customer_Data_Member.name]] of the org')), 'List the name of the org')
})

test('with no headline it reads Agent Services and the operation’s name; with no name, its root fields', () => {
  assert.equal(spinnerTextOf(withSummary(undefined)), 'Agent Services · ReviewSample')
  assert.match(spinnerTextOf({ ...withSummary(undefined), opName: undefined }), /^Agent Services · jira_/)
  assert.equal(spinnerTextOf({ ...withSummary(undefined), opName: undefined, roots: [] }), 'Agent Services')
})

test('a headline or an operation name is escaped and bounded, never drawn as it came', () => {
  const headline = spinnerTextOf(withSummary('Read \x1b[2J\x07 this ‮ now'))
  assert.doesNotMatch(headline, /[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/)
  const named = spinnerTextOf({ ...withSummary(undefined), opName: 'Name\x1b]0;x\x07' })
  assert.doesNotMatch(named, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  assert.ok(spinnerTextOf(withSummary('x'.repeat(50_000))).length <= 401)
  assert.ok(spinnerTextOf({ ...withSummary(undefined), opName: 'N'.repeat(50_000) }).length <= 230)
})
