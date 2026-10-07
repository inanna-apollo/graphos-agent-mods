import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { DEFAULT_LINKS_TOML } from '../../src/default-links.ts'
import { configOf, loadLinkConfig, linksOf, previewLinkOf, recordLinkOf } from '../../src/links.ts'
import type { CallIR } from '../../src/ir.ts'
import { openArgv } from '../../src/open.ts'

import { LINKS, SITE } from './link-fixture.ts'

test('the embedded defaults are exactly links.toml', () => {
  assert.equal(DEFAULT_LINKS_TOML, readFileSync(new URL('../../links.toml', import.meta.url), 'utf8'))
  assert.deepEqual(loadLinkConfig(undefined).problems, [])
})

const USER = `
[bases]
atlassian = "https://example.atlassian.net"
wiki = "https://wiki.example.com"

[[record]]
service = "x"
field = "fields.ticket"
match = "T\\\\d+"
url = "{wiki}/t/{value}"

[[record]]
service = "jira"
field = "key"
match = "^[A-Z]+-\\\\d+$"
url = "{wiki}/jira-mirror/{value}"

[[search]]
label = "Wiki search"
service = "x"
root = "x_*"
arg = "q"
url = "{wiki}/s?q={value}"
`

test('a user file adds rules ahead of the defaults and replaces bases; userConfig wins over both', () => {
  const { config, problems } = loadLinkConfig(undefined, { user: USER })
  assert.deepEqual(problems, [])
  assert.equal(config.bases.atlassian, 'https://example.atlassian.net')
  assert.equal(config.bases.glean, 'https://app.glean.com')
  assert.equal(config.records.length, configOf(undefined).records.length + 2)
  // custom entry, matched on a dotted field
  assert.equal(recordLinkOf('x', { 'fields.ticket': 'T42' }, config), 'https://wiki.example.com/t/T42')
  assert.equal(recordLinkOf('x', { fields: { ticket: 'T42' } }, config), 'https://wiki.example.com/t/T42')
  assert.equal(recordLinkOf('x', { fields: { ticket: 'T42x' } }, config), undefined)
  // the user's jira rule outranks the shipped one
  assert.equal(recordLinkOf('jira', { key: 'DEV-1' }, config), 'https://wiki.example.com/jira-mirror/DEV-1')
  // the shipped jira rule for another field still works, on the overridden base
  assert.equal(recordLinkOf('jira', { fields: { key: 'DEV-2' } }, config), 'https://example.atlassian.net/browse/DEV-2')
  // a user search link
  const ir: CallIR = { toolCallId: 't', state: 'ready', roots: [{ name: 'x_find', coordinate: 'x', path: 'x', args: [{ name: 'q', value: 'a b', fromVariable: false }], policy: 'unknown', children: [] }] }
  assert.deepEqual(linksOf(ir, config), [{ label: 'Wiki search', url: 'https://wiki.example.com/s?q=a%20b' }])
  const over = loadLinkConfig({ atlassianBase: 'https://opt.atlassian.net' }, { user: USER }).config
  assert.equal(over.bases.atlassian, 'https://opt.atlassian.net')
})

test('the shipped rules link Jira keys and Confluence ids once a site is set, and nothing before', () => {
  assert.equal(recordLinkOf('jira', { key: 'DEV-634' }, LINKS), `${SITE}/browse/DEV-634`)
  assert.equal(recordLinkOf('jira', { key: 'nope' }, LINKS), undefined)
  assert.equal(recordLinkOf('confluence', { id: 123 }, LINKS), `${SITE}/wiki/pages/viewpage.action?pageId=123`)
  assert.equal(recordLinkOf('confluence', { id: '12/../3' }, LINKS), undefined)
  // The shipped file names no site: each person's is their own.
  assert.equal(recordLinkOf('jira', { key: 'DEV-634' }, configOf(undefined)), undefined)
})

test('bad entries and bad files are skipped, never thrown', () => {
  const user = `
[bases]
evil = "http://evil.example"
cred = "https://u:p@x.example"
Bad = "https://x.example"

[[record]]
service = "x"
field = "id"
url = "https://evil.example/{value}"

[[record]]
service = "x"
field = "id"
url = "{nobase}/{value}"

[[record]]
service = "x"
field = "id"
match = "("
url = "{atlassian}/{value}"

[[record]]
service = "x"
field = "id"
url = "{atlassian}/{value}/{value}"

[[search]]
label = "no arg"
service = "x"
root = "x_*"
url = "{atlassian}/{value}"
`
  const { config, problems } = loadLinkConfig(undefined, { user })
  assert.ok(problems.length >= 7, problems.join('|'))
  assert.equal(config.records.length, configOf(undefined).records.length)
  assert.equal(config.searches.length, configOf(undefined).searches.length)
  assert.equal(config.bases.evil, undefined)
  const broken = loadLinkConfig(undefined, { user: 'this is = = not toml' })
  assert.equal(broken.problems.length, 1)
  assert.equal(broken.config.records.length, configOf(undefined).records.length)
  assert.doesNotThrow(() => loadLinkConfig(null, { shipped: '[[[', user: '\u0000' }))
})

test('a rule can never produce a foreign host; the value is percent-encoded', () => {
  const { config } = loadLinkConfig({ atlassianBase: SITE }, { user: '[[record]]\nservice = "*"\nfield = "id"\nurl = "{atlassian}/go/{value}"\n' })
  const url = recordLinkOf('any', { id: 'https://evil.example/x?y=1#z' }, config)
  assert.equal(new URL(url!).host, new URL(SITE).host)
  assert.ok(!url!.includes('://evil'))
  assert.equal(recordLinkOf('any', { url: 'https://evil.example/x' }, config), undefined)
  assert.equal(recordLinkOf('any', { id: 'a'.repeat(300) }, config), undefined)
})

test('previewLinkOf: raw fields, old outcomes from label and fields, stored url only on a configured origin', () => {
  assert.equal(previewLinkOf('jira', { label: 'DEV-634', raw: { key: 'DEV-634' } }, LINKS), `${SITE}/browse/DEV-634`)
  // stored before `raw`: the key is the label
  assert.equal(previewLinkOf('jira', { label: 'DEV-634' }, LINKS), `${SITE}/browse/DEV-634`)
  assert.equal(previewLinkOf('jira', { label: 'summary text', fields: [{ name: 'fields.key', value: 'DEV-9' }] }, LINKS), `${SITE}/browse/DEV-9`)
  // a config change applies to an old outcome
  assert.equal(previewLinkOf('jira', { label: 'DEV-1' }, configOf({ atlassianBase: 'https://other.atlassian.net' })), 'https://other.atlassian.net/browse/DEV-1')
  // item.url fallback
  assert.equal(previewLinkOf('glean', { label: 'doc', url: 'https://app.glean.com/doc/1' }, configOf({ gleanBase: 'https://app.glean.com' })), 'https://app.glean.com/doc/1')
  assert.equal(previewLinkOf('glean', { label: 'doc', url: `${SITE}/browse/OLD-1` }, configOf({ atlassianBase: 'https://other.atlassian.net' })), undefined)
  assert.equal(previewLinkOf('glean', { label: 'doc', url: 'https://evil.example/x' }, LINKS), undefined)
})

test('openArgv: `open` on macOS, xdg-open on Linux, nothing elsewhere; only configured https hosts', () => {
  const config = LINKS
  const url = `${SITE}/browse/DEV-1`
  assert.deepEqual(openArgv(url, config, 'Darwin\n'), { argv: ['open', url] })
  assert.deepEqual(openArgv(url, config, 'Linux\n'), { argv: ['xdg-open', url] })
  assert.ok('refused' in openArgv(url, config, 'Windows_NT'))
  for (const bad of ['https://evil.example/x', SITE.replace('https:', 'http:') + '/x', 'javascript:alert(1)', 'file:///etc/passwd', SITE.replace('https://', 'https://u:p@') + '/', `${SITE}/a b`, 5, undefined, `${SITE}.evil.com/`, '--help']) {
    assert.ok('refused' in openArgv(bad, config, 'Darwin'), String(bad))
  }
  // a configured custom host is allowed, an unconfigured one is not
  const { config: custom } = loadLinkConfig(undefined, { user: '[bases]\nwiki = "https://wiki.example.com"\n' })
  assert.ok('argv' in openArgv('https://wiki.example.com/p/1', custom, 'Darwin'))
  assert.ok('refused' in openArgv('https://wiki.example.com/p/1', LINKS, 'Darwin'))
})


test("Agent Services' own auth link opens because the pane drew it; the same host otherwise does not", () => {
  const auth = 'https://gas.example.com/auth/confluence/link'
  assert.deepEqual(openArgv(auth, configOf(undefined), 'Darwin', [auth]), { argv: ['open', auth] })
  assert.ok('refused' in openArgv(auth, configOf(undefined), 'Darwin'))
  assert.ok('refused' in openArgv('https://gas.example.com/elsewhere', configOf(undefined), 'Darwin', [auth]))
  assert.ok('refused' in openArgv('http://x.test/a', configOf(undefined), 'Darwin', ['http://x.test/a']))
})
