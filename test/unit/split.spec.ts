import assert from 'node:assert/strict'
import { test } from 'node:test'

import { subOperation } from '../../src/split.ts'

const OP = `query Gnarly($jql: String!, $size: Int = 3, $withRoles: Boolean!, $unused: String) {
  open: jira_search(jql: $jql, maxResults: $size) { ... on Jira_Results { issues { key } } }
  total: jira_countIssues(jql: $jql) { count }
  incidents: incidentio_incidents(pageSize: $size) { ...Bits roles @include(if: $withRoles) { name } }
  members: acme_customer_data_listMembers(orgId: "x") { id ...Person }
}
fragment Bits on IncidentIO_Incident { ref: reference ...Sev }
fragment Sev on IncidentIO_Incident { severity { name } }
fragment Person on Acme_Member { email }`
const VARS = { jql: 'project = A', withRoles: true, unused: 'x' }

const only = (...names: string[]) => subOperation(OP, VARS, field => names.includes(field))!

test('keeps only the scope\'s roots, with the operation name', () => {
  const sub = only('jira_search', 'jira_countIssues')
  assert.match(sub.operation, /^query Gnarly\(/)
  assert.match(sub.operation, /jira_search/)
  assert.match(sub.operation, /jira_countIssues/)
  assert.doesNotMatch(sub.operation, /incidentio_incidents|acme_customer_data/)
})

test('aliases are kept as written', () => {
  const sub = only('jira_search', 'jira_countIssues')
  assert.match(sub.operation, /open: jira_search/)
  assert.match(sub.operation, /total: jira_countIssues/)
})

test('fragments are kept when reached, transitively, and dropped otherwise', () => {
  const incidents = only('incidentio_incidents').operation
  assert.match(incidents, /fragment Bits on IncidentIO_Incident/)
  assert.match(incidents, /fragment Sev on IncidentIO_Incident/)
  assert.doesNotMatch(incidents, /fragment Person/)
  const jira = only('jira_search').operation
  assert.doesNotMatch(jira, /fragment /)
  // An inline fragment stays in place.
  assert.match(jira, /\.\.\. on Jira_Results/)
  assert.match(only('acme_customer_data_listMembers').operation, /fragment Person/)
})

test('variables are pruned to the ones the kept roots use, with their defaults', () => {
  const jira = only('jira_search')
  assert.match(jira.operation, /\$jql: String!/)
  assert.match(jira.operation, /\$size: Int = 3/)
  assert.doesNotMatch(jira.operation, /\$withRoles|\$unused/)
  assert.deepEqual(jira.variables, { jql: 'project = A' })
  const members = only('acme_customer_data_listMembers')
  assert.doesNotMatch(members.operation, /\$jql|\$size|\$withRoles/)
  assert.deepEqual(members.variables, {})
})

test('@include on a nested field keeps the variable it reads, and the directive', () => {
  const incidents = only('incidentio_incidents')
  assert.match(incidents.operation, /@include\(if: \$withRoles\)/)
  assert.match(incidents.operation, /\$withRoles: Boolean!/)
  assert.deepEqual(incidents.variables, { withRoles: true })
})

test('a variable used only inside a reached fragment is kept', () => {
  const op = 'query Q($n: Int, $skip: Boolean) { a_one { ...F } b_two { x } } fragment F on T { y(first: $n) z @skip(if: $skip) }'
  const sub = subOperation(op, { n: 2, skip: false }, field => field === 'a_one')!
  assert.match(sub.operation, /\$n: Int/)
  assert.match(sub.operation, /\$skip: Boolean/)
  assert.doesNotMatch(sub.operation, /b_two/)
})

test('a root-level fragment is reduced to the roots kept', () => {
  const op = 'query Q { ...R } fragment R on Query { a_one { x } b_two { y } }'
  const sub = subOperation(op, {}, field => field === 'b_two')!
  assert.match(sub.operation, /b_two/)
  assert.doesNotMatch(sub.operation, /a_one/)
})

test('the result still parses, and nothing kept gives undefined', () => {
  const sub = only('jira_search')
  assert.equal(subOperation(sub.operation, sub.variables, () => true)?.operation, sub.operation)
  assert.equal(subOperation(OP, VARS, () => false), undefined)
  assert.equal(subOperation('{ nope(', {}, () => true), undefined)
})
