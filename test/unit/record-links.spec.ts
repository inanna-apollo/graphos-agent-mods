import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { renderArg } from '../../src/format/index.ts'
import { MAX_URL, configOf, confluencePageUrl, jiraKeyUrl, recordLinkOf, serviceOf } from '../../src/links.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { GLEAN, LINKS, SITE } from './link-fixture.ts'

const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })

test('service is the root field prefix before the underscore', () => {
  assert.equal(serviceOf('jira_searchIssues'), 'jira')
  assert.equal(serviceOf('search'), '')
})

test('a Jira item with a key links to /browse/KEY; a non-key does not', () => {
  assert.equal(recordLinkOf('jira', { key: 'DEV-123', summary: 's' }, LINKS), `${SITE}/browse/DEV-123`)
  assert.equal(recordLinkOf('jira', { key: 'MY_PROJ2-7' }, LINKS), `${SITE}/browse/MY_PROJ2-7`)
  assert.equal(recordLinkOf('jira', { key: 'ams-1' }, LINKS), undefined)
  assert.equal(recordLinkOf('jira', { key: 'DEV-1/../x' }, LINKS), undefined)
  assert.equal(recordLinkOf('slack', { key: 'DEV-1' }, LINKS), undefined)
  assert.equal(recordLinkOf('jira', { key: 'DEV-1' }, configOf({ atlassianBase: 'https://example.atlassian.net' })), 'https://example.atlassian.net/browse/DEV-1')
})

test('a Confluence item with a numeric id links to the page', () => {
  assert.equal(recordLinkOf('confluence', { id: '98765', title: 't' }, LINKS), `${SITE}/wiki/pages/viewpage.action?pageId=98765`)
  assert.equal(recordLinkOf('confluence', { id: 98765 }, LINKS), `${SITE}/wiki/pages/viewpage.action?pageId=98765`)
  assert.equal(recordLinkOf('confluence', { id: 'abc' }, LINKS), undefined)
  assert.equal(confluencePageUrl('1&x=2', LINKS), undefined)
  assert.equal(jiraKeyUrl('DEV-1', LINKS), `${SITE}/browse/DEV-1`)
})

test('a response URL is accepted only on a configured origin', () => {
  assert.equal(recordLinkOf('glean', { url: `${GLEAN}/doc/1` }, LINKS), `${GLEAN}/doc/1`)
  assert.equal(recordLinkOf('glean', { webUrl: `${SITE}/wiki/spaces/X/pages/1` }, LINKS), `${SITE}/wiki/spaces/X/pages/1`)
  assert.equal(recordLinkOf('glean', { url: 'https://evil.example.com/doc/1' }, LINKS), undefined)
  assert.equal(recordLinkOf('glean', { url: `${GLEAN}.evil.com/x` }, LINKS), undefined)
  const extra = configOf({ extraLinks: JSON.stringify([{ label: 'L', service: 'x', field: 'x_*', arg: 'q', base: 'https://wiki.example.com', template: '{base}/s/{value}' }]) })
  assert.equal(recordLinkOf('x', { permalink: 'https://wiki.example.com/p/1' }, extra), 'https://wiki.example.com/p/1')
  assert.equal(recordLinkOf('x', { permalink: 'https://wiki.example.com/p/1' }, LINKS), undefined)
})

test('Confluence _links.webui resolves against the Atlassian base plus /wiki', () => {
  assert.equal(recordLinkOf('glean', { _links: { webui: '/spaces/ENG/pages/42/Plan' } }, LINKS), `${SITE}/wiki/spaces/ENG/pages/42/Plan`)
  assert.equal(recordLinkOf('glean', { _links: { webui: '//evil.example.com/x' } }, LINKS), undefined)
  assert.equal(recordLinkOf('glean', { _links: { webui: 'https://evil.example.com/x' } }, LINKS), undefined)
})

test('javascript:, http:, credentialed, non-canonical and over-long response URLs are rejected', () => {
  for (const url of [
    'javascript:alert(1)',
    GLEAN.replace('https:', 'http:') + '/doc/1',
    GLEAN.replace('https://', 'https://user:pw@') + '/doc/1',
    `${GLEAN}/a b`,
    `${GLEAN}/x`.padEnd(MAX_URL + 1, 'x'),
    'not a url',
  ]) {
    assert.equal(recordLinkOf('glean', { url }, LINKS), undefined, url)
  }
  assert.equal(recordLinkOf('glean', { url: 5 }, LINKS), undefined)
})

test('preview items carry a record link built from the configured host, never from the response', () => {
  const jira = buildIR('t', normalize('query { issues: jira_searchIssues(jql: "x") { issues { key summary } } }', {}))
  const body = { data: { issues: { issues: [{ key: 'DEV-1', summary: 'one', url: 'https://evil.example.com/DEV-1' }, { summary: 'no key' }] } } }
  const [shown] = outcomeOf(jira, mcp(body), LINKS).preview ?? []
  assert.equal(shown?.items[0]?.url, `${SITE}/browse/DEV-1`)
  assert.equal(shown?.items[1]?.url, undefined)
  const [other] = outcomeOf(jira, mcp(body), configOf({ atlassianBase: 'https://x.atlassian.net' })).preview ?? []
  assert.equal(other?.items[0]?.url, 'https://x.atlassian.net/browse/DEV-1')
})

test('a foreign-host URL in the response gets no link', () => {
  const pages = buildIR('t', normalize('query { p: confluence_search(cql: "x") { results { title url } } }', {}))
  const body = { data: { p: { results: [{ title: 'a', url: 'https://evil.example.com/a' }, { title: 'b', url: 'javascript:alert(1)' }] } } }
  const [shown] = outcomeOf(pages, mcp(body), LINKS).preview ?? []
  assert.deepEqual(shown?.items.map(item => item.url), [undefined, undefined])
})

describe('record links in argument values', () => {
  const NOW = Date.UTC(2026, 9, 6)
  const mk = (name: string, value: unknown) => ({ name, value, fromVariable: false }) as Parameters<typeof renderArg>[0]
  const urls = (r: ReturnType<typeof renderArg>) => r.lines.flat().filter(s => s.url !== undefined).map(s => [s.text, s.url])
  const textOf = (r: ReturnType<typeof renderArg>) => r.lines.flat().map(s => s.text).join('')

  test('JQL issue keys carry /browse links, outside quotes only', () => {
    assert.deepEqual(urls(renderArg(mk('jql', 'key = DEV-123'), 'jira_searchIssues', NOW, LINKS)), [['DEV-123', `${SITE}/browse/DEV-123`]])
    assert.deepEqual(urls(renderArg(mk('jql', 'issue in (DEV-1, DEV-2) AND summary ~ "DEV-9"'), 'jira_searchIssues', NOW, LINKS)), [
      ['DEV-1', `${SITE}/browse/DEV-1`],
      ['DEV-2', `${SITE}/browse/DEV-2`],
    ])
    assert.deepEqual(urls(renderArg(mk('jql', 'project = DEV'), 'jira_searchIssues', NOW, LINKS)), [])
    // linking never changes the text
    const linked = renderArg(mk('jql', 'key = DEV-123 AND x = 1'), 'jira_searchIssues', NOW, LINKS)
    assert.ok(textOf(linked).includes('DEV-123'))
    assert.ok(!textOf(linked).includes('https'))
  })

  test('issueKey and Confluence page id arguments link to the record', () => {
    assert.deepEqual(urls(renderArg(mk('issueKey', 'DEV-5'), 'jira_getIssue', NOW, LINKS)), [['DEV-5', `${SITE}/browse/DEV-5`]])
    assert.deepEqual(urls(renderArg(mk('issueIdOrKey', 'DEV-5'), 'jira_getIssue', NOW, LINKS)), [['DEV-5', `${SITE}/browse/DEV-5`]])
    assert.deepEqual(urls(renderArg(mk('pageId', '123'), 'confluence_getPage', NOW, LINKS)), [['123', `${SITE}/wiki/pages/viewpage.action?pageId=123`]])
    assert.deepEqual(urls(renderArg(mk('id', '123'), 'confluence_getPage', NOW, LINKS)), [['123', `${SITE}/wiki/pages/viewpage.action?pageId=123`]])
    assert.deepEqual(urls(renderArg(mk('id', '123'), 'jira_getThing', NOW, LINKS)), [])
    assert.deepEqual(urls(renderArg(mk('issueKey', 'not a key'), 'jira_getIssue', NOW, LINKS)), [])
  })
})
