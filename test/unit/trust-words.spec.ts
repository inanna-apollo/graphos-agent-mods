import test from 'node:test'
import assert from 'node:assert/strict'
import { trustFacts, trustLineOf, trustVerdictOf } from '../../src/view/trust.ts'
import type { TrustFit } from '../../types/index.d.ts'

const fit: TrustFit = { isAllowed: true, fits: [{ root: 'jira_searchIssues', rule: 'IssueReads', reasons: ['Only the selected issue fields.'] }] }

test('a trust match establishes permission, never an execution outcome on its own', () => {
  for (const status of ['pending', 'interrupted', 'denied', 'errored'] as const) {
    assert.match(trustLineOf(fit, status)!.text, /permitted/)
    assert.doesNotMatch(trustVerdictOf(fit, status)!, /ran|✓/)
    assert.doesNotMatch(trustFacts(fit, status).join('\n'), /The call ran/)
  }
  assert.match(trustVerdictOf(fit, 'ran')!, /ran without asking/)
  assert.match(trustFacts(fit, 'interrupted').join('\n'), /whether execution completed is unknown/)
})

test('an unmatched Inspector rule does not claim the host asked for permission', () => {
  const mismatch: TrustFit = { isAllowed: false, reason: 'The requested fields exceed the rule.' }
  assert.doesNotMatch(trustLineOf(mismatch)!.text, /asked/)
  assert.equal(trustVerdictOf(mismatch), undefined)
  const facts = trustFacts(mismatch).join('\n')
  assert.match(facts, /requested fields exceed/)
  assert.match(facts, /cannot override a denial or an organization restriction/)
  assert.deepEqual(trustFacts(undefined), [])
})
