import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CallIR, FieldIR } from '../../src/ir.ts'
import { MAX_LINKS, MAX_URL, configOf, encode, linksOf, loadLinkConfig, recordLinkOf } from '../../src/links.ts'
import { linkFacts } from '../../src/view/plan.ts'
import { GLEAN, LINKS, SITE, SLACK } from './link-fixture.ts'

function ir(name: string, args: Record<string, unknown>): CallIR {
  const root: FieldIR = {
    name,
    coordinate: name,
    path: name,
    args: Object.entries(args).map(([n, value]) => ({ name: n, value, fromVariable: false })),
    policy: 'unknown',
    children: [],
  }
  return { toolCallId: 't', state: 'ready', roots: [root] }
}

const NASTY = `title ~ "a&b" AND text ~ 'it\\'s' # é 日本 %20 ?x=1`

function queryOf(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key)
}

test('CQL link encodes and round-trips', () => {
  const [link] = linksOf(ir('confluence_search', { cql: NASTY }), LINKS)
  assert.equal(link?.label, 'Open in Confluence')
  assert.ok(link!.url.startsWith(`${SITE}/wiki/search?cql=`))
  assert.equal(link!.url, `${SITE}/wiki/search?cql=${encodeURIComponent(NASTY).replace(/'/g, '%27')}`)
  assert.equal(queryOf(link!.url, 'cql'), NASTY)
})

test('JQL link encodes and round-trips', () => {
  const jql = 'project = DEV & status = "Done" ORDER BY created DESC // ünï'
  const [link] = linksOf(ir('jira_searchIssues', { jql }), LINKS)
  assert.equal(link?.url, `${SITE}/issues/?jql=${encodeURIComponent(jql)}`)
  assert.equal(queryOf(link!.url, 'jql'), jql)
})

test('Glean link, with an overridable base', () => {
  const call = ir('glean_search', { query: 'q & a' })
  assert.equal(linksOf(call, LINKS)[0]?.url, `${GLEAN}/search?q=q%20%26%20a`)
  const config = configOf({ user: '[bases]\nglean = "https://other-glean.example.com/"\n' })
  assert.equal(linksOf(call, config)[0]?.url, 'https://other-glean.example.com/search?q=q%20%26%20a')
})

test('Slack and Confluence search hits link to their own pages; no Slack search link', () => {
  assert.deepEqual(linksOf(ir('slack_searchMessages', { query: 'deploy in:#ops' }), LINKS), [])
  const permalink = `${SLACK}/archives/C0123456789/p1791200000000200`
  assert.equal(recordLinkOf('slack', { text: 'FYI', permalink }, LINKS), permalink)
  assert.equal(recordLinkOf('confluence', { title: 'Team Weekly', url: '/spaces/V/pages/1234567890/x', content: { id: '1234567890' } }, LINKS), `${SITE}/wiki/pages/viewpage.action?pageId=1234567890`)
  // With no site set (the shipped file names none), neither links.
  assert.equal(recordLinkOf('slack', { text: 'FYI', permalink }, configOf()), undefined)
})

test('no link without the argument, on another service, or with a non-string value', () => {
  assert.deepEqual(linksOf(ir('confluence_search', {}), LINKS), [])
  assert.deepEqual(linksOf(ir('jira_searchIssues', { cql: 'x' }), LINKS), [])
  assert.deepEqual(linksOf(ir('jira_searchIssues', { jql: 5 }), LINKS), [])
  assert.deepEqual(linksOf(ir('jira_searchIssues', { jql: ['a'] }), LINKS), [])
  assert.deepEqual(linksOf(ir('jira_searchIssues', { jql: null }), LINKS), [])
  assert.deepEqual(linksOf(ir('jira_searchIssues', { jql: '' }), LINKS), [])
  assert.deepEqual(linksOf(ir('other_search', { cql: 'x' }), LINKS), [])
  assert.deepEqual(linksOf({ toolCallId: 't', state: 'unparseable', roots: [] }, LINKS), [])
})

test('a non-https base is rejected', () => {
  const call = ir('confluence_search', { cql: 'a' })
  for (const bad of ['http://x.atlassian.net', 'javascript:alert(1)', 'ftp://x', 'https://u:p@x.net', 'https://x.net?a=1', 'not a url']) {
    for (const link of linksOf(call, configOf({ user: `[bases]\natlassian = ${JSON.stringify(bad)}\n` }))) assert.ok(!link.url.includes(bad), bad)
    // and a hand-built config with the bad base yields nothing
    const config = configOf()
    config.bases.atlassian = bad
    assert.deepEqual(linksOf(call, config), [], bad)
  }
})

test('a call-controlled host never appears outside the encoded query', () => {
  const evil = 'https://evil.example/x" OR text ~ "https://evil.example'
  const [link] = linksOf(ir('confluence_search', { cql: evil }), LINKS)
  const url = new URL(link!.url)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.host, new URL(SITE).host)
  assert.equal(url.searchParams.get('cql'), evil)
  assert.ok(!link!.url.includes('https://evil'))
  assert.ok(!link!.url.includes('://evil'))
  // value without separators cannot change the path either
  const [slash] = linksOf(ir('jira_x', { jql: '../../evil.example//' }), LINKS)
  assert.equal(new URL(slash!.url).pathname, '/issues/')
})

test('the length cap drops over-long URLs and keeps ones at the cap', () => {
  const call = (n: number) => ir('confluence_search', { cql: 'a'.repeat(n) })
  const overhead = linksOf(call(1), LINKS)[0]!.url.length - 1
  assert.equal(linksOf(call(MAX_URL - overhead), LINKS)[0]?.url.length, MAX_URL)
  assert.deepEqual(linksOf(call(MAX_URL - overhead + 1), LINKS), [])
  // encoding expands: 700 `&` become 2,100 characters
  assert.deepEqual(linksOf(ir('confluence_search', { cql: '&'.repeat(700) }), LINKS), [])
})

test('at most 3 links, in stable order, de-duplicated', () => {
  const root = (name: string, arg: string): FieldIR => ({
    name,
    coordinate: name,
    path: name,
    args: [{ name: arg, value: 'v', fromVariable: false }],
    policy: 'unknown',
    children: [],
  })
  const many: CallIR = {
    toolCallId: 't',
    state: 'ready',
    roots: [root('slack_searchA', 'query'), root('glean_search', 'query'), root('jira_s', 'jql'), root('confluence_s', 'cql'), root('confluence_t', 'cql')],
  }
  const config = configOf({ user: `[bases]\natlassian = "${SITE}"\nslack = "https://team.slack.com"\n` })
  const links = linksOf(many, config)
  assert.equal(links.length, MAX_LINKS)
  assert.deepEqual(links.map(l => l.label), ['Open in Confluence', 'Open in Jira', 'Open in Glean'])
  assert.deepEqual(linksOf(many, config), links)
  // the same query from two roots yields one link
  const twin: CallIR = { toolCallId: 't', state: 'ready', roots: [root('confluence_s', 'cql'), root('confluence_t', 'cql')] }
  assert.equal(linksOf(twin, LINKS).length, 1)
})

// ---- Response URL keys, and text a link is built from

const OWN = loadLinkConfig({
  shipped: ['[bases]', 'wiki = "https://wiki.example.com"', 'code = "https://code.example.com"', '', '[[search]]', 'label = "Open in Wiki"', 'service = "x"', 'root = "x_*"', 'arg = "query"', 'url = "{wiki}/s?q={value}"'].join('\n'),
}).config

test('a URL a record carries opens when it is on a configured host, under any of the keys services use', () => {
  for (const key of ['url', 'webUrl', 'permalink', 'htmlUrl', 'html_url', 'webViewLink', 'webLink', 'web_url']) {
    assert.equal(recordLinkOf('x', { [key]: 'https://code.example.com/a/1' }, OWN), 'https://code.example.com/a/1', key)
    assert.equal(recordLinkOf('x', { [key]: 'https://elsewhere.example.net/a/1' }, OWN), undefined, `${key} off the configured hosts`)
  }
})

test('a lone surrogate in a model-written argument never makes a link throw', () => {
  const link = linksOf(ir('x_find', { query: 'half a pair \ud83d, and another \ude00' }), OWN)
  // Either no link or one that parses; the pane draws this while rendering.
  for (const one of link) assert.doesNotThrow(() => new URL(one.url))
  assert.doesNotThrow(() => encode('\ud800'))
  assert.equal(encode('a b'), 'a%20b')
  assert.equal(encode('😀'), '%F0%9F%98%80')
})

test('what a link is about is worked out without throwing on a lone surrogate too', () => {
  const call = ir('x_find', { query: 'a \ud800 b' })
  assert.doesNotThrow(() => linkFacts({ label: 'Open in Wiki', url: 'https://wiki.example.com/s?q=a' }, call))
})
