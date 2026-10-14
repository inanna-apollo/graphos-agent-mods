// Synthetic evidence/lifecycle cases for the native production view. No service calls.
import type { CheckContext, InspectedCall, ResolvedCall } from '../../types/index.d.ts'
import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { overviewOf } from '../../src/call-cache.ts'
import { configOf } from '../../src/links.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { indexSdl } from '../../src/schema.ts'
import { jiraThreeRows, lookupCall, pendingSearchFiveOperations } from './hardening.ts'

const schema = indexSdl([
  `type Query { jira_searchIssues(jql: String!, maxResults: Int, fields: [String!]): Jira_Page }`,
  'type Jira_Page { issues: [Jira_Issue!]! isLast: Boolean }',
  'type Jira_Issue { key: String! fields: JSON }',
  'scalar JSON',
])
const links = configOf({ user: '[bases]\natlassian = "https://example.atlassian.net"\n' })
const ir = annotate(buildIR('polish-restored', normalize(jiraThreeRows.operation, {})), { schema, scope: 'jira', isIncomplete: true })
const restored: InspectedCall = {
  id: 'polish-restored', server: 'claude_ai_GraphOS_Agent_Services',
  operation: jiraThreeRows.operation, variables: '{}', status: 'ran', arrivedAt: 0,
  ir: { ...ir, summary: { headline: 'Reads three recent project issues with their keys and summaries.' } },
  outcome: outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify(jiraThreeRows.response) }] }, links),
}
const context: CheckContext[] = (['schema', 'validation', 'policy'] as const).map(check => ({
  check, source: 'enrichment', target: { kind: 'call' }, tool: 'search', outcome: 'not-allowed', decision: 'ask',
}))
const checks: InspectedCall = {
  ...restored, id: 'polish-checks',
  ir: { ...restored.ir, checks: { schema: 'not-allowed', validation: 'not-allowed', policy: 'not-allowed', context } },
}
const trusted: InspectedCall = { ...restored, id: 'polish-trusted', trust: { isAllowed: true, fits: [{ root: 'jira_searchIssues', rule: 'ProjectIssues', reasons: ['Read issue keys and summary payloads for the synthetic project.'] }] } }
const { outcome: _result, ...pendingChecks } = checks
const { outcome: _trustedResult, ...interrupted } = trusted
const auth: InspectedCall = { ...restored, id: 'polish-auth', outcome: outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify({
  data: null,
  errors: [{ message: 'A linked Jira account is needed.', extensions: { code: 'UPSTREAM_AUTH_REQUIRED', service: 'jira', sources: [{ authorizationUrl: 'https://gas.example.com/auth/jira/link', name: 'jira' }] } }],
}) }] }, links) }
const operation = 'query SyntheticCheck { jira_searchIssues(jql: "project = SYN", maxResults: 3) { issues { key fields } } }'
const validateInput = { scope: 'jira', operation }

export const polishFixtures: Record<string, ResolvedCall> = {
  restored,
  checks,
  pendingchecks: { ...pendingChecks, id: 'polish-pending-checks', status: 'pending' },
  trusted,
  auth,
  denied: { ...pendingChecks, id: 'polish-denied', status: 'denied' },
  errored: { ...pendingChecks, id: 'polish-errored', status: 'errored' },
  interrupted: { ...interrupted, id: 'polish-interrupted', status: 'interrupted' },
  expired: { ...overviewOf(restored, 'expired'), id: 'polish-expired' },
  oversize: { ...overviewOf(restored, 'oversize'), id: 'polish-oversize' },
  pendingsearch: pendingSearchFiveOperations(),
  searchunknown: lookupCall('search', 'polish-search-unknown', { terms: ['issues'] }, {}),
  searchzero: lookupCall('search', 'polish-search-zero', { terms: ['issues'] }, { results: [] }),
  typeunknown: lookupCall('introspect', 'polish-type-unknown', { scope: 'jira', type: 'Jira_Issue' }, {}),
  input: lookupCall('introspect', 'polish-input', { scope: 'jira', type: 'IssueFilter' }, { types: ['"Configure issue searches." input IssueFilter { project: String! limit: Int = 3 }'] }),
  interface: lookupCall('introspect', 'polish-interface', { scope: 'jira', type: 'Record' }, { types: ['"A record with a stable identity." interface Record { id: ID! }'] }),
  union: lookupCall('introspect', 'polish-union', { scope: 'jira', type: 'SearchResult' }, { types: ['union SearchResult = Issue | Project', 'type Issue { key: String! }', 'type Project { name: String! }'] }),
  invalid: lookupCall('validate', 'polish-invalid', validateInput, { valid: false, errors: ['Cannot query field "fields" on type "Jira_Issue".'] }),
  validationmissing: lookupCall('validate', 'polish-validation-missing', validateInput, {}),
  drymissing: lookupCall('dry_run', 'polish-dry-missing', { requests: [{ scope: 'jira', operation }] }, {}),
  drymixed: lookupCall('dry_run', 'polish-dry-mixed', { requests: [{ scope: 'jira', operation }, { scope: 'jira', operation }] }, { results: [
    { denyOperation: false, fields: [{ path: 'jira_searchIssues.issues.key', decision: 'allow' }, { path: 'jira_searchIssues.issues.fields', decision: 'allow' }] },
    { denyOperation: true, fields: [] },
  ] }),
}
