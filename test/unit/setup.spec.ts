import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadLinkConfig } from '../../src/links.ts'
import { setupReport } from '../../src/setup.ts'
import { sitesOfGraph } from '../../src/sites.ts'
import type { SetupFacts, ToolState } from '../../src/setup.ts'
import { MIN_CLAUDE_CODE } from '../../src/version.ts'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const TOOLS = ['search', 'introspect', 'validate', 'dry_run']
const tools = (state: ToolState | Partial<Record<string, ToolState>>, server = SERVER) => TOOLS.map(tool => ({ server, tool, state: typeof state === 'string' ? state : (state[tool] ?? 'ask') }))

const BARE = loadLinkConfig(undefined)
const SET = loadLinkConfig({ atlassianBase: 'https://yourco.atlassian.net', slackBase: 'https://yourco.slack.com' })

/** A session where everything is done: current Claude Code, a connector, its tools allowed, both sites set. */
const DONE: SetupFacts = {
  version: { version: '2.1.292', base: '2.1.292' },
  servers: [SERVER],
  tools: tools('allow'),
  bases: SET.config.bases,
  sources: SET.baseSources,
  linksFile: '/home/me/.claude/graphos-agent-mods/links.toml',
  trust: { count: 2, isOff: false, isFileChanged: false, file: '/home/me/.claude/graphos-agent-mods/trust.graphql', example: '/plugin/trust.example.graphql' },
}

const todo = (report: string) => report.split('\n').filter(line => line.startsWith('[to do]'))

test('a finished setup has nothing left to do', () => {
  const report = setupReport(DONE)
  assert.deepEqual(todo(report), [])
  assert.match(report, /Claude Code 2\.1\.292/)
  assert.match(report, /connector: found/)
  assert.match(report, /all 4 are allowed/)
  assert.match(report, /2 loaded/)
})

test('an older Claude Code is told to run claude update; an unreadable or development one is told what to check', () => {
  const older = setupReport({ ...DONE, version: { version: '2.1.288', base: '2.1.288' } })
  assert.match(todo(older)[0] ?? '', /2\.1\.288.*needs Claude Code 2\.1\.290 or later.*run `claude update`/)
  const unreadable = setupReport({ ...DONE, version: undefined })
  assert.match(todo(unreadable)[0] ?? '', /claude --version.*claude update/)
  assert.ok(unreadable.includes(MIN_CLAUDE_CODE))
  const dev = setupReport({ ...DONE, version: { version: '2.1.300-dev.20261001.t1.sha1', base: '2.1.300-dev' } })
  assert.deepEqual(todo(dev), [])
  assert.match(dev, /development build/)
})

test('no connector says how to connect the claude.ai one and that only GraphOS Agent Services is supported', () => {
  const report = setupReport({ ...DONE, servers: [], tools: [] })
  assert.match(todo(report)[0] ?? '', /connector: none found/)
  assert.match(report, /"GraphOS Agent Services" connector at claude\.ai/)
  assert.match(report, /\/mcp/)
  assert.match(report, /not with the open-source Apollo MCP Server/)
  // The tools are not checked without a server to check them on, and no question is drafted for one.
  assert.match(report, /Read-only tools: checked once the connector is found/)
  assert.doesNotMatch(report, /drafted/)
  // A listing that failed is not the same as no connector.
  assert.match(todo(setupReport({ ...DONE, servers: undefined, tools: [] }))[0] ?? '', /could not list its tools.*\/mcp/)
})

test('each read-only tool that is not allowed gets its exact allow line; allowed ones get none', () => {
  const report = setupReport({ ...DONE, tools: tools({ search: 'allow', introspect: 'ask', validate: 'allow', dry_run: 'ask' }) })
  assert.match(report, /search, validate are allowed/)
  const lines = report.split('\n').map(line => line.trim())
  assert.ok(lines.includes(`mcp__${SERVER}__introspect`))
  assert.ok(lines.includes(`mcp__${SERVER}__dry_run`))
  assert.ok(!lines.includes(`mcp__${SERVER}__search`))
  assert.ok(!lines.includes(`mcp__${SERVER}__validate`))
  assert.match(report, /\/permissions/)
  assert.match(report, /permissions\.allow/)
  // None allowed: all four lines.
  const none = setupReport({ ...DONE, tools: tools('ask') })
  for (const tool of TOOLS) assert.ok(none.split('\n').map(line => line.trim()).includes(`mcp__${SERVER}__${tool}`), tool)
  assert.match(none, /none is allowed yet/)
})

test('a denied tool is not given an allow line (it would not help), and a capped one says the organization decides', () => {
  const report = setupReport({ ...DONE, tools: tools({ search: 'deny', introspect: 'capped', validate: 'allow', dry_run: 'ask' }) })
  const lines = report.split('\n').map(line => line.trim())
  assert.ok(!lines.includes(`mcp__${SERVER}__search`))
  assert.ok(!lines.includes(`mcp__${SERVER}__introspect`))
  assert.ok(lines.includes(`mcp__${SERVER}__dry_run`))
  assert.match(report, /search is denied by a deny rule.*remove the deny rule/)
  assert.match(report, /introspect is limited by your organization's policy/)
})

test('two Agent Services servers are each checked and named, and a server name is escaped', () => {
  const report = setupReport({ ...DONE, servers: [SERVER, 'second\x1b[31m'], tools: [...tools('allow'), ...tools('ask', 'second\x1b[31m')] })
  assert.match(report, new RegExp(`\\[ok\\] Read-only tools for ${SERVER}: all 4 are allowed`))
  assert.match(report, /Read-only tools for second/)
  assert.doesNotMatch(report, /\x1b/)
  assert.match(report, /\(2 servers\)/)
})

test('unset sites say how to set them and what is drafted; set ones say where they came from', () => {
  const unset: SetupFacts = { ...DONE, bases: BARE.config.bases, sources: BARE.baseSources, graph: sitesOfGraph(['jira', 'confluence', 'slack']) }
  const drafted = setupReport({ ...unset, draft: { isDrafted: true } })
  assert.match(todo(drafted).join('\n'), /Atlassian site and Slack workspace are not set.*drafted in your prompt box.*read it and send it.*learns it from that answer, not from what Claude says/)
  assert.match(drafted, /atlassianBase plugin option/)
  assert.match(drafted, /slackBase plugin option/)
  assert.match(drafted, /\/home\/me\/\.claude\/graphos-agent-mods\/links\.toml/)
  // A draft the prompt box refused says why, and that it can be asked again.
  assert.match(todo(setupReport({ ...unset, draft: { isDrafted: false, why: 'close the open dialog first, then try again' } })).join('\n'), /could not be drafted.*close the open dialog.*Run \/gas setup again/)
  // No draft was tried (no connector): connect first.
  assert.match(todo(setupReport({ ...unset, servers: [], tools: [] })).join('\n'), /Connect GraphOS Agent Services first/)
  // One unset: only that one is named.
  const slackOnly = loadLinkConfig({ atlassianBase: 'https://yourco.atlassian.net' })
  const one = setupReport({ ...DONE, bases: slackOnly.config.bases, sources: slackOnly.baseSources, graph: unset.graph, draft: { isDrafted: true } })
  assert.match(todo(one).join('\n'), /Your Slack workspace is not set/)
  assert.match(one, /atlassian \(Jira and Confluence\): https:\/\/yourco\.atlassian\.net \(from a plugin option\)/)
  // Learned and turned-off sites are not "unset": nothing to do, and the report says which.
  const learned = loadLinkConfig(undefined, { learned: { atlassian: 'https://yourco.atlassian.net' }, user: '[bases]\nslack = ""\n' })
  const report = setupReport({ ...DONE, bases: learned.config.bases, sources: learned.baseSources })
  assert.deepEqual(todo(report), [])
  assert.match(report, /learned from an Agent Services response/)
  assert.match(report, /turned off by your links\.toml/)
})

test('a site is asked for only where the graph has its service; one it lacks is not a step, and an unread catalog waits for search', () => {
  const unset: SetupFacts = { ...DONE, bases: BARE.config.bases, sources: BARE.baseSources }
  // No Jira, Confluence or Slack in the graph: nothing to set, nothing drafted.
  const none = setupReport({ ...unset, graph: sitesOfGraph(['salesforce', 'zoom']) })
  assert.deepEqual(todo(none), [])
  assert.match(none, /atlassian: not needed, your graph has no Jira or Confluence service/)
  assert.match(none, /slack: not needed, your graph has no Slack service/)
  // Slack only: only the Slack workspace is asked for.
  const slack = setupReport({ ...unset, graph: sitesOfGraph(['slack']), draft: { isDrafted: true } })
  assert.match(todo(slack).join('\n'), /Your Slack workspace is not set\. A question is drafted/)
  assert.doesNotMatch(todo(slack).join('\n'), /Atlassian/)
  // Confluence without Jira: the question (a Jira search) cannot find the site, so the first response that shows it will.
  const wiki = setupReport({ ...unset, graph: sitesOfGraph(['confluence']) })
  assert.match(todo(wiki).join('\n'), /Your Atlassian site is not set\. The first Agent Services response that shows it teaches it/)
  // The catalog could not be read (search not allowed): no question, and why.
  assert.match(todo(setupReport(unset)).join('\n'), /Once search is allowed.*checks which your graph has/)
  // A scope named like a prototype member is not a service.
  assert.deepEqual(sitesOfGraph(['constructor', 'toString', '__proto__']), { shown: [], askable: [] })
})

test('trust rules: none points at the example file and where to copy it; some are counted; off and changed are said', () => {
  const none = setupReport({ ...DONE, trust: { ...DONE.trust, count: 0 } })
  assert.match(none, /Trust rules \(optional\): none, so every Agent Services call asks you/)
  assert.match(none, /copy what you want from \/plugin\/trust\.example\.graphql to \/home\/me\/\.claude\/graphos-agent-mods\/trust\.graphql and run \/gas trust/)
  assert.deepEqual(todo(none), [])
  const off = setupReport({ ...DONE, trust: { ...DONE.trust, count: 1, isOff: true, isFileChanged: true } })
  assert.match(off, /1 loaded, switched off for this session \(\/gas trust on\)/)
  assert.match(off, /was saved since the rules were read: run \/gas trust to load it/)
  // No HOME: still says what to do.
  const homeless = setupReport({ ...DONE, trust: { count: 0, isOff: false, isFileChanged: false, example: '/plugin/trust.example.graphql' } })
  assert.match(homeless, /to your trust\.graphql and run \/gas trust/)
})

test('the report is plain text: no truncation marks, and every line is one a person can read', () => {
  for (const facts of [DONE, { ...DONE, servers: [], tools: [] }, { ...DONE, tools: tools('ask'), bases: BARE.config.bases, sources: BARE.baseSources, draft: { isDrafted: true as const } }, { ...DONE, bases: BARE.config.bases, sources: BARE.baseSources, graph: sitesOfGraph(['confluence']) }]) {
    const report = setupReport(facts)
    assert.doesNotMatch(report, /…/)
    assert.doesNotMatch(report, /undefined|\[object/)
  }
})
