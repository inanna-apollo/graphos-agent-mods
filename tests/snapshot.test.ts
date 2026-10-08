// viewOf through the text renderer (src/snapshot): the whole pane as plain text.
import type { InspectedCall } from '../types'
import { expect, test } from 'claude-code/testing'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import { normalize } from '../src/normalize.ts'
import { indexSdl } from '../src/schema.ts'
import { displayWidth, renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, viewOf } from '../src/view.tsx'
import { GLYPH } from '../src/view/ui/theme.ts'

const OPERATION = `query SearchQueryPlanPages($cql: String!, $limit: Int) {
  hits: confluence_search(cql: $cql, limit: $limit) {
    results { title excerpt url lastModified content { id type } }
    totalSize
  }
}`
const VARIABLES = { cql: 'type=page AND text ~ "query plan" ORDER BY lastmodified DESC', limit: 10 }
const SDL = [
  `type Query {
    "Search Confluence with CQL. Requires the search:confluence and read:confluence-content.summary scopes."
    confluence_search(cql: String!, limit: Int): Confluence_SearchResults
  }`,
  `type Confluence_SearchResults { results: [Confluence_SearchResultItem!]! totalSize: Int }`,
  `type Confluence_SearchResultItem { title: String excerpt: String url: String lastModified: String content: Confluence_Content }`,
  `type Confluence_Content { id: ID! type: String }`,
]

function confluenceCall(status: InspectedCall['status']): InspectedCall {
  const fields = new Map<string, FieldDecision>([['hits.results.excerpt', { decision: 'mask' }]])
  for (const path of ['hits', 'hits.results', 'hits.results.title', 'hits.results.url', 'hits.totalSize']) fields.set(path, { decision: 'allow' })
  const ir = annotate(buildIR('toolu_snap', normalize(OPERATION, VARIABLES)), {
    schema: indexSdl(SDL),
    access: { denyOperation: false, fields },
    validation: { valid: true, diagnostics: [] },
    scope: 'confluence',
    isIncomplete: false,
  })
  return {
    id: 'toolu_snap',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation: OPERATION,
    variables: JSON.stringify(VARIABLES, null, 2),
    status,
    arrivedAt: Date.UTC(2026, 9, 5),
    ir,
  }
}

for (const columns of [50, 64, 84]) {
  test(`a Confluence call renders as text within ${columns} columns`, () => {
    const tree = viewOf(stubKit(), { call: confluenceCall('ran'), waiting: 0 }, columns, CLOSED, undefined, { surface: 'terminal' })
    const text = renderText(tree, columns, { clip: false })
    expect(text).toMatch(/confluence_search/)
    expect(text).toMatch(/search:confluence/)
    expect(text).toMatch(/excerpt/)
    for (const line of text.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
  })
}

test('a pending call and an empty pane render too', () => {
  const pending = renderText(viewOf(stubKit(), { call: confluenceCall('pending'), waiting: 1 }, 64, CLOSED, undefined, { surface: 'terminal' }), 64)
  expect(pending).toMatch(/confluence_search/)
  expect(renderText(viewOf(stubKit(), { call: null, waiting: 0 }, 64), 64)).toMatch(/No GraphOS Agent Services call yet/)
})

// ---- A two-root Jira call modeled on the AmsOpenWork snapshots

const JIRA_OPERATION = `query AmsOpenWork($jql: String!, $max: Int, $fields: [String!]) {
  jira_searchAndReconsileIssuesUsingJql(jql: $jql, maxResults: $max, fields: $fields) {
    issues { key fields }
    isLast
    nextPageToken
  }
  jira_countIssues(jql: $jql) { count }
}`
const JIRA_VARIABLES = {
  jql: 'project = DEV AND statusCategory != Done ORDER BY updated DESC',
  max: 5,
  fields: ['summary', 'status', 'assignee', 'updated'],
}
const JIRA_SDL = [
  `type Query {
    "Search for issues using JQL enhanced search (GET) Returns one page; iterate until a short or empty page is returned."
    jira_searchAndReconsileIssuesUsingJql(
      "Search query in JQL. Requires a bounded query."
      jql: String
      "Maximum of 5000 issues per page."
      maxResults: Int
      fields: [String!]
    ): Jira_SearchResults
    "Count issues using JQL"
    jira_countIssues("Requires a bounded query." jql: String): Jira_Count
  }`,
  `type Jira_SearchResults { issues: [Jira_Issue!]! isLast: Boolean nextPageToken: String }`,
  `type Jira_Issue { key: String fields: String }`,
  `type Jira_Count { count: Int }`,
]
const JIRA_SUMMARY = {
  headline: 'Search Jira for open DEV issues and count matching results.',
}

function jiraCall(): InspectedCall {
  const fields = new Map<string, FieldDecision>()
  for (const path of ['jira_searchAndReconsileIssuesUsingJql', 'jira_searchAndReconsileIssuesUsingJql.issues', 'jira_searchAndReconsileIssuesUsingJql.issues.key', 'jira_searchAndReconsileIssuesUsingJql.issues.fields', 'jira_searchAndReconsileIssuesUsingJql.isLast', 'jira_searchAndReconsileIssuesUsingJql.nextPageToken', 'jira_countIssues', 'jira_countIssues.count']) {
    fields.set(path, { decision: 'allow' })
  }
  const ir = annotate(buildIR('toolu_jira', normalize(JIRA_OPERATION, JIRA_VARIABLES)), {
    schema: indexSdl(JIRA_SDL),
    access: { denyOperation: false, fields },
    validation: { valid: true, diagnostics: [] },
    scope: 'jira',
    isIncomplete: false,
  })
  return {
    id: 'toolu_jira',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation: JIRA_OPERATION,
    variables: JSON.stringify(JIRA_VARIABLES, null, 2),
    status: 'ran',
    arrivedAt: Date.UTC(2026, 9, 6),
    ir: { ...ir, summary: JIRA_SUMMARY as never },
  }
}

const ROOT = 'jira_searchAndReconsileIssuesUsingJql'

for (const columns of [50, 64]) {
  test(`a two-root Jira call stays tidy at ${columns} columns`, () => {
    const text = renderText(viewOf(stubKit(), { call: jiraCall(), waiting: 0 }, columns, CLOSED, undefined, { surface: 'terminal' }), columns, { clip: false })
    const lines = text.split('\n')
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    // The root name is never cut: whole on its row, or broken into rows that read whole one under the other.
    const at = lines.findIndex(line => line.includes(ROOT.slice(0, 12)))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines.slice(at, at + 4).map(line => line.trim().replace(/─+$/, '').trim()).join('')).toContain(ROOT)
    expect(text).not.toMatch(/jira_searchAnd\w*…/)
    // No root lists a scope: no root has an `access` row, and the pane does not say it (the policy card does).
    expect(lines.filter(line => /^ {2}access /.test(line)).length).toBe(0)
    expect(text).not.toMatch(/no scopes/)
    // Constraint hints are for the hover card; value ranges stay.
    expect(text).not.toMatch(/needs a filter/)
    expect(text).not.toMatch(/bounded query/)
    expect(text).toMatch(/max 5000/)
    // A root description too long for its row is left to the root's card, never cut; a short one is whole.
    expect(text).not.toMatch(/“Search for issues/)
    expect(text).not.toMatch(/…”/)
    // Nothing is cut mid-word or on a dangling word before `…`.
    for (const line of lines) expect(line).not.toMatch(/\b(?:limited|to|of|and|the) ?…/)
    const vocabulary = new Set(`${JIRA_SDL.join(' ')}`.toLowerCase().match(/[a-z]+/g) ?? [])
    for (const line of lines.filter(one => one.includes('…'))) {
      const word = /([A-Za-z]+)[^A-Za-z\s]*…/.exec(line)?.[1]
      if (word !== undefined && !line.startsWith(`${GLYPH.section} SEARCH`)) expect(vocabulary.has(word.toLowerCase())).toBe(true)
    }
  })
}
