// /gas setup: one report on what the mod needs (Claude Code's version, the Agent Services
// connector, the four read-only tools allowed, the record-link sites, trust
// rules) with the next step for each that is not done, and a question for Agent Services
// drafted into the prompt box where a site is unset and the graph has its
// service. It only reads and checks: the one Agent Services tool it calls is search, for
// the graph's catalog, and only while a site is unset; nothing is sent. And a line at session start
// when Claude Code is older than the release this was tested on.
// Behaviour only, on a fixture links.toml of the test's own.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run', 'search'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const READ_ONLY = ['search', 'introspect', 'validate', 'dry_run']
const TRUST_FILE = '/home/me/.claude/graphos-agent-mods/trust.graphql'
const SHIPPED = '[bases]\natlassian = ""\nslack = ""\n'
const ONE_RULE = 'query DocsLookup { confluence_search(cql: "type = page*", limit: 25) { results { title } } }\n'

type Setup = {
  version?: string | 'throw'
  tools?: { name: string; description: string; mcp: boolean }[]
  /** The tool.check answer for a read-only tool, by its name; allow when absent. */
  check?: (tool: string) => 'allow' | 'ask' | 'deny'
  box?: string
  isBoxRefusing?: boolean
  trust?: string
  /** The graph's services, as search lists them; Jira, Confluence and Slack when absent. */
  scopes?: string[]
}

/** A session with Agent Services beneath the plugin; every Agent Services call, prompt fill and log line recorded. */
function world(on: On, setup: Setup = {}) {
  mock.clock(on)
  const seen = { logs: [] as string[], fills: [] as { text: string; mode?: string }[], gasCalls: [] as string[] }
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('session.version', () => {
    if (setup.version === 'throw') throw new Error('no such call')
    const version = setup.version ?? '2.1.292'
    return { value: { version, base: version } }
  })
  on('tool.list', () => ({ value: setup.tools ?? GAS_TOOLS }))
  on('tool.check', (_, e) => ({ decision: setup.check?.(e.tool.split('__').at(-1) ?? '') ?? ('allow' as const) }))
  on('mcp.call', (_, e) => {
    seen.gasCalls.push(e.tool)
    const body = e.tool === 'search' ? { bundleDigest: 'd', scopes: setup.scopes ?? ['jira', 'confluence', 'slack', 'salesforce'], results: [] } : {}
    return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
  })
  on('prompt.read', () => ({ value: { text: setup.box ?? '', cursor: (setup.box ?? '').length } }))
  on('prompt.fill', (_, e) => {
    if (setup.isBoxRefusing === true) return { isFilled: false, refusal: 'dialog' as const, text: '', cursor: 0 }
    seen.fills.push({ text: e.text, ...(e.mode !== undefined && { mode: e.mode }) })
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (e.path === TRUST_FILE && setup.trust !== undefined) return { value: setup.trust }
    if (e.path.endsWith('/links.toml') && !e.path.includes('/.claude/')) return { value: SHIPPED }
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const setup = async ($: Engine) => JSON.stringify(await $.command.run({ command: 'gas', args: 'setup', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }))

test('everything in place: the report says so, nothing is drafted, and no Agent Services tool is called', { options: { atlassianBase: 'https://yourco.atlassian.net', slackBase: 'https://yourco.slack.com' } }, async ($, on) => {
  const seen = world(on, { trust: ONE_RULE })
  await start($)
  const report = await setup($)
  expect(report).toContain('Claude Code 2.1.292')
  expect(report).toContain('connector: found')
  expect(report).toMatch(/all 4 are allowed/)
  expect(report).toMatch(/Trust rules \(optional\): 1 loaded/)
  expect(report).not.toContain('[to do]')
  expect(seen.fills).toEqual([])
  expect(seen.gasCalls).toEqual([])
})

test('an older Claude Code is told to run claude update, in the report and once at session start', async ($, on) => {
  const seen = world(on, { version: '2.1.288' })
  await start($)
  await start($)
  const lines = seen.logs.filter(line => /needs Claude Code 2\.1\.290 or later \(this is 2\.1\.288\)/.test(line))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('claude update')
  expect(await setup($)).toMatch(/2\.1\.288[^"]*claude update/)
})

test('a current Claude Code adds no line at session start', async ($, on) => {
  const current = world(on)
  await start($)
  expect(current.logs.filter(line => /needs Claude Code/.test(line))).toEqual([])
})

test('an engine with no version call is told to check it by hand, and the session still starts', async ($, on) => {
  const seen = world(on, { version: 'throw' })
  await start($)
  expect(seen.logs.filter(line => /needs Claude Code/.test(line))).toEqual([])
  expect(await setup($)).toMatch(/claude --version/)
})

test('no Agent Services connector says how to connect the claude.ai one, and drafts nothing', async ($, on) => {
  const seen = world(on, { tools: [{ name: 'mcp__github__execute', description: '', mcp: true }] })
  await start($)
  const report = await setup($)
  expect(report).toMatch(/none found/)
  expect(report).toContain('GraphOS Agent Services')
  expect(report).toContain('claude.ai')
  expect(report).toContain('/mcp')
  expect(seen.fills).toEqual([])
})

test('a read-only tool that is not allowed gets its exact allow line; the allowed ones do not', async ($, on) => {
  world(on, { check: tool => (tool === 'introspect' || tool === 'dry_run' ? 'ask' : 'allow') })
  await start($)
  const report = await setup($)
  expect(report).toContain(`mcp__${SERVER}__introspect`)
  expect(report).toContain(`mcp__${SERVER}__dry_run`)
  expect(report).not.toContain(`mcp__${SERVER}__search`)
  expect(report).not.toContain(`mcp__${SERVER}__validate`)
  // The write tool is never offered.
  expect(report).not.toContain(`mcp__${SERVER}__execute`)
  expect(report).toContain('/permissions')
})

test('an unset site is drafted into the prompt box as a read-only question, after what is typed, and nothing is sent; only search is called', async ($, on) => {
  const seen = world(on, { box: 'draft of mine' })
  await start($)
  const report = await setup($)
  expect(seen.fills).toHaveLength(1)
  expect(seen.fills[0]?.mode).toBe('append')
  expect(seen.fills[0]?.text).toContain('FindAtlassianSite')
  expect(seen.fills[0]?.text).toContain('FindSlackWorkspace')
  expect(seen.fills[0]?.text).toMatch(/read-only/)
  expect(report).toMatch(/drafted in your prompt box/)
  expect(seen.gasCalls).toEqual(['search'])
})

test('a graph with no Jira, Confluence or Slack is not asked about them, and has nothing to do for them', async ($, on) => {
  const seen = world(on, { scopes: ['salesforce', 'zoom'] })
  await start($)
  const report = await setup($)
  expect(seen.fills).toEqual([])
  expect(report).toMatch(/not needed, your graph has no Slack service/)
  expect(report).not.toContain('[to do]')
})

test('where search is not allowed, no question is drafted and the report says it waits for search', async ($, on) => {
  const seen = world(on, { check: tool => (tool === 'search' ? 'ask' : 'allow') })
  await start($)
  const report = await setup($)
  expect(seen.fills).toEqual([])
  expect(seen.gasCalls).toEqual([])
  expect(report).toMatch(/Once search is allowed/)
})

test('only the site that is unset is asked about', { options: { atlassianBase: 'https://yourco.atlassian.net' } }, async ($, on) => {
  const seen = world(on)
  await start($)
  await setup($)
  expect(seen.fills).toHaveLength(1)
  expect(seen.fills[0]?.text).toContain('FindSlackWorkspace')
  expect(seen.fills[0]?.text).not.toContain('FindAtlassianSite')
})

test('a prompt box that refuses the draft is said in the report, with what to do', async ($, on) => {
  const seen = world(on, { isBoxRefusing: true })
  await start($)
  const report = await setup($)
  expect(report).toMatch(/could not be drafted/)
  expect(report).toMatch(/close the open dialog/)
  expect(seen.fills).toEqual([])
})

test('trust rules are counted from the rules in memory, and with none the report points at the example file', async ($, on) => {
  world(on)
  await start($)
  expect(await setup($)).toMatch(/Trust rules \(optional\): none[^"]*trust\.example\.graphql/)
})
