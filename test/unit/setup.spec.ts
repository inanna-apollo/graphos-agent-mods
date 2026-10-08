import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadLinkConfig } from '../../src/links.ts'
import { READY, setupReport } from '../../src/setup.ts'
import { sitesOfGraph } from '../../src/sites.ts'
import type { SetupFacts, ToolState } from '../../src/setup.ts'
import { MIN_CLAUDE_CODE } from '../../src/version.ts'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const TOOLS = ['search', 'introspect', 'validate', 'dry_run']
const tools = (state: ToolState | Partial<Record<string, ToolState>>, server = SERVER) => TOOLS.map(tool => ({ server, tool, state: typeof state === 'string' ? state : (state[tool] ?? 'ask') }))

const BARE = loadLinkConfig()
const SET = loadLinkConfig({ user: '[bases]\natlassian = "https://yourco.atlassian.net"\nslack = "https://yourco.slack.com"\n' })

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

/** The numbered steps of a report: each `N. …` line. */
const steps = (report: string) => report.split('\n').filter(line => /^\d+\. /.test(line))

test('a finished setup says it is ready, in one line, and nothing else to do', () => {
  const report = setupReport(DONE)
  assert.deepEqual(steps(report), [])
  assert.equal(report.split('\n')[0], READY)
  // Loaded trust rules are said in a line of their own, not as a step.
  assert.match(report, /Trust rules: 2 loaded/)
  // Without rules, it is the ready line alone.
  assert.equal(setupReport({ ...DONE, trust: { ...DONE.trust, count: 0 } }), READY)
})

test('an older Claude Code is a step that says claude update; an unreadable one says how to check; a development build is no step', () => {
  assert.match(steps(setupReport({ ...DONE, version: { version: '2.1.288', base: '2.1.288' } }))[0] ?? '', /needs Claude Code 2\.1\.290 or later \(this is 2\.1\.288\).*claude update/)
  const unreadable = steps(setupReport({ ...DONE, version: undefined }))
  assert.match(unreadable[0] ?? '', /claude --version.*claude update/)
  assert.ok((unreadable[0] ?? '').includes(MIN_CLAUDE_CODE))
  assert.equal(setupReport({ ...DONE, version: { version: '2.1.300-dev.20261001.t1.sha1', base: '2.1.300-dev' } }), setupReport(DONE))
})

test('no connector is the one step, says how to connect the claude.ai one, and checks nothing that needs it', () => {
  const report = setupReport({ ...DONE, servers: [], tools: tools('ask') })
  assert.equal(steps(report).length, 1)
  assert.match(report, /"GraphOS Agent Services" connector at claude\.ai/)
  assert.match(report, /\/mcp/)
  assert.match(report, /requires GraphOS Agent Services/)
  assert.match(report, /Apollo MCP Server.*does not provide/)
  assert.doesNotMatch(report, /mcp__/)
  // A listing that failed is not the same as no connector.
  assert.match(steps(setupReport({ ...DONE, servers: undefined, tools: [] }))[0] ?? '', /could not list its tools.*\/mcp/)
})

test('the read-only tools are never a step: not allowed, denied or capped, the report is ready and says so in a note', () => {
  for (const state of [tools('ask'), tools({ search: 'deny', introspect: 'capped', validate: 'allow', dry_run: 'ask' })]) {
    const report = setupReport({ ...DONE, tools: state })
    assert.deepEqual(steps(report), [])
    assert.equal(report.split('\n')[0], READY)
    // No tool ids: the note names the tools.
    assert.doesNotMatch(report, /mcp__/)
  }
  assert.match(setupReport({ ...DONE, tools: tools('ask') }), /Optional: allow.*\/permissions/)
  // A server name is escaped where two servers are told apart.
  assert.doesNotMatch(setupReport({ ...DONE, servers: [SERVER, 'second\x1b[31m'], tools: [...tools('allow'), ...tools('ask', 'second\x1b[31m')] }), /\x1b/)
})

test('a site is a step only when its question was drafted (or could not be); otherwise it is learned and not mentioned', () => {
  const unset: SetupFacts = { ...DONE, bases: BARE.config.bases, sources: BARE.baseSources, graph: sitesOfGraph(['jira', 'confluence', 'slack']) }
  const drafted = setupReport({ ...unset, draft: { isDrafted: true } })
  assert.equal(steps(drafted).length, 1)
  assert.match(steps(drafted)[0] ?? '', /Send the read-only question in your prompt box.*Jira, Confluence and Slack/)
  assert.match(drafted, /Agent Services' response supplies the site URL/)
  assert.match(steps(setupReport({ ...unset, draft: { isDrafted: false, why: 'close the open dialog first, then try again' } }))[0] ?? '', /Run \/gas setup again.*close the open dialog/)
  // Slack only, Slack's question only.
  const slack = setupReport({ ...unset, graph: sitesOfGraph(['slack']), draft: { isDrafted: true } })
  assert.match(slack, /Slack records/)
  assert.doesNotMatch(slack, /Jira/)
  // No question tried (the catalog unread, or a graph with none of them): no step, no noise.
  assert.equal(setupReport({ ...DONE, bases: BARE.config.bases, sources: BARE.baseSources }), READY + '\nTrust rules: 2 loaded; /gas trust lists them.')
  assert.deepEqual(steps(setupReport({ ...unset, graph: sitesOfGraph(['salesforce']) })), [])
  // Learned and turned-off sites are nothing to do.
  const learned = loadLinkConfig({ learned: { atlassian: 'https://yourco.atlassian.net' }, user: '[bases]\nslack = ""\n' })
  assert.deepEqual(steps(setupReport({ ...DONE, bases: learned.config.bases, sources: learned.baseSources, graph: unset.graph, draft: { isDrafted: true } })), [])
  // A scope named like a prototype member is not a service.
  assert.deepEqual(sitesOfGraph(['constructor', 'toString', '__proto__']), { shown: [], askable: [] })
})

test('trust rules are never a step: some are counted, off and a saved file are said, none says nothing', () => {
  assert.doesNotMatch(setupReport({ ...DONE, trust: { ...DONE.trust, count: 0 } }), /trust/i)
  const off = setupReport({ ...DONE, trust: { ...DONE.trust, count: 1, isOff: true, isFileChanged: true } })
  assert.deepEqual(steps(off), [])
  assert.match(off, /Trust rules: 1 loaded, switched off for this session \(\/gas trust on\)/)
  assert.match(off, /was saved since the rules were read: run \/gas trust to load it/)
})

test('the report is plain text: no truncation marks, and every line is one a person can read', () => {
  for (const facts of [DONE, { ...DONE, servers: [], tools: [] }, { ...DONE, tools: tools('ask'), bases: BARE.config.bases, sources: BARE.baseSources, draft: { isDrafted: true as const } }, { ...DONE, bases: BARE.config.bases, sources: BARE.baseSources, graph: sitesOfGraph(['jira', 'slack']), draft: { isDrafted: true as const } }]) {
    const report = setupReport(facts)
    assert.doesNotMatch(report, /…/)
    assert.doesNotMatch(report, /undefined|\[object/)
  }
})
