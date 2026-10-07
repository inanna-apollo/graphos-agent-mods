// Calls the pane reviews were run against, for the text renderer: a Jira
// search with an org's members (email denied on every member), a four-root
// overview whose lists came back longer than they asked for, and a list of
// record keys alone.
import type { InspectedCall } from '../types'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import type { CallIR, Summary } from '../src/ir.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf, savedOutcome } from '../src/result.ts'
import { LINKS } from '../test/unit/link-fixture.ts'
import { indexSdl } from '../src/schema.ts'

const SEARCH = 'jira_searchAndReconsileIssuesUsingJql'
const MEMBERS = 'acme_customer_data_listOrganizationMembers'

const SDL = [
  `type Query {
    "Search for issues using JQL enhanced search (GET) Returns one page; iterate until a short or empty page is returned."
    ${SEARCH}("Search query in JQL." jql: String, "Maximum of 5000 issues per page." maxResults: Int, fields: [String!], "The token for a page to fetch that is not the first page." nextPageToken: String): Jira_SearchAndReconcileResults
    "Count issues using JQL"
    jira_countIssues(jql: String): Jira_Count
    "List organization members."
    ${MEMBERS}(orgId: ID!): [Acme_Customer_Data_Member]
    "List incidents."
    incidentio_incidents(pageSize: Int, statusCategory: [String!]): [IncidentIO_Incident]
  }`,
  'type Jira_SearchAndReconcileResults { issues: [Jira_Issue!]! isLast: Boolean nextPageToken: String }',
  'scalar JSON',
  'type Jira_Issue { key: String fields: JSON }',
  'type Jira_Count { count: Int }',
  'type Acme_Customer_Data_Member { id: ID name: String role: String """Personal contact data (x-data-classification: pii.contact in the source).""" email: String }',
  'type IncidentIO_Incident { reference: String name: String createdAt: String creator: IncidentIO_Actor }',
  'type IncidentIO_Actor { user: IncidentIO_User }',
  'type IncidentIO_User { name: String email: String }',
]

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const TOKEN = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({
  service_name: 'acme-customer-data',
  blocked_fields: [{ coord: 'Acme_Customer_Data_Member.email', classification: 'pii-high', reason: '', rule_id: 'rule-secret' }],
})}.${b64('signature')}`

const denied = (root: string, index: number) => ({
  extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: TOKEN, visibility: 'requestable', reason: '' },
  message: '',
  path: [root, String(index), 'email'],
})

const PEOPLE = ['Leo Marsh', 'Sam Ito', 'Dana Okafor', 'Jordan Lee']
const ISSUES = [
  ['DEV-634', 'Add CSV export to the reports page'],
  ['DEV-467', 'Research: Connect the Acme exporter with other storage vendors'],
  ['DEV-589', 'Support nested folder rules when checking quota eligibility'],
  ['DEV-547', 'Document plugin lifecycle callbacks and registration points'],
  ['DEV-522', 'Declare retry support in the client settings type'],
]

function irOf(operation: string, variables: Record<string, unknown>, deny: string[]): CallIR {
  const ir = buildIR('toolu_review', normalize(operation, variables))
  const fields = new Map<string, FieldDecision>()
  const visit = (field: CallIR['roots'][number]) => {
    fields.set(field.path, { decision: deny.includes(field.path) ? 'deny' : 'allow', ...(deny.includes(field.path) && { denialContext: TOKEN }) })
    field.children.forEach(visit)
  }
  ir.roots.forEach(visit)
  const annotated = annotate(ir, { schema: indexSdl(SDL), access: { denyOperation: false, fields }, validation: { valid: true, diagnostics: [] }, scope: 'jira', isIncomplete: false })
  for (const root of annotated.roots) root.service = root.name.startsWith('acme') ? 'acme-customer-data' : root.name.startsWith('incidentio') ? 'incidentio' : 'jira'
  return { ...annotated, services: [...new Set(annotated.roots.map(root => root.service ?? ''))] }
}

function callOf(ir: CallIR, operation: string, response: unknown, status: InspectedCall['status'], headline: string): InspectedCall {
  const summary: Summary = { headline, isDegraded: false, corrected: [] } as never
  const shown = { ...ir, summary }
  return {
    id: 'toolu_review',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation,
    variables: '{}',
    status,
    arrivedAt: Date.UTC(2026, 9, 6),
    ir: shown,
    ...(status === 'ran' && { outcome: outcomeOf(shown, { content: [{ type: 'text', text: JSON.stringify(response) }] }, LINKS) }),
  }
}

const REVIEW_OP = `query ReviewSample {
  open: ${SEARCH}(jql: "project = DEV AND statusCategory != Done ORDER BY updated DESC", maxResults: 5, fields: ["summary", "status"]) { issues { key fields } isLast nextPageToken }
  members: ${MEMBERS}(orgId: "demo-org-01") { id name role email }
}`

/** ReviewSample: five open DEV issues and four members, each member's email denied. */
export function reviewCall(status: InspectedCall['status'] = 'ran'): InspectedCall {
  const ir = irOf(REVIEW_OP, {}, ['members.email'])
  const response = {
    data: {
      open: { issues: ISSUES.map(([key, summary]) => ({ key, fields: { summary, status: { name: 'Open' } } })), isLast: false, nextPageToken: 'tok' },
      members: PEOPLE.map((name, index) => ({ id: `mem_${name.split(' ')[0]?.toLowerCase()}`, name, role: index === 0 ? 'OWNER' : 'ADMIN', email: null })),
    },
    errors: PEOPLE.map((_, index) => denied('members', index)),
  }
  return callOf(ir, REVIEW_OP, response, status, 'Search Jira for open DEV issues and list the demo-org-01 org members (email blocked).')
}

const GNARLY_OP = `query GnarlyOverview {
  open: ${SEARCH}(jql: "project = DEV AND statusCategory != Done ORDER BY updated DESC", maxResults: 3, fields: ["summary"]) { issues { key fields } isLast }
  total: jira_countIssues(jql: "project = DEV AND statusCategory != Done") { count }
  incidents: incidentio_incidents(pageSize: 3, statusCategory: ["live", "closed"]) { reference name createdAt creator { user { name email } } }
  members: ${MEMBERS}(orgId: "demo-org-01") { id name email }
}`

/** GnarlyOverview: four roots on three services; Jira and incident.io return far more than asked. */
export function gnarlyCall(status: InspectedCall['status'] = 'ran'): InspectedCall {
  const ir = irOf(GNARLY_OP, {}, ['members.email'])
  const response = {
    data: {
      open: { issues: Array.from({ length: 50 }, (_, i) => ({ key: `DEV-${700 - i}`, fields: { summary: `Issue ${i}` } })), isLast: false },
      total: { count: 412 },
      incidents: Array.from({ length: 25 }, (_, i) => ({ reference: `INC-${90 - i}`, name: `Incident ${i}`, createdAt: '2026-10-01T19:17:11.000Z', creator: { user: { name: 'Leo', email: 'leo@example.com' } } })),
      members: PEOPLE.map(name => ({ id: `mem_${name.split(' ')[0]?.toLowerCase()}`, name, email: null })),
    },
    errors: PEOPLE.map((_, index) => denied('members', index)),
  }
  return callOf(ir, GNARLY_OP, response, status, 'Overview of open DEV work, live incidents and org members, in one call.')
}

/**
 * A batch of aliased lookups, one root each, alternating two services: an org's
 * members (every email denied) and a project's issue count. Enough roots that
 * the pane sheds root by root.
 */
export function batchCall(count: number): InspectedCall {
  const isMembers = (index: number) => index % 2 === 0
  const alias = (index: number) => (isMembers(index) ? `m${index}` : `c${index}`)
  const lines = Array.from({ length: count }, (_, i) => (isMembers(i) ? `  ${alias(i)}: ${MEMBERS}(orgId: "org-${i}") { id name email }` : `  ${alias(i)}: jira_countIssues(jql: "project = P${i}") { count }`))
  const operation = `query Batch {\n${lines.join('\n')}\n}`
  const ir = irOf(operation, {}, Array.from({ length: count }, (_, i) => `${alias(i)}.email`))
  const two = PEOPLE.slice(0, 2)
  const response = {
    data: Object.fromEntries(Array.from({ length: count }, (_, i) => [alias(i), isMembers(i) ? two.map(name => ({ id: `mem_${name.split(' ')[0]?.toLowerCase()}`, name, email: null })) : { count: 10 * i }])),
    errors: Array.from({ length: count }, (_, i) => i).flatMap(i => (isMembers(i) ? two.map((_, index) => denied(alias(i), index)) : [])),
  }
  return callOf(ir, operation, response, 'ran', `Look up the members of ${Math.ceil(count / 2)} orgs and count the issues in ${Math.floor(count / 2)} projects, in one batch.`)
}

/** A Jira list whose rows are keys alone, each a record link: the title-only layout, keys long enough to wrap. */
export function titlesCall(): InspectedCall {
  const operation = 'query Keys { jira_searchIssues(jql: "project = DEV", maxResults: 4) { issues { key } } }'
  const ir = buildIR('toolu_keys', normalize(operation, {}))
  const keys = ['DEV-634', 'LONGPROJECTKEY_WITH_A_VERY_LONG_NAME-1234', 'DEV-589', 'ANOTHER_RATHER_LONG_PROJECT_KEY-7']
  const response = { data: { jira_searchIssues: { issues: keys.map(key => ({ key })) } } }
  return {
    id: 'toolu_keys',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation,
    variables: '{}',
    status: 'ran',
    arrivedAt: Date.UTC(2026, 9, 6),
    ir,
    outcome: outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify(response) }] }, LINKS),
  }
}

const HEAVY_OP = `query HeavySearch {
  ${SEARCH}(jql: "project = DEV ORDER BY updated DESC", maxResults: 40, fields: ["summary", "description"]) { issues { key fields } isLast }
}`
/** Forty issues, each with a description of about a kilobyte: one field is nearly all of a response over 40 KB. */
const HEAVY_RESPONSE = {
  data: {
    [SEARCH]: {
      issues: Array.from({ length: 40 }, (_, i) => ({ key: `DEV-${900 - i}`, fields: { summary: `Issue ${i}: the plan cache misses after a schema change`, description: `Steps to reproduce ${i}. `.repeat(45), status: { name: 'Open' } } })),
      isLast: false,
    },
  },
}

/** HeavySearch: the context line names `description` (about 90%), and a flag says it. */
export function heavyCall(): InspectedCall {
  const ir = irOf(HEAVY_OP, {}, [])
  return callOf(ir, HEAVY_OP, HEAVY_RESPONSE, 'ran', 'Search Jira for the 40 newest DEV issues, with their summaries and descriptions.')
}

/** The same search whose response Claude Code saved to a file and showed Claude a preview of: the mod read the file back. */
export function persistedCall(): InspectedCall {
  const call = heavyCall()
  return { ...call, outcome: savedOutcome(outcomeOf(call.ir, { content: [{ type: 'text', text: JSON.stringify(HEAVY_RESPONSE) }] }, LINKS)) }
}

/** The same search, kept out of the context and not read back: all the pane has is Claude Code's own size for it. */
export function keptOutCall(): InspectedCall {
  const call = heavyCall()
  const stand = '<persisted-output>\nOutput too large (58.2KB). Full output saved to: /Users/x/.claude/projects/-p/abc/tool-results/toolu_heavy.json\n\nPreview (first 2KB):\n[\n  {\n    "type": "text"\n...\n</persisted-output>'
  return { ...call, outcome: outcomeOf(call.ir, stand, LINKS) }
}

const RELAY = `query OpenWork {
  issues: github_search(query: "repo:acme/router is:open", first: 6) { totalCount edges { cursor node { title number updatedAt } } pageInfo { hasNextPage endCursor } }
  accounts: acme_accounts(limit: 3) { id email }
}`

/** A Relay connection (rows inside `edges { node }`, titles long enough to wrap) beside a list whose records nothing names but their ids. */
export function relayCall(): InspectedCall {
  const ir = buildIR('toolu_relay', normalize(RELAY, {}))
  const titles = ['Plan cache misses after a schema change', 'Router drops the trace header when a subgraph times out and the retry policy kicks in', 'Docs: connectors', 'Support @defer in batched requests', 'Fix flaky test', 'Bump hyper']
  const response = {
    data: {
      issues: { totalCount: 212, edges: titles.map((title, i) => ({ cursor: `Y3Vyc29yOnYyOpK${i}`, node: { title, number: 7000 + i, updatedAt: '2026-10-01T19:17:11Z' } })), pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29yOnYyOpK5' } },
      accounts: ['acct_01J9Z8', 'acct_01J9Z9', 'acct_01JA00'].map((id, i) => ({ id, email: `user${i}@example.com` })),
    },
  }
  return { id: 'toolu_relay', server: 'claude_ai_GraphOS_Agent_Services', operation: RELAY, variables: '{}', status: 'ran', arrivedAt: Date.UTC(2026, 9, 6), ir, outcome: outcomeOf(ir, JSON.stringify(response), LINKS) }
}

const DIRECTORY = 'query TeamDirectory { people: slack_users(limit: 8) { members { name realName profile { email } } } }'
// More members than RESULT shows as rows, so the denials are listed as lines too (as in a real directory page).
const NAMES = ['ada', 'lin', 'kai', 'ren', 'sol', 'tao', 'uma', 'vik']
const deniedField = (index: number, field: string) => ({
  message: 'Field requires explicit access request via the Access Request workflow.',
  path: ['people', 'members', String(index), field],
  extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: 'header.payload.signature', visibility: 'requestable' },
})

/** A people directory page whose realName and profile are denied and requestable: more members than RESULT shows, so the denials are listed as lines with their own press. */
export function directoryCall(): InspectedCall {
  const ir = buildIR('t1', normalize(DIRECTORY, {}))
  const response = {
    data: { people: { members: NAMES.map(name => ({ name, realName: null, profile: null })) } },
    errors: NAMES.flatMap((_, index) => [deniedField(index, 'realName'), deniedField(index, 'profile')]),
  }
  return { id: 't1', server: 'gas', status: 'ran', owner: 'test', arrivedAt: 0, operation: DIRECTORY, variables: '', ir, outcome: outcomeOf(ir, JSON.stringify(response), LINKS) } as InspectedCall
}
