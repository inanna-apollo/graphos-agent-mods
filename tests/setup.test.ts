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
const LINKS_FILE = '/home/me/.claude/graphos-agent-mods/links.toml'
const BOTH_SITES = '[bases]\natlassian = "https://yourco.atlassian.net"\nslack = "https://yourco.slack.com"\n'
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
  /** The person's own links.toml. */
  userLinks?: string
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
    if (e.path === LINKS_FILE && setup.userLinks !== undefined) return { value: setup.userLinks }
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

const READY = /is ready/
const STEP = /\b1\. /

test('everything in place: ready, nothing drafted, and no Agent Services tool is called', async ($, on) => {
  const seen = world(on, { trust: ONE_RULE, userLinks: BOTH_SITES })
  await start($)
  const report = await setup($)
  expect(report).toMatch(READY)
  expect(report).not.toMatch(STEP)
  expect(seen.fills).toEqual([])
  expect(seen.gasCalls).toEqual([])
})

test('an older Claude Code is told to run claude update, in the report and once at session start', async ($, on) => {
  const seen = world(on, { version: '2.1.288' })
  await start($)
  await start($)
  const lines = seen.logs.filter(line => /2\.1\.288/.test(line))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('claude update')
  expect(await setup($)).toContain('claude update')
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
  expect(await setup($)).toContain('claude --version')
})

test('no Agent Services connector says how to connect the claude.ai one, and drafts nothing', async ($, on) => {
  const seen = world(on, { tools: [{ name: 'mcp__github__execute', description: '', mcp: true }] })
  await start($)
  const report = await setup($)
  expect(report).toContain('claude.ai')
  expect(report).toContain('/mcp')
  expect(seen.fills).toEqual([])
})

test('read-only tools that are not allowed leave setup ready, never offering the write tool', async ($, on) => {
  world(on, { check: tool => (tool === 'introspect' || tool === 'dry_run' ? 'ask' : 'allow'), userLinks: BOTH_SITES })
  await start($)
  const report = await setup($)
  expect(report).toMatch(READY)
  expect(report).not.toContain('execute')
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
  expect(report).toContain('prompt box')
  expect(seen.gasCalls).toEqual(['search'])
})

test('a graph with no Jira, Confluence or Slack is not asked about them, and is ready', async ($, on) => {
  const seen = world(on, { scopes: ['salesforce', 'zoom'] })
  await start($)
  const report = await setup($)
  expect(seen.fills).toEqual([])
  expect(report).toMatch(READY)
})

test('where search is not allowed, no question is drafted and nothing is called', async ($, on) => {
  const seen = world(on, { check: tool => (tool === 'search' ? 'ask' : 'allow') })
  await start($)
  const report = await setup($)
  expect(seen.fills).toEqual([])
  expect(seen.gasCalls).toEqual([])
  expect(report).toMatch(READY)
})

test('only the site that is unset is asked about', async ($, on) => {
  const seen = world(on, { userLinks: '[bases]\natlassian = "https://yourco.atlassian.net"\n' })
  await start($)
  await setup($)
  expect(seen.fills).toHaveLength(1)
  expect(seen.fills[0]?.text).toContain('FindSlackWorkspace')
  expect(seen.fills[0]?.text).not.toContain('FindAtlassianSite')
})

test('a prompt box that refuses the draft is said in the report', async ($, on) => {
  const seen = world(on, { isBoxRefusing: true })
  await start($)
  const report = await setup($)
  expect(report).toContain('close the open dialog')
  expect(seen.fills).toEqual([])
})
