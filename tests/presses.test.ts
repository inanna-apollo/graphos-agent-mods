// What the pane's presses do through the engine: open a link on a host the
// settings name and no other, draft an access request into the prompt box
// and never send it, and say in one line when they cannot. Behaviour only.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const PANE_PROPS = {
  title: 'GraphOS Inspector',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const ran = (data: unknown) => ({ result: { content: [{ type: 'text' as const, text: JSON.stringify(data) }], isError: false } })

// The person's own links.toml: the shipped one names no site, each person sets theirs.
const SITE_LINKS = '[bases]\natlassian = "https://example.atlassian.net"\n'

const SEARCH = 'query Find($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }'
const SEARCH_VARIABLES = JSON.stringify({ cql: 'type=page AND text ~ "query plan"' })

const ROOT = 'acme_customer_data_listOrganizationMembers'
const MEMBERS = `query OrgAdmins($org: ID!) { ${ROOT}(orgId: $org) { id name email } }`
const SDL = {
  root: `type Query { ${ROOT}(orgId: ID!): [Acme_Customer_Data_Member] }`,
  types: ['type Acme_Customer_Data_Member { id: ID name: String email: String }'],
}

/** What the world beneath saw: host commands, transcript lines, prompt box writes, sends, tool calls. */
type Seen = { argv: string[][]; logs: string[]; fills: { text: string; mode: string }[]; submits: number; tools: string[] }

/**
 * Agent Services and the host beneath the plugin. `userLinks` is the person's
 * links.toml, read when the links load (undefined: none).
 */
function world(on: On, options: { box?: string; userLinks?: () => string | undefined; isOpenerBroken?: boolean; isBoxRefusing?: boolean } = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 6) })
  const seen: Seen = { argv: [], logs: [], fills: [], submits: 0, tools: [] }
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    seen.tools.push(e.tool)
    const args = e.args as Record<string, unknown>
    if (e.tool === 'search') {
      const terms = args.terms as string[]
      if (terms.length === 0) return payload({ bundleDigest: 'd', scopes: ['confluence', 'acme-customer-data'], results: [] })
      return payload({ bundleDigest: 'd', results: terms[0] === ROOT ? [{ operationName: ROOT, operationType: 'query', types: [SDL.root] }] : [] })
    }
    if (e.tool === 'introspect') return payload({ bundleDigest: 'd', types: SDL.types })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    const fields = [ROOT, `${ROOT}.id`, `${ROOT}.name`].map(path => ({ decision: 'allow', path }))
    return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [...fields, { decision: 'deny', path: `${ROOT}.email`, denialContext: 'token' }] }] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Reads things"}', usage: USAGE } }))
  on('process.run', (_, e) => {
    seen.argv.push([...e.argv])
    if (e.argv[0] === 'open' && options.isOpenerBroken === true) throw new Error('spawn open ENOENT')
    const stdout = e.argv[0] === 'printenv' ? '/home/me\n' : e.argv[0] === 'uname' ? 'Darwin\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => {
    const text = e.path === '/home/me/.claude/graphos-agent-mods/links.toml' ? options.userLinks?.() : undefined
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: options.box ?? '', cursor: (options.box ?? '').length } }))
  on('prompt.fill', (_, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })
    if (options.isBoxRefusing === true) return { isFilled: false, refusal: 'dialog' as const, text: '', cursor: 0 }
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', (_, e) => {
    seen.submits += 1
    return { text: e.text }
  })
  on('tool.call', { tool: EXECUTE }, (_, e) => {
    if (String(e.operation).includes(ROOT)) {
      const errors = [0, 1].map(index => ({
        message: '',
        path: [ROOT, String(index), 'email'],
        extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: 'token', visibility: 'requestable', reason: '' },
      }))
      return ran({ data: { [ROOT]: [{ id: 'm0', name: 'Leo', email: null }, { id: 'm1', name: 'Sam', email: null }] }, errors })
    }
    return ran({ data: { confluence_search: { results: [{ title: 'Query plans' }] } } })
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const settle = async () => {
    for (let step = 0; step < 15; step++) await clock.advance(100)
  }
  return { clock, seen, settle }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const mountPane = ($: Engine, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'gas', props: PANE_PROPS })

test('a link press opens a host the settings name, and not one they no longer name', async ($, on) => {
  let userLinks: string | undefined = SITE_LINKS
  const gas = world(on, { userLinks: () => userLinks })
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: SEARCH, variables: SEARCH_VARIABLES })
  await gas.settle()

  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'open:hotkey' })
  await gas.settle()
  const opened = gas.seen.argv.filter(argv => argv[0] === 'open')
  expect(opened).toHaveLength(1)
  expect(opened[0]![1]).toMatch(/^https:\/\/example\.atlassian\.net\//)

  // The person turns that host off; the link already drawn no longer opens, and they are told.
  userLinks = '[bases]\natlassian = ""\n'
  await $.command.run({ command: 'gas', args: 'links', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await pane.press({ key: 'open:hotkey' })
  await gas.settle()
  expect(gas.seen.argv.filter(argv => argv[0] === 'open')).toHaveLength(1)
  expect(gas.seen.logs.some(line => /did not open that link/.test(line))).toBe(true)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a deep link is the plugin's to open on the terminal, the surface's own elsewhere (${surface})`, async ($, on) => {
    const gas = world(on, { userLinks: () => SITE_LINKS })
    await start($)
    await $.tool.call({ tool: EXECUTE, operation: SEARCH, variables: SEARCH_VARIABLES })
    await gas.settle()

    const pane = await mountPane($, surface)
    const link = await pane.find({ type: 'Markdown', key: 'open:link:0' })
    expect(link).toBeDefined()
    // On the terminal a click is a press the plugin answers (tmux can strip a terminal's own link); elsewhere the surface opens it.
    expect(link?.props.pressableLinks !== undefined).toBe(surface === 'terminal')
  })
}

for (const box of ['', 'and also check the runbook'] as const) {
  test(`the access-request press drafts into the prompt box${box === '' ? '' : ' after what is typed'}, and never sends or calls anything`, async ($, on) => {
    const gas = world(on, { box })
    await start($)
    await $.tool.call({ tool: EXECUTE, operation: MEMBERS, variables: JSON.stringify({ org: 'demo' }) })
    await gas.settle()

    const pane = await mountPane($, 'terminal')
    const toolsBefore = gas.seen.tools.length
    await pane.press({ key: 'request:draft' })
    await gas.settle()
    expect(gas.seen.fills).toHaveLength(1)
    expect(gas.seen.fills[0]!.text).toMatch(/access request for .email./)
    if (box === '') expect(gas.seen.fills[0]!.mode).not.toBe('append')
    else {
      expect(gas.seen.fills[0]!.mode).toBe('append')
      expect(gas.seen.fills[0]!.text.startsWith('\n')).toBe(true)
    }
    expect(gas.seen.submits).toBe(0)
    expect(gas.seen.tools.length).toBe(toolsBefore)
  })
}

test('a link the system cannot open, and a draft the prompt box refuses, are each said in one line', async ($, on) => {
  const gas = world(on, { userLinks: () => SITE_LINKS, isOpenerBroken: true, isBoxRefusing: true })
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: SEARCH, variables: SEARCH_VARIABLES })
  await gas.settle()
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'open:hotkey' })
  await gas.settle()
  expect(gas.seen.logs.filter(line => /could not open https:\/\/example\.atlassian\.net\//.test(line))).toHaveLength(1)

  await $.tool.call({ tool: EXECUTE, operation: MEMBERS, variables: JSON.stringify({ org: 'demo' }) })
  await gas.settle()
  await pane.press({ key: 'request:draft' })
  await gas.settle()
  expect(gas.seen.logs.filter(line => /close the open dialog/.test(line))).toHaveLength(1)
})

test('/gas runs at once when typed mid-turn', async ($, on) => {
  const registered: { name: string; immediate?: boolean }[] = []
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => {
    registered.push({ name: e.name, ...(e.immediate !== undefined && { immediate: e.immediate }) })
    return { value: { command: e.name } }
  })
  await start($)
  expect(registered).toContainEqual({ name: 'gas', immediate: true })
})
