// Lookups for the text renderer and the hook tests: Claude's search,
// introspect, validate and dry_run calls, each run through the real parsers
// (src/lookup.ts) on canned answers in the shapes Agent Services sends.
// The content is synthetic.
import type { InspectedCall, LookupTool } from '../types'

import { adaptLookup, pendingIR, settledLookup } from '../src/lookup.ts'

export const SEARCH_SDL = [
  `type Query {
  """
  Search Confluence content with CQL. \`cql\` is required, e.g. \`type=page AND space=DEV\`. Requires the search:confluence and read:confluence-content.summary scopes.
  """
  confluence_search(cql: String!, cursor: String, limit: Int): Confluence_SearchResult
}
`,
  '"""A page of CQL search results."""\ntype Confluence_SearchResult {\n  results: [Confluence_SearchResultItem!]\n  totalSize: Int\n  next: String\n}\n',
  'type Confluence_SearchResultItem {\n  """The page title."""\n  title: String\n  url: String\n  excerpt: String\n}\n',
]

const GLEAN_SDL = [
  `type Query {
  """Full-text search over everything the user can see in Glean. Page with \`cursor\` while \`hasMoreResults\` is true."""
  glean_search(
    """Search terms, in Glean query syntax."""
    query: String!,
    """Results per page."""
    pageSize: Int! = 10,
    cursor: String,
    """Facet filters."""
    facetFilters: [Glean_FacetFilterInput!],
  ): Glean_SearchResponse
}
`,
  '"""One page of Glean search results."""\ntype Glean_SearchResponse {\n  results: [Glean_SearchResult]\n  cursor: String\n  hasMoreResults: Boolean\n}\n',
  'type Glean_SearchResult {\n  title: String\n  url: String\n}\n',
  '"""A facet filter."""\ninput Glean_FacetFilterInput {\n  fieldName: String!\n  values: [String!]!\n  relation: Glean_Relation = EQUALS\n}\n',
  'enum Glean_Relation {\n  EQUALS\n  NOT_EQUALS\n}\n',
]

const JIRA_WRITE_SDL = ['type Mutation {\n  """Create an issue."""\n  jira_createIssue(fields: JSON!): Jira_Created\n}\n', 'scalar JSON', 'type Jira_Created {\n  id: ID\n  key: String\n}\n']

export const SCOPES = ['acme-customer-data', 'confluence', 'glean', 'google-drive', 'jira', 'slack']

const answer = (value: unknown) => ({ value, bytes: JSON.stringify(value).length })

function lookup(tool: LookupTool, id: string, raw: unknown, response?: unknown, status: InspectedCall['status'] = 'ran'): InspectedCall {
  const adapted = adaptLookup(tool, raw)
  const base = { id, tool, input: adapted.input, server: 'claude_ai_GraphOS_Agent_Services', operation: adapted.operation, variables: adapted.variables, status, owner: 'test', arrivedAt: 0, ...(adapted.error !== undefined && { inputError: adapted.error }) }
  if (response === undefined || status !== 'ran') return { ...base, ir: pendingIR(id, tool, adapted) }
  const { value, bytes } = answer(response)
  const settled = settledLookup(id, tool, adapted, value, bytes)
  return { ...base, ir: settled.ir, found: settled.found }
}

export function searchCall(status: InspectedCall['status'] = 'ran'): InspectedCall {
  return lookup('search', 'search-1', { terms: ['confluence', 'search', 'pages'], operationType: 'query' }, {
    bundleDigest: 'd1',
    requestId: 'r1',
    results: [
      { operationName: 'confluence_search', operationType: 'query', scope: 'confluence', score: 0.03, types: SEARCH_SDL },
      { operationName: 'glean_search', operationType: 'query', scope: 'glean', score: 0.02, types: GLEAN_SDL },
      { operationName: 'jira_createIssue', operationType: 'mutation', scope: 'jira', score: 0.01, types: JIRA_WRITE_SDL },
    ],
    scopes: SCOPES,
    searchMode: 'hybrid_full',
  }, status)
}

export function catalogCall(): InspectedCall {
  return lookup('search', 'catalog-1', { terms: [] }, { bundleDigest: 'd1', results: [], scopes: SCOPES })
}

export function introspectCall(status: InspectedCall['status'] = 'ran'): InspectedCall {
  return lookup('introspect', 'introspect-1', { scope: 'confluence', type: 'Confluence_SearchResult', depth: 1 }, { bundleDigest: 'd1', requestId: 'r2', scope: 'confluence', types: SEARCH_SDL.slice(1) }, status)
}

const FIND_PAGES = 'query FindPages { confluence_search(cql: "type=page", limit: 3) { results { title nosuch } totalSize } }'
const DIAGNOSTIC = [
  'Error: type `Confluence_SearchResultItem` does not have a field `nosuch`',
  '      ╭─[ operation.graphql:1:83 ]',
  '      │',
  '    1 │ query FindPages { confluence_search(cql: "type=page", limit: 3) { results { title nosuch } totalSize } }',
  '      │                                                                                   ───┬──',
  '      │                                                                                      ╰──── field `nosuch` selected here',
  '      │ Note: path to the field: `query FindPages → confluence_search → results → nosuch`',
  '──────╯',
].join('\n')

export function invalidCall(status: InspectedCall['status'] = 'ran'): InspectedCall {
  return lookup('validate', 'validate-1', { scope: 'confluence', operation: FIND_PAGES }, { bundleDigest: 'd1', errors: [DIAGNOSTIC], requestId: 'r3', scope: 'confluence', valid: false }, status)
}

export function validCall(): InspectedCall {
  return lookup('validate', 'validate-2', { scope: 'confluence', operation: 'query FindPages { confluence_search(cql: "type=page", limit: 3) { results { title url } totalSize } }' }, { bundleDigest: 'd1', requestId: 'r4', scope: 'confluence', valid: true })
}

export function dryRunCall(status: InspectedCall['status'] = 'ran'): InspectedCall {
  return lookup(
    'dry_run',
    'dry-1',
    {
      requests: [
        { scope: 'confluence', operation: 'query FindPages { confluence_search(cql: "type=page", limit: 3) { results { title url excerpt } totalSize } }' },
        { scope: 'acme-customer-data', operation: 'query Members { acme_customer_data_listOrganizationMembers(orgId: "o1") { name email } }' },
        { scope: 'jira', operation: 'query Me { jira_myself { displayName } }' },
      ],
    },
    {
      bundleDigest: 'd1',
      results: [
        { denyOperation: false, fields: [
          { decision: 'allow', path: 'confluence_search' },
          { decision: 'allow', path: 'confluence_search.results' },
          { decision: 'allow', path: 'confluence_search.results.title' },
          { decision: 'allow', path: 'confluence_search.results.url' },
          { decision: 'mask', path: 'confluence_search.results.excerpt' },
          { decision: 'allow', path: 'confluence_search.totalSize' },
        ], requestId: 'r5' },
        { denyOperation: false, fields: [
          { decision: 'allow', path: 'acme_customer_data_listOrganizationMembers' },
          { decision: 'allow', path: 'acme_customer_data_listOrganizationMembers.name' },
          { decision: 'deny', path: 'acme_customer_data_listOrganizationMembers.email', denialContext: 'tok_secret' },
        ], requestId: 'r6' },
        { errors: ['Cannot query field "jira_myself" on type "Query".'], requestId: 'r7' },
      ],
    },
    status,
  )
}

/** Every lookup fixture, settled, for the sweeps. */
export const LOOKUPS = (): InspectedCall[] => [searchCall(), catalogCall(), introspectCall(), invalidCall(), validCall(), dryRunCall()]

/** The same, waiting on their answers. */
export const PENDING_LOOKUPS = (): InspectedCall[] => [searchCall('pending'), introspectCall('pending'), invalidCall('pending'), dryRunCall('pending')]
