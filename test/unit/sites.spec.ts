import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { loadLinkConfig, recordLinkOf } from '../../src/links.ts'
import { normalize } from '../../src/normalize.ts'
import { SETUP_PROMPT, describeBases, hostOf, learnable, learnedOf, setupPrompt, sitesIn, tenantOf } from '../../src/sites.ts'

const ir = (operation: string) => buildIR('t', normalize(operation, {}))

test('the setup queries teach both sites from what Agent Services sends back', () => {
  // As Agent Services answers it (live shape): every `self` through Atlassian's API gateway, a status's icon on the site itself.
  const jira = ir('query FindAtlassianSite { jira_searchAndReconsileIssuesUsingJql(jql: "updated >= -365d", maxResults: 1, fields: ["status"]) { issues { fields } } }')
  const gateway = 'https://api.atlassian.com/ex/jira/0000-cloud/rest/api/3'
  const answer = { data: { jira_searchAndReconsileIssuesUsingJql: { issues: [{ fields: { status: { self: `${gateway}/status/3`, iconUrl: 'https://yourco.atlassian.net/images/icons/statuses/inprogress.png', name: 'In Progress' } } }] } } }
  assert.deepEqual(sitesIn(jira, answer), { atlassian: 'https://yourco.atlassian.net' })
  // The gateway alone names no site.
  assert.deepEqual(sitesIn(jira, { data: { jira_searchAndReconsileIssuesUsingJql: { issues: [{ fields: { status: { self: `${gateway}/status/3` } } }] } } }), {})
  const slack = ir('query FindSlackWorkspace { slack_authTest { url } }')
  assert.deepEqual(sitesIn(slack, { data: { slack_authTest: { url: 'https://yourco.slack.com/' } } }), { slack: 'https://yourco.slack.com' })
  // The prompt names exactly those reads, and nothing that writes.
  assert.match(SETUP_PROMPT, /jira_searchAndReconsileIssuesUsingJql\(.*maxResults: 5, fields: \["status", "priority"\]/)
  // A status Jira Software manages has its icon on the gateway (live): the priority's still names the site.
  const managed = { data: { jira_searchAndReconsileIssuesUsingJql: { issues: [{ fields: { status: { iconUrl: `${gateway}/` }, priority: { iconUrl: 'https://yourco.atlassian.net/images/icons/priorities/medium_new.svg' } } }] } } }
  assert.deepEqual(sitesIn(jira, managed), { atlassian: 'https://yourco.atlassian.net' })
  assert.match(SETUP_PROMPT, /slack_authTest \{ url \}/)
  assert.doesNotMatch(SETUP_PROMPT, /mutation/)
})

test('any Jira, Confluence or Slack response with a URL field teaches its site, at any depth, under an alias too', () => {
  const search = ir('query S { hits: confluence_search(cql: "x") { results { _links { base } } } }')
  assert.deepEqual(sitesIn(search, { data: { hits: { results: [{ _links: { base: 'https://yourco.atlassian.net/wiki' } }] } } }), { atlassian: 'https://yourco.atlassian.net' })
  const messages = ir('query M { slack_searchMessages(query: "x") { messages { matches { permalink } } } }')
  assert.deepEqual(sitesIn(messages, { data: { slack_searchMessages: { messages: { matches: [{ permalink: 'https://yourco.enterprise.slack.com/archives/C1/p2' }] } } } }), { slack: 'https://yourco.enterprise.slack.com' })
})

test("only a vendor's tenant host, from a URL field, under that vendor's root, counts", () => {
  const jira = ir('query J { jira_getCurrentUser { self displayName } }')
  for (const self of ['https://evil.example/x', 'http://yourco.atlassian.net/x', 'https://u:p@yourco.atlassian.net/', 'https://yourco.atlassian.net:8443/', 'https://api.atlassian.net/x', 'https://yourco.atlassian.net.evil.com/', 'https://yourco.slack.com/', 'not a url', 42]) {
    assert.deepEqual(sitesIn(jira, { data: { jira_getCurrentUser: { self } } }), {}, String(self))
  }
  // Text that is not a URL field never teaches, even when it holds a tenant URL.
  assert.deepEqual(sitesIn(jira, { data: { jira_getCurrentUser: { displayName: 'https://other.atlassian.net/' } } }), {})
  // Another service's root never teaches an Atlassian or Slack site.
  const glean = ir('query G { glean_search(query: "x") { results { url } } }')
  assert.deepEqual(sitesIn(glean, { data: { glean_search: { results: [{ url: 'https://yourco.atlassian.net/browse/AB-1' }] } } }), {})
  assert.equal(tenantOf('slack', 'https://app.slack.com/client/T1'), undefined)
  assert.deepEqual(sitesIn(jira, 'nope'), {})
})

test('a learned site fills only a base no file or option sets', () => {
  const learned = { atlassian: 'https://yourco.atlassian.net', slack: 'https://yourco.slack.com' }
  const plain = loadLinkConfig(undefined, { learned }).config
  assert.equal(recordLinkOf('jira', { key: 'AB-1' }, plain), 'https://yourco.atlassian.net/browse/AB-1')
  const set = loadLinkConfig({ atlassianBase: 'https://mine.atlassian.net' }, { learned }).config
  assert.equal(recordLinkOf('jira', { key: 'AB-1' }, set), 'https://mine.atlassian.net/browse/AB-1')
  const filed = loadLinkConfig(undefined, { learned, user: '[bases]\natlassian = "https://filed.atlassian.net"\n' }).config
  assert.equal(recordLinkOf('jira', { key: 'AB-1' }, filed), 'https://filed.atlassian.net/browse/AB-1')
  // A base a file turned off ("") with no learned site stays off; a bad learned value is ignored.
  assert.equal(recordLinkOf('jira', { key: 'AB-1' }, loadLinkConfig(undefined, { learned: { atlassian: 'javascript:x' } }).config), undefined)
})

// ---- Where each base comes from

test('each named base says where its value comes from: option, your file, the shipped file, a learned site, or nowhere', () => {
  const learned = { atlassian: 'https://yourco.atlassian.net', slack: 'https://yourco.slack.com' }
  const user = '[bases]\nwiki = "https://wiki.example.com"\nglean = "https://glean.example.com"\n'
  // Nothing set: the shipped file names Glean; Atlassian and Slack are empty there.
  const bare = loadLinkConfig(undefined)
  assert.equal(bare.baseSources.atlassian, 'unset')
  assert.equal(bare.baseSources.slack, 'unset')
  assert.equal(bare.baseSources.glean, 'shipped')
  assert.equal(bare.config.bases.atlassian, '')
  // A learned site fills an unset base and says so; the others keep their sources.
  const taught = loadLinkConfig(undefined, { learned })
  assert.equal(taught.baseSources.atlassian, 'learned')
  assert.equal(taught.baseSources.slack, 'learned')
  assert.equal(taught.baseSources.glean, 'shipped')
  assert.equal(taught.config.bases.slack, 'https://yourco.slack.com')
  // The person's file and the options come before a learned site, and say so.
  const set = loadLinkConfig({ slackBase: 'https://mine.slack.com' }, { learned, user })
  assert.equal(set.baseSources.slack, 'option')
  assert.equal(set.baseSources.glean, 'user')
  assert.equal(set.baseSources.wiki, 'user')
  assert.equal(set.config.bases.slack, 'https://mine.slack.com')
  assert.equal(loadLinkConfig(undefined, { learned, user: '[bases]\natlassian = "https://filed.atlassian.net"\n' }).baseSources.atlassian, 'user')
  // An option names a base over a file that names the same one.
  assert.equal(loadLinkConfig({ atlassianBase: 'https://opt.atlassian.net' }, { user: '[bases]\natlassian = "https://filed.atlassian.net"\n' }).baseSources.atlassian, 'option')
})

test('a base the person turned off in their own file stays off: no response teaches it', () => {
  const learned = { atlassian: 'https://yourco.atlassian.net', slack: 'https://yourco.slack.com' }
  const { config, baseSources } = loadLinkConfig(undefined, { learned, user: '[bases]\natlassian = ""\n' })
  assert.equal(baseSources.atlassian, 'off')
  assert.equal(config.bases.atlassian, '')
  assert.equal(recordLinkOf('jira', { key: 'AB-1' }, config), undefined)
  // The other site is still the person's to leave to learning.
  assert.equal(baseSources.slack, 'learned')
  // An option set on top of an off base still wins, as it does over any file.
  assert.equal(loadLinkConfig({ atlassianBase: 'https://opt.atlassian.net' }, { learned, user: '[bases]\natlassian = ""\n' }).baseSources.atlassian, 'option')
})

test('a learned value that is no site, or names a base nobody declares, fills nothing and changes no source', () => {
  for (const bad of ['javascript:x', 'http://yourco.atlassian.net', 'https://u:p@yourco.atlassian.net', '', 42, null, undefined]) {
    const { config, baseSources } = loadLinkConfig(undefined, { learned: { atlassian: bad as string } })
    assert.equal(config.bases.atlassian, '', String(bad))
    assert.equal(baseSources.atlassian, 'unset', String(bad))
  }
  const { config, baseSources } = loadLinkConfig(undefined, { learned: { nosuch: 'https://yourco.atlassian.net', constructor: 'https://yourco.atlassian.net' } })
  assert.equal(Object.hasOwn(config.bases, 'nosuch'), false)
  assert.equal(Object.hasOwn(baseSources, 'nosuch'), false)
  assert.equal(Object.hasOwn(config.bases, 'constructor'), false)
})

test('learnable names only the bases a response can teach that nobody set', () => {
  assert.deepEqual(learnable({ atlassian: 'unset', slack: 'unset', glean: 'shipped' }), ['atlassian', 'slack'])
  assert.deepEqual(learnable({ atlassian: 'learned', slack: 'unset' }), ['slack'])
  assert.deepEqual(learnable({ atlassian: 'option', slack: 'user' }), [])
  assert.deepEqual(learnable({ atlassian: 'off', slack: 'off' }), [])
  // Another base left empty is not one a response can teach; nothing loaded teaches nothing.
  assert.deepEqual(learnable({ wiki: 'unset' }), [])
  assert.deepEqual(learnable({}), [])
})

// ---- What is read back from storage

test('a stored site is checked again as a response would be: a tampered or stale value is dropped', () => {
  assert.deepEqual(learnedOf({ atlassian: 'https://yourco.atlassian.net', slack: 'https://yourco.slack.com' }), { atlassian: 'https://yourco.atlassian.net', slack: 'https://yourco.slack.com' })
  // The host is normalized the way a response's is.
  assert.deepEqual(learnedOf({ atlassian: 'https://YourCo.Atlassian.net/wiki' }), { atlassian: 'https://yourco.atlassian.net' })
  for (const evil of ['https://evil.example', 'https://yourco.atlassian.net.evil.example', 'http://yourco.atlassian.net', 'https://u@yourco.atlassian.net', 'https://yourco.atlassian.net:444', 'https://api.atlassian.net', 'https://yourco.slack.com', 'javascript:alert(1)', '', 7, null, {}, ['https://yourco.atlassian.net']]) {
    assert.deepEqual(learnedOf({ atlassian: evil }), {}, String(evil))
  }
  // A site stored under the other vendor's name, an unknown key, and a store that is not an object.
  assert.deepEqual(learnedOf({ slack: 'https://yourco.atlassian.net', other: 'https://yourco.slack.com' }), {})
  for (const stored of [undefined, null, 'https://yourco.atlassian.net', 5, [], true]) assert.deepEqual(learnedOf(stored), {})
})

test('a Jira root named like an Object member never reaches Object, and a response under it teaches nothing', () => {
  for (const root of ['constructor_x', 'toString_x', 'hasOwnProperty_x', 'valueOf_x']) {
    const call = ir(`query Q { ${root} { url } }`)
    assert.doesNotThrow(() => sitesIn(call, { data: { [root]: { url: 'https://yourco.atlassian.net/' } } }))
    assert.deepEqual(sitesIn(call, { data: { [root]: { url: 'https://yourco.atlassian.net/' } } }), {}, root)
  }
})

// ---- What /gas links and /gas setup say

test('the sites report names every base with its source, and for an unset one how to set it', () => {
  const { config, baseSources } = loadLinkConfig({ slackBase: 'https://mine.slack.com' }, { learned: { atlassian: 'https://yourco.atlassian.net' }, user: '[bases]\nwiki = "https://wiki.example.com"\nold = ""\n' })
  const lines = describeBases(config.bases, baseSources, '/home/me/.claude/graphos-agent-mods/links.toml')
  const at = (name: string) => lines.find(line => line.trim().startsWith(name)) ?? ''
  assert.match(at('atlassian'), /https:\/\/yourco\.atlassian\.net.*learned from an Agent Services response.*\/gas links forget/)
  assert.match(at('slack'), /https:\/\/mine\.slack\.com.*plugin option/)
  assert.match(at('glean'), /shipped default/)
  assert.match(at('wiki'), /from your links\.toml/)
  assert.match(at('old'), /turned off by your links\.toml/)
  // Unset: the file line to write, the file's path, and that a response can teach it.
  const bare = loadLinkConfig(undefined)
  const slack = describeBases(bare.config.bases, bare.baseSources, '/home/me/.claude/graphos-agent-mods/links.toml').find(line => line.trim().startsWith('slack')) ?? ''
  assert.match(slack, /not set/)
  assert.doesNotMatch(slack, /plugin option/)
  assert.match(slack, /slack = "https:\/\/yourco\.slack\.com" under \[bases\] in \/home\/me\/\.claude\/graphos-agent-mods\/links\.toml/)
  assert.match(slack, /Agent Services response.*teaches it/)
  // A base nobody can teach has no such line; an unset base with no option has no option to name.
  const wiki = describeBases({ wiki: '' }, { wiki: 'unset' }, undefined).join('\n')
  assert.doesNotMatch(wiki, /plugin option|teaches it/)
  assert.match(wiki, /in your links\.toml/)
  // A base named like an Object member is just a name.
  const odd = describeBases({ constructor: '' }, { constructor: 'unset' }, undefined).join('\n')
  assert.doesNotMatch(odd, /function|native code/)
})

test('the setup prompt asks only for what is unset, and only for reads', () => {
  assert.equal(setupPrompt(), SETUP_PROMPT)
  assert.match(setupPrompt(['atlassian']), /jira_searchAndReconsileIssuesUsingJql/)
  assert.doesNotMatch(setupPrompt(['atlassian']), /slack_authTest/)
  assert.match(setupPrompt(['slack']), /slack_authTest/)
  assert.doesNotMatch(setupPrompt(['slack']), /jira_/)
  for (const wanted of [['atlassian'], ['slack'], ['atlassian', 'slack']] as const) {
    assert.match(setupPrompt(wanted), /read-only/)
    assert.doesNotMatch(setupPrompt(wanted), /mutation/)
  }
})

test('a host reads as its host, whatever the base is', () => {
  assert.equal(hostOf('https://yourco.atlassian.net'), 'yourco.atlassian.net')
  assert.equal(hostOf('not a url'), 'not a url')
})

test('a site is read only where the vendor writes it, never from what a person wrote', () => {
  const gateway = 'https://api.atlassian.com/ex/jira/0000-cloud/rest/api/3'
  const jira = ir('query I { jira_getIssue(issueIdOrKey: "DEV-1") { fields } }')
  // A link card in a description, a remote link's object, a comment body: someone's writing, any tenant.
  const card = { type: 'inlineCard', attrs: { url: 'https://evil.atlassian.net/browse/X-1' } }
  assert.deepEqual(sitesIn(jira, { data: { jira_getIssue: { self: `${gateway}/issue/1`, fields: { description: { type: 'doc', content: [{ type: 'paragraph', content: [card] }] } } } } }), {})
  assert.deepEqual(sitesIn(jira, { data: { jira_getIssue: { fields: { comment: { comments: [{ body: { content: [card] }, self: 'https://evil.atlassian.net/c/1' }] } } } } }), {})
  assert.deepEqual(sitesIn(jira, { data: { jira_getIssue: { object: { url: 'https://evil.atlassian.net/', iconUrl: 'https://evil.atlassian.net/i.png' } } } }), {})
  // An icon outside a status, priority or issue type is not the site's word either.
  assert.deepEqual(sitesIn(jira, { data: { jira_getIssue: { fields: { customfield_1: { iconUrl: 'https://evil.atlassian.net/i.png' } } } } }), {})
  // The site's own: a status's icon, a page's _links.base.
  assert.deepEqual(sitesIn(jira, { data: { jira_getIssue: { fields: { status: { iconUrl: 'https://yourco.atlassian.net/images/icons/statuses/open.png' } } } } }), { atlassian: 'https://yourco.atlassian.net' })
  const page = ir('query P { confluence_page(id: "1") { id } }')
  assert.deepEqual(sitesIn(page, { data: { confluence_page: { _links: { base: 'https://yourco.atlassian.net/wiki' } } } }), { atlassian: 'https://yourco.atlassian.net' })
  // Slack: a link in a message's blocks or an attachment names any workspace; the message's permalink is Slack's.
  const slack = ir('query S { slack_searchMessages(query: "x") { messages } }')
  const message = { text: 'see https://other-co.slack.com/archives/C1', blocks: [{ type: 'rich_text', elements: [{ type: 'link', url: 'https://other-co.slack.com/archives/C1' }] }], attachments: [{ permalink: 'https://other-co.slack.com/files/F1' }] }
  assert.deepEqual(sitesIn(slack, { data: { slack_searchMessages: { messages: [message] } } }), {})
  assert.deepEqual(sitesIn(slack, { data: { slack_searchMessages: { messages: [{ ...message, permalink: 'https://yourco.slack.com/archives/C1/p1' }] } } }), { slack: 'https://yourco.slack.com' })
  // A `url` deep inside a Slack answer is not the auth test's own.
  assert.deepEqual(sitesIn(slack, { data: { slack_searchMessages: { messages: [{ user: { url: 'https://other-co.slack.com/' } }] } } }), {})
})
