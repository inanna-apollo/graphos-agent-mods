// Synthetic inputs for focused Inspector hardening and native-pane review.
// No payload in this file was copied from a customer or a live service.
import type { InspectedCall, LookupTool } from '../../types/index.d.ts'
import { adaptLookup, settledLookup, pendingIR } from '../../src/lookup.ts'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const answer = (value: unknown) => ({ value, bytes: new TextEncoder().encode(JSON.stringify(value)).length })

export function lookupCall(tool: LookupTool, id: string, input: unknown, response: unknown): InspectedCall {
  const adapted = adaptLookup(tool, input)
  const base = {
    id,
    tool,
    input: adapted.input,
    server: SERVER,
    operation: adapted.operation,
    variables: adapted.variables,
    status: 'ran' as const,
    arrivedAt: 0,
    ...(adapted.error !== undefined && { inputError: adapted.error }),
  }
  const { value, bytes } = answer(response)
  const settled = settledLookup(id, tool, adapted, value, bytes)
  return { ...base, ir: settled.ir, found: settled.found }
}

const issueRows = [
  { key: 'SYN-104', fields: { summary: 'Add a compact export view' } },
  { key: 'SYN-118', fields: { summary: 'Document retry behavior for connectors' } },
  { key: 'SYN-123', fields: { summary: 'Keep project filters after refresh' } },
]

/** Execute-shaped fixture: three Jira issue key/title rows and readable multiline JQL. */
export const jiraThreeRows = {
  operation: `query SyntheticJiraSearch {
  jira_searchIssues(
    jql: "project = SYN AND statusCategory != Done\\nORDER BY updated DESC",
    maxResults: 3,
    fields: ["summary"]
  ) {
    issues { key fields }
    isLast
  }
}`,
  variables: {},
  response: { data: { jira_searchIssues: { issues: issueRows, isLast: true } }, errors: [] },
} as const

const SEARCH_TYPES = [
  `type Query {
    """Search synthetic issues with JQL and return a page of issue records."""
    jira_searchIssues(jql: String!, maxResults: Int, fields: [String!], startAt: Int): Jira_SearchPage
    """Count synthetic issues matching JQL."""
    jira_countIssues(jql: String!): Jira_Count
    """Fetch one synthetic issue by key."""
    jira_getIssue(key: String!): Jira_Issue
    """Read a synthetic project by key."""
    jira_project(key: String!): Jira_Project
    """List recently updated synthetic issues."""
    jira_recentIssues(maxResults: Int, after: String): Jira_SearchPage
  }`,
  'type Jira_SearchPage { issues: [Jira_Issue!]! isLast: Boolean total: Int }',
  'type Jira_Issue { key: String! fields: JSON }',
  'type Jira_Count { count: Int! }',
  'type Jira_Project { key: String! name: String! }',
  'scalar JSON',
]

/** Five ranked query operations, including required and optional arguments. */
export const searchFiveOperations = lookupCall('search', 'hardening-search-five', {
  terms: ['jira', 'issues'], scope: 'jira', operationType: 'query',
}, {
  bundleDigest: 'synthetic-bundle',
  results: ['jira_searchIssues', 'jira_countIssues', 'jira_getIssue', 'jira_project', 'jira_recentIssues'].map((operationName, i) => ({
    operationName, operationType: 'query', scope: 'jira', score: 0.05 - i * 0.005, types: SEARCH_TYPES,
  })),
})

/** An enum with four members. */
export const enumFour = lookupCall('introspect', 'hardening-enum-four', {
  scope: 'jira', type: 'Jira_IssueStatus', depth: 1,
}, {
  types: ['"Synthetic issue lifecycle state." enum Jira_IssueStatus { OPEN IN_PROGRESS BLOCKED DONE }'],
})

/** An enum with 61 members, exercising the stored member cap. */
export const enumSixtyOne = lookupCall('introspect', 'hardening-enum-sixty-one', {
  scope: 'jira', type: 'Synthetic_Code', depth: 1,
}, {
  types: [`enum Synthetic_Code { ${Array.from({ length: 61 }, (_, i) => `CODE_${String(i + 1).padStart(2, '0')}`).join(' ')} }`],
})

/** An object with 41 fields, exercising the displayed child-field cap. */
export const objectFortyOneFields = lookupCall('introspect', 'hardening-object-forty-one', {
  scope: 'jira', type: 'Synthetic_Record', depth: 1,
}, {
  types: [`type Synthetic_Record { ${Array.from({ length: 41 }, (_, i) => `field${String(i + 1).padStart(2, '0')}: String`).join(' ')} }`],
})

/** A root field description longer than a terminal pane can usefully show. */
export const longRootDescription = lookupCall('search', 'hardening-long-description', {
  terms: ['synthetic long description'], scope: 'jira',
}, {
  results: [{
    operationName: 'jira_syntheticOverview', operationType: 'query', scope: 'jira',
    types: [`type Query { """${'Synthetic documentation for this root field. '.repeat(100)}""" jira_syntheticOverview(limit: Int): [Synthetic_Record!]! }`, 'type Synthetic_Record { id: ID! }'],
  }],
})

/** Execute-shaped mixed response: useful data plus a masked field and a denied field error. */
export const partialResultsMaskedDenied = {
  operation: `query SyntheticPartial {
  jira_searchIssues(jql: "project = SYN", maxResults: 2) {
    issues { key fields }
    total
  }
}`,
  variables: {},
  response: {
    data: { jira_searchIssues: { issues: [
      { key: 'SYN-201', fields: { summary: 'Synthetic visible title', privateNote: null } },
      { key: 'SYN-202', fields: { summary: 'Another synthetic title', privateNote: null } },
    ], total: 2 } },
    errors: [
      { message: 'A synthetic field was masked.', path: ['jira_searchIssues', 'issues', 0, 'fields', 'privateNote'], extensions: { code: 'FIELD_MASKED' } },
      { message: 'A synthetic field was denied.', path: ['jira_searchIssues', 'issues', 1, 'fields', 'privateNote'], extensions: { code: 'FIELD_ACCESS_DENIED' } },
    ],
  },
} as const

/** Proposed-write preview input only. Never execute this fixture. */
export const proposedWriteSyntheticOnly = {
  operation: `mutation SyntheticCreate {
  jira_createIssue(fields: { project: "SYN", summary: "Synthetic preview only" }) { key }
}`,
  variables: {},
}

/** A valid, comment-padded GraphQL operation of about 100,000 characters. */
export const largeInputOver9000Chars = {
  operation: `${'# synthetic size-boundary padding; '.repeat(3_000)}\nquery SyntheticLargeInput { jira_countIssues(jql: "project = SYN") { count } }`,
  variables: {},
}

/** Unicode and control text used to review escaping in terminal output and hover cards. */
export const unicodeAndTerminalStrings = {
  combining: 'Cafe\u0301',
  cjk: '東京・グラフ',
  flag: '🇯🇵',
  zwj: '👩‍💻',
  terminalEscape: '\u001b[31mred synthetic text\u001b[0m',
  operation: 'query SyntheticUnicode { jira_searchIssues(jql: "project = SYN AND text ~ \\\"Café 東京 🇯🇵 👩‍💻 \\u001b[31m\\\"", maxResults: 1) { issues { key } } }',
} as const

/** All lookup cases in a stable order for a fixture-driven review loop. */
export const hardeningLookups: readonly InspectedCall[] = [
  searchFiveOperations,
  enumFour,
  enumSixtyOne,
  objectFortyOneFields,
  longRootDescription,
]

/** Optional pending counterpart for checks of the waiting state. */
export function pendingSearchFiveOperations(): InspectedCall {
  const adapted = adaptLookup('search', { terms: ['jira', 'issues'], scope: 'jira', operationType: 'query' })
  return {
    id: 'hardening-search-five-pending', tool: 'search', input: adapted.input, server: SERVER,
    operation: adapted.operation, variables: adapted.variables, status: 'pending', arrivedAt: 0,
    ir: pendingIR('hardening-search-five-pending', 'search', adapted),
  }
}
