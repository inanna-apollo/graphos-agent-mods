import { URL } from 'node:url'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { describeRules, fitCall, globMatches, MAX_RULES, parseTrust } from '../../src/trust.ts'
import type { Fit, TrustRule } from '../../src/trust.ts'

const RULES = `
query JiraTriage {
  jira_searchIssues(jql: "project = DEV*", maxResults: 50) {
    issues { key fields { summary status { name } } }
    nextPageToken
    isLast
  }
  jira_issue
}

query DocsLookup {
  confluence_search(cql: "type = page*")
  glean_search { results { ...Doc } }
}

fragment Doc on GleanResult { title url }
`

function rules(text = RULES): TrustRule[] {
  const parsed = parseTrust(text)
  assert.deepEqual(parsed.problems, [])
  return parsed.rules
}

const fit = (operation: string, variables?: unknown, extra: Record<string, unknown> = {}): Fit => fitCall({ operation, ...(variables === undefined ? {} : { variables }), ...extra }, rules())

function fits(operation: string, variables?: unknown): Extract<Fit, { isAllowed: true }> {
  const result = fit(operation, variables)
  if (!result.isAllowed) assert.fail(`expected a fit, got: ${result.reason}`)
  return result
}

function misses(operation: string, variables?: unknown, extra?: Record<string, unknown>): string {
  const result = fit(operation, variables, extra)
  if (result.isAllowed) assert.fail(`expected no fit for ${operation}`)
  assert.equal(typeof result.reason, 'string')
  return result.reason
}

const SEARCH = 'query Q { jira_searchIssues(jql: "project = DEV AND status = Open", maxResults: 25) { issues { key fields { summary } } isLast } }'

describe('parseTrust', () => {
  test('named queries become rules, with fragments expanded', () => {
    const parsed = rules()
    assert.deepEqual(parsed.map(rule => rule.name), ['JiraTriage', 'DocsLookup'])
    assert.deepEqual(describeRules(parsed), ['JiraTriage: jira_searchIssues, jira_issue', 'DocsLookup: confluence_search, glean_search'])
    const glean = parsed[1]!.roots.find(root => root.name === 'glean_search')!
    assert.deepEqual(glean.children[0]!.children.map(child => child.name), ['title', 'url'])
  })

  test('mutations, subscriptions, unnamed queries, variables, directives and duplicates are skipped with a problem', () => {
    const { rules: kept, problems } = parseTrust(`
      mutation M { jira_createIssue }
      subscription S { feed }
      { jira_issue }
      query V($k: String) { jira_issue(key: $k) }
      query U { jira_issue(key: $k) }
      query D { jira_issue @include(if: true) }
      query Ok { jira_issue }
      query Ok { glean_search }
    `)
    assert.deepEqual(kept.map(rule => rule.name), ['Ok'])
    assert.equal(problems.length, 7, problems.join('\n'))
  })

  test('a file that is not GraphQL, or is huge, gives no rules and a problem, never a throw', () => {
    for (const text of ['query {', 'type Query { a: Int }', '\u0000', 'x'.repeat(300 * 1024), '']) {
      const parsed = parseTrust(text)
      assert.equal(parsed.rules.length, 0)
      if (text !== '') assert.ok(parsed.problems.length > 0, text.slice(0, 20))
    }
  })

  test(`at most ${MAX_RULES} rules are kept`, () => {
    const text = Array.from({ length: MAX_RULES + 5 }, (_, index) => `query R${index} { a }`).join('\n')
    const parsed = parseTrust(text)
    assert.equal(parsed.rules.length, MAX_RULES)
    assert.equal(parsed.problems.length, 1)
  })
})

describe('fitCall: shape', () => {
  test('a selection inside the rule fits, naming the rule and why', () => {
    const result = fits(SEARCH)
    assert.equal(result.fits[0]!.rule, 'JiraTriage')
    assert.ok(result.fits[0]!.reasons.some(reason => reason.includes('project = DEV*')))
    assert.ok(result.fits[0]!.reasons.some(reason => reason.includes('≤ 50')))
  })

  test('a field outside the rule, an unknown root, or a root no rule names does not fit, and says where', () => {
    assert.match(misses('query Q { jira_searchIssues(jql: "project = DEV", maxResults: 5) { issues { key fields { description } } } }'), /issues\.fields\.description is outside JiraTriage/)
    assert.match(misses('query Q { gong_calls { id } }'), /no rule names gong_calls/)
    // One root fits, the other does not: the call asks.
    assert.match(misses(`query Q { jira_issue(key: "DEV-1") { key } gong_calls { id } }`), /gong_calls/)
  })

  test('a bare rule field allows anything below it, arguments included', () => {
    const result = fits('query Q { jira_issue(key: "OPS-9") { key fields { comments(first: 1000) { body } } } }')
    assert.ok(result.fits[0]!.reasons.some(reason => reason.includes('anything under jira_issue')))
  })

  test('roots may fit different rules; aliases are ignored; __typename always fits', () => {
    const result = fits('query Q { a: jira_issue(key: "X-1") { key } b: confluence_search(cql: "type = page AND space = ENG") { results { title } } __typename }')
    assert.deepEqual(result.fits.map(one => one.rule), ['JiraTriage', 'DocsLookup'])
    fits('query Q { hits: jira_searchIssues(jql: "project = DEV", maxResults: 1) { issues { __typename k: key } } }')
  })

  test('fragments in the call are expanded before fitting', () => {
    fits('query Q { glean_search { results { ...F } } } fragment F on GleanResult { title }')
    assert.match(misses('query Q { glean_search { results { ...F } } } fragment F on GleanResult { title body }'), /body/)
  })

  test('type conditions: a rule child without one covers any; a rule child under one covers only the same', () => {
    fits('query Q { glean_search { results { ... on GleanResult { title } } } }')
    const typed = parseTrust('query T { search { hits { ... on Page { title } } } }').rules
    assert.equal(fitCall({ operation: 'query Q { search { hits { ... on Page { title } } } }' }, typed).isAllowed, true)
    assert.equal(fitCall({ operation: 'query Q { search { hits { title } } }' }, typed).isAllowed, false)
    assert.equal(fitCall({ operation: 'query Q { search { hits { ... on Person { title } } } }' }, typed).isAllowed, false)
  })

  test('the same field twice under different aliases must fit twice', () => {
    assert.match(misses('query Q { a: jira_searchIssues(jql: "project = DEV", maxResults: 5) { isLast } b: jira_searchIssues(jql: "project = OPS", maxResults: 5) { isLast } }'), /jql/)
  })

  test('an undecidable @include cannot fit', () => {
    assert.match(misses('query Q($x: Boolean) { jira_searchIssues(jql: "project = DEV", maxResults: 5) { issues { secret @include(if: $x) } } }'), /secret|@include/)
  })
})

test('trust eligibility rejects ambiguous syntax even beneath an unrestricted field', () => {
  const constrained = rules('query R { jira_search(limit: 5) { id } jira_issue jira_create_issue slack_send_message acme_customer_data_create_issue acme_customer_data_get_issue }')
  for (const [operation, variables, expected] of [
    ['{ jira_search(limit: 5, limit: 5000) { id } }', {}, false],
    ['{ jira_search(limit: 5000, limit: 5) { id } }', {}, false],
    ['{ jira_search(limit: 5, limit: 5) { id } }', {}, false],
    ['{ jira_issue { comments(limit: 5, limit: 5000) { id } } }', {}, false],
    ['{ jira_issue(filter: { project: "DEV", project: "OPS" }) }', {}, false],
    ['{ jira_issue hidden: jira_issue(filter: { project: "DEV", project: "OPS" }) @skip(if: true) }', {}, false],
    ['query Q($n: Int = 5, $n: Int = 5000) { jira_search(limit: $n) { id } }', {}, false],
    ['query Q($x: Boolean) { jira_issue @include(if: $x) }', {}, false],
    ['query Q($x: Boolean) { jira_issue { id @skip(if: $x) } }', {}, false],
    ['query Q($x: Boolean) { ...F @include(if: $x) } fragment F on Query { jira_issue }', {}, false],
    ['query Q($x: Boolean) { ... @skip(if: $x) { jira_issue } }', {}, false],
    ['{ jira_issue @include(if: true, if: false) }', {}, false],
    ['{ jira_issue @include(if: true, extra: false) }', {}, false],
    ['{ jira_issue @skip }', {}, false],
    ['{ jira_issue @include(if: "true") }', {}, false],
    ['{ jira_issue @include(if: true) @include(if: false) }', {}, false],
    ['query Q @skip(if: false) { jira_issue }', {}, false],
    ['{ ...F } fragment F on Query @include(if: true) { jira_issue }', {}, false],
    ['{ jira_issue { id @custom } }', {}, false],
    ['{ jira_create_issue { id } }', {}, false],
    ['{ slack_send_message { id } }', {}, false],
    ['{ acme_customer_data_create_issue { id } }', {}, false],
    ['{ acme_customer_data_get_issue { id } }', {}, true],
    ['{ jira_search(limit: 5) { id } }', {}, true],
    ['{ jira_issue { comments(limit: 5000) { id } } }', {}, true],
    ['query Q($x: Boolean = true) { jira_issue @include(if: $x) }', {}, true],
    ['query Q($x: Boolean!) { jira_issue @include(if: $x) }', { x: true }, true],
    ['query Q($x: Boolean!) { ...F @include(if: $x) } fragment F on Query { jira_issue }', { x: true }, true],
  ] as const) assert.equal(fitCall({ operation, variables }, constrained).isAllowed, expected)
  for (const operation of [
    'query R { jira_search(limit: 5, limit: 5000) }',
    'query R { jira_issue { comments(first: 1, first: 5000) } }',
    'query R { jira_issue(filter: { project: "DEV", project: "OPS" }) }',
  ]) assert.equal(parseTrust(operation).rules.length, 0)
})

describe('fitCall: arguments', () => {
  test('variables are substituted before fitting', () => {
    fits('query Q($j: String!, $n: Int) { jira_searchIssues(jql: $j, maxResults: $n) { isLast } }', { j: 'project = DEV', n: 10 })
    fits('query Q($j: String!) { jira_searchIssues(jql: $j, maxResults: 10) { isLast } }', JSON.stringify({ j: 'project = DEV' }))
    assert.match(misses('query Q($j: String!) { jira_searchIssues(jql: $j, maxResults: 10) { isLast } }', { j: 'project = OPS' }), /jql/)
  })

  test('an argument the rule names must be set; one it leaves out may be anything', () => {
    assert.match(misses('query Q { jira_searchIssues(maxResults: 5) { isLast } }'), /does not set jql/)
    assert.match(misses('query Q($j: String) { jira_searchIssues(jql: $j, maxResults: 5) { isLast } }', {}), /does not set jql/)
    fits('query Q { jira_searchIssues(jql: "project = DEV", maxResults: 5, fields: ["summary"], expand: "x") { isLast } }')
  })

  test('a number on a limit argument is a maximum of at least 1; elsewhere it must be equal', () => {
    for (const bad of [51, 0, -1, 2.5, '9999999999999999999999']) {
      assert.equal(fit(`query Q($n: Int) { jira_searchIssues(jql: "project = DEV", maxResults: $n) { isLast } }`, { n: bad }).isAllowed, false, String(bad))
    }
    fits('query Q { jira_searchIssues(jql: "project = DEV", maxResults: 50) { isLast } }')
    const exact = parseTrust('query R { issue(id: 7) }').rules
    assert.equal(fitCall({ operation: 'query Q { issue(id: 7) { a } }' }, exact).isAllowed, true)
    assert.equal(fitCall({ operation: 'query Q { issue(id: 6) { a } }' }, exact).isAllowed, false)
  })

  test('a string pattern is anchored, case-sensitive, and only matches strings', () => {
    assert.equal(fit('query Q { jira_searchIssues(jql: "status = Open AND project = DEV", maxResults: 1) { isLast } }').isAllowed, false)
    assert.equal(fit('query Q { jira_searchIssues(jql: "PROJECT = DEV", maxResults: 1) { isLast } }').isAllowed, false)
    const typed = parseTrust('query R { a(x: "1*") }').rules
    assert.equal(fitCall({ operation: 'query Q { a(x: 12) }' }, typed).isAllowed, false)
  })

  test('lists: each item must be allowed, a single value is a list of one, an empty list only where the rule allows none', () => {
    const listed = parseTrust('query R { issues(projects: ["DEV", "OPS"]) }').rules
    const ok = (value: string) => fitCall({ operation: `query Q { issues(projects: ${value}) { key } }` }, listed).isAllowed
    assert.equal(ok('["DEV"]'), true)
    assert.equal(ok('"OPS"'), true)
    assert.equal(ok('["DEV", "SEC"]'), false)
    assert.equal(ok('[]'), false)
  })

  test('objects: each key the rule names is checked, the rest are free', () => {
    const shaped = parseTrust('query R { issues(filter: { project: "DEV", limit: 20 }) }').rules
    const ok = (value: string) => fitCall({ operation: `query Q { issues(filter: ${value}) { key } }` }, shaped).isAllowed
    assert.equal(ok('{ project: "DEV", limit: 5, status: "Open" }'), true)
    assert.equal(ok('{ project: "DEV", limit: 500 }'), false)
    assert.equal(ok('{ project: "DEV" }'), false)
    assert.equal(ok('"DEV"'), false)
  })

  test('enums, booleans and null must be equal', () => {
    const exact = parseTrust('query R { a(order: DESC, open: true, owner: null) }').rules
    const ok = (args: string) => fitCall({ operation: `query Q { a(${args}) }` }, exact).isAllowed
    assert.equal(ok('order: DESC, open: true, owner: null'), true)
    assert.equal(ok('order: ASC, open: true, owner: null'), false)
    assert.equal(ok('order: DESC, open: false, owner: null'), false)
    assert.equal(ok('order: DESC, open: true, owner: "me"'), false)
  })
})

describe('fitCall: the floor no rule lifts', () => {
  const anything = parseTrust('query All { jira_issue jira_createIssue confluence_deletePage x }').rules

  test('a mutation or subscription never fits', () => {
    assert.match(fitCall({ operation: 'mutation M { jira_issue }' }, anything).isAllowed ? '' : (fitCall({ operation: 'mutation M { jira_issue }' }, anything) as { reason: string }).reason, /mutation always asks/)
    assert.equal(fitCall({ operation: 'subscription S { x }' }, anything).isAllowed, false)
  })

  test('a query root named for a change never fits, even when a rule names it', () => {
    assert.equal(fitCall({ operation: 'query Q { jira_createIssue { key } }' }, anything).isAllowed, false)
    assert.equal(fitCall({ operation: 'query Q { confluence_deletePage }' }, anything).isAllowed, false)
  })

  test('more than one operation, an unreadable operation or variables, or extra input never fits', () => {
    for (const input of [
      { operation: 'query A { x } query B { x }' },
      { operation: 'query {' },
      { operation: 42 },
      { operation: 'query Q { x }', variables: 'not json' },
      { operation: 'query Q { x }', operationName: 'Q' },
      { operation: 'query Q { x }', extensions: {} },
      null,
      'query Q { x }',
    ]) {
      assert.equal(fitCall(input, anything).isAllowed, false, JSON.stringify(input))
    }
  })

  test('any directive but a decided @skip or @include never fits', () => {
    for (const operation of ['query Q @live { x }', 'query Q { x @export(as: "a") }', 'query Q { ... @defer { x } }', 'query Q { ...F @custom } fragment F on Query { x }']) {
      assert.equal(fitCall({ operation }, anything).isAllowed, false, operation)
    }
    assert.equal(fitCall({ operation: 'query Q { x @include(if: true) jira_issue @skip(if: true) }' }, anything).isAllowed, true)
  })

  test('no rules, or a call selecting only __typename, never fits', () => {
    assert.equal(fitCall({ operation: 'query Q { x }' }, []).isAllowed, false)
    assert.equal(fitCall({ operation: 'query Q { __typename }' }, anything).isAllowed, false)
  })
})

test('globMatches: * is any run, the rest literal, the whole value; no blow-up on hostile patterns', () => {
  assert.equal(globMatches('project = DEV*', 'project = DEV AND x'), true)
  assert.equal(globMatches('*DEV*', 'x DEV y'), true)
  assert.equal(globMatches('a.c', 'abc'), false)
  assert.equal(globMatches('a*', ''), false)
  assert.equal(globMatches('*', ''), true)
  assert.equal(globMatches('', ''), true)
  assert.equal(globMatches('(x)+', '(x)+'), true)
  const started = performance.now()
  assert.equal(globMatches(`${'*a'.repeat(40)}b`, 'a'.repeat(20_000)), false)
  assert.ok(performance.now() - started < 2_000)
})

test('the shipped example file parses with no problems', () => {
  const parsed = parseTrust(readFileSync(new URL('../../trust.example.graphql', import.meta.url), 'utf8'))
  assert.deepEqual(parsed.problems, [])
  assert.ok(parsed.rules.length > 0)
})
