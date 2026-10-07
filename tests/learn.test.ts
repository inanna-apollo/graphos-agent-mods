// A site learned from an Agent Services response: a Jira or Slack response that carries a
// URL on that vendor's tenant host teaches the person's Atlassian site or Slack
// workspace, where nothing is configured, so records open with no setup. It
// teaches before the response's own rows are linked, says so once, is
// remembered across sessions, and never replaces what the person set.
// Behaviour only, on a fixture links.toml of the test's own (never the shipped one).

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const USER_LINKS_FILE = '/home/me/.claude/graphos-agent-mods/links.toml'
const OPERATION = 'query Open { jira_searchIssues(jql: "project = DEV", maxResults: 5) { issues { key self fields } } }'
const SLACK_OPERATION = 'query Say { slack_searchMessages(query: "deploy") { messages { matches { text permalink } } } }'

// The links.toml the plugin ships, as this test's own fixture: both sites empty, one rule each.
const SHIPPED = `[bases]
atlassian = ""
slack = ""

[[record]]
service = "jira"
field = "key"
match = "^[A-Z][A-Z0-9_]+-\\\\d+$"
url = "{atlassian}/browse/{value}"
`

const jira = (self: string) => JSON.stringify({ data: { jira_searchIssues: { issues: [{ key: 'DEV-1', self, fields: { summary: 'First issue' } }] } } })
const slack = (permalink: string) => JSON.stringify({ data: { slack_searchMessages: { messages: { matches: [{ text: 'deployed', permalink }] } } } })
const ON_YOURCO = 'https://yourco.atlassian.net'

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Setup = { reply: () => { text: string; isError?: boolean }; userLinks?: string; store?: Record<string, unknown>; saved?: Record<string, string>; isStoreSlow?: boolean }

/** Agent Services beneath the plugin and a store that remembers; every log line, opened link, store write and call id recorded. */
function world(on: On, setup: Setup) {
  const clock = mock.clock(on)
  const seen = { logs: [] as string[], opened: [] as string[], ids: [] as string[], stored: new Map<string, unknown>(Object.entries(setup.store ?? {})) }
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: seen.stored.get(e.key) }))
  on('store.set', async (_, e) => {
    // A store that takes a moment: the first response's own rows must still open on the site it taught.
    if (setup.isStoreSlow === true) await pause(30)
    seen.stored.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    seen.stored.delete(e.key)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['jira', 'slack'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds issues"}', usage: USAGE } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'open') seen.opened.push(e.argv.at(-1) ?? '')
    const stdout = e.argv[0] === 'printenv' ? '/home/me\n' : e.argv[0] === 'uname' ? 'Darwin\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path === USER_LINKS_FILE) {
      if (setup.userLinks === undefined) throw new Error('ENOENT')
      return { value: setup.userLinks }
    }
    const saved = setup.saved?.[e.path]
    if (saved !== undefined) return { value: saved }
    if (e.path.endsWith('/links.toml') && !e.path.includes('/.claude/')) return { value: SHIPPED }
    throw new Error('ENOENT')
  })
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text', props: {}, children: ['engine result'] }))
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    if (e.tool_use_id !== undefined) seen.ids.push(e.tool_use_id)
    const answer = setup.reply()
    return { result: { content: [{ type: 'text' as const, text: answer.text }], isError: answer.isError === true } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return { clock, seen }
}

const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

async function settle(clock: MockClock) {
  for (let step = 0; step < 12; step++) {
    await clock.advance(100)
    await pause(5)
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) => $.command.run({ command: 'gas', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

/** Runs a call and waits for its result to settle; resolves with the id the engine gave it. */
async function call($: Engine, gas: ReturnType<typeof world>, operation = OPERATION) {
  await $.tool.call({ tool: EXECUTE, operation })
  await settle(gas.clock)
  return gas.seen.ids.at(-1)!
}

/** Where the first record's key in a call's result row opens, if it opens anywhere. */
async function linkOf($: Engine, id: string, record = 'DEV-1'): Promise<string | undefined> {
  const view = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: EXECUTE, output: {}, isErrored: false } })
  try {
    const keys = await view.findAll({ type: 'Markdown' })
    const key = keys.find(one => String(one.props.text).includes(record))
    return key === undefined ? undefined : /\(<(https:[^>]+)>\)/.exec(String(key.props.text))?.[1]
  } finally {
    await view.unmount()
  }
}

const told = (seen: { logs: string[] }) => seen.logs.filter(line => /record links now open on/.test(line))

test('a response that shows the Atlassian site teaches it: its own rows link there, and the person is told once', async ($, on) => {
  let answer = jira(`${ON_YOURCO}/rest/api/3/issue/10001`)
  const gas = world(on, { reply: () => ({ text: answer }), isStoreSlow: true })
  await start($)
  // The first response's own rows already open on the site it taught.
  const first = await call($, gas)
  expect(await linkOf($, first)).toBe(`${ON_YOURCO}/browse/DEV-1`)
  expect(told(gas.seen)).toHaveLength(1)
  expect(told(gas.seen)[0]).toContain('yourco.atlassian.net')
  expect(gas.seen.stored.get('learnedSites')).toEqual({ atlassian: ON_YOURCO })

  // The same site again says nothing more; another tenant does not replace it.
  await call($, gas)
  answer = jira('https://other.atlassian.net/rest/api/3/issue/10002')
  const third = await call($, gas)
  expect(await linkOf($, third)).toBe(`${ON_YOURCO}/browse/DEV-1`)
  expect(told(gas.seen)).toHaveLength(1)
  expect(gas.seen.stored.get('learnedSites')).toEqual({ atlassian: ON_YOURCO })
})

test('a Slack response teaches the workspace the same way, and not the Atlassian site', async ($, on) => {
  const gas = world(on, { reply: () => ({ text: slack('https://yourteam.slack.com/archives/C1/p2') }) })
  await start($)
  await call($, gas, SLACK_OPERATION)
  expect(told(gas.seen)).toHaveLength(1)
  expect(told(gas.seen)[0]).toContain('yourteam.slack.com')
  expect(gas.seen.stored.get('learnedSites')).toEqual({ slack: 'https://yourteam.slack.com' })
})

test('a host that is not a vendor tenant teaches nothing, however the response is worded', async ($, on) => {
  const replies = ['https://evil.example/rest/api/3/issue/1', 'https://yourco.atlassian.net.evil.example/x', 'http://yourco.atlassian.net/x', 'https://api.atlassian.net/x', 'https://yourteam.slack.com/x']
  let at = 0
  const gas = world(on, { reply: () => ({ text: jira(replies[at++ % replies.length]!) }) })
  await start($)
  for (const _ of replies) {
    const id = await call($, gas)
    expect(await linkOf($, id)).toBeUndefined()
  }
  expect(told(gas.seen)).toEqual([])
  expect(gas.seen.stored.has('learnedSites')).toBe(false)
})

test('a response that is not Jira, Confluence or Slack data teaches nothing', async ($, on) => {
  const gas = world(on, { reply: () => ({ text: JSON.stringify({ data: { glean_search: { results: [{ url: `${ON_YOURCO}/browse/DEV-1` }] } } }) }) })
  await start($)
  await call($, gas, 'query Find { glean_search(query: "x") { results { url } } }')
  expect(told(gas.seen)).toEqual([])
  expect(gas.seen.stored.has('learnedSites')).toBe(false)
})

test('a site set in the plugin options is never replaced', { options: { atlassianBase: 'https://mine.atlassian.net' } }, async ($, on) => {
  const gas = world(on, { reply: () => ({ text: jira(`${ON_YOURCO}/rest/api/3/issue/10001`) }) })
  await start($)
  const id = await call($, gas)
  expect(await linkOf($, id)).toBe('https://mine.atlassian.net/browse/DEV-1')
  expect(told(gas.seen)).toEqual([])
  expect(gas.seen.stored.has('learnedSites')).toBe(false)
})

test('a site in the person’s own links.toml is never replaced, and one they turned off stays off', async ($, on) => {
  const named = world(on, { reply: () => ({ text: jira(`${ON_YOURCO}/rest/api/3/issue/10001`) }), userLinks: '[bases]\natlassian = "https://filed.atlassian.net"\n' })
  await start($)
  const id = await call($, named)
  expect(await linkOf($, id)).toBe('https://filed.atlassian.net/browse/DEV-1')
  expect(told(named.seen)).toEqual([])
  expect(named.seen.stored.has('learnedSites')).toBe(false)
})

test('a site the person turned off in their links.toml stays off', async ($, on) => {
  const gas = world(on, { reply: () => ({ text: jira(`${ON_YOURCO}/rest/api/3/issue/10001`) }), userLinks: '[bases]\natlassian = ""\n' })
  await start($)
  const id = await call($, gas)
  expect(await linkOf($, id)).toBeUndefined()
  expect(told(gas.seen)).toEqual([])
  expect(gas.seen.stored.has('learnedSites')).toBe(false)
})

test('a site learned in an earlier session opens records at once, after it is checked again', async ($, on) => {
  // The store holds a good Atlassian site and a Slack value that is no tenant (a hand-edited file).
  const gas = world(on, { reply: () => ({ text: jira('https://unrelated.example/x') }), store: { learnedSites: { atlassian: ON_YOURCO, slack: 'https://evil.example' } } })
  await start($)
  const id = await call($, gas)
  expect(await linkOf($, id)).toBe(`${ON_YOURCO}/browse/DEV-1`)
  expect(told(gas.seen)).toEqual([])
  const report = JSON.stringify(await command($, 'links'))
  expect(report).toContain('yourco.atlassian.net')
  expect(report).not.toContain('evil.example')
})

test('an oversized result teaches from the file it was saved to', async ($, on) => {
  const saved = '/home/me/.claude/projects/p/s/tool-results/big.txt'
  const stand = `<persisted-output>\nOutput too large (58.2KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n{"data":`
  const gas = world(on, { reply: () => ({ text: stand }), saved: { [saved]: jira(`${ON_YOURCO}/rest/api/3/issue/10001`) } })
  await start($)
  const id = await call($, gas)
  expect(await linkOf($, id)).toBe(`${ON_YOURCO}/browse/DEV-1`)
  expect(told(gas.seen)).toHaveLength(1)
})

test('/gas links says where each site comes from, and /gas links forget clears what was learned', async ($, on) => {
  const gas = world(on, { reply: () => ({ text: jira(`${ON_YOURCO}/rest/api/3/issue/10001`) }) })
  await start($)
  const before = JSON.stringify(await command($, 'links'))
  // Nothing learned yet: the sites are unset and the report says how to set them.
  expect(before).toMatch(/atlassian[^"]*not set/)
  expect(before).toContain('atlassianBase')
  expect(before).toContain('slackBase')

  await call($, gas)
  const learned = JSON.stringify(await command($, 'links'))
  expect(learned).toContain(ON_YOURCO)
  expect(learned).toMatch(/learned from an Agent Services response/)

  expect(JSON.stringify(await command($, 'links forget'))).toContain('yourco.atlassian.net')
  expect(gas.seen.stored.has('learnedSites')).toBe(false)
  expect(JSON.stringify(await command($, 'links'))).toMatch(/atlassian[^"]*not set/)
  // Nothing left to forget the second time.
  expect(JSON.stringify(await command($, 'links forget'))).toMatch(/No learned sites/)
})
