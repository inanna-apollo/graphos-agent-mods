// A settled Agent Services call's RESULT under its row in the transcript, through the
// engine's ToolResult render event. Behaviour only: the block is there for a
// call that ran and its response was read, the engine's own result drawing is
// still there beneath it, a press on a record key opens its link, and nothing
// is drawn for a call still running, refused, failed, unreadable or not Agent Services.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { renderText, stubKit } from '../src/snapshot/text.ts'
import { ResultBlockView } from '../src/view/transcript.tsx'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const GITHUB_TOOLS = ['execute', 'validate', 'introspect', 'search'].map(tool => ({ name: `mcp__github__${tool}`, description: '', mcp: true }))
const OPERATION = 'query Open { jira_searchIssues(jql: "project = DEV", maxResults: 5) { issues { key fields } } }'
const LINKS_FILE = '/home/me/.claude/graphos-agent-mods/links.toml'
// The test's own link rule: the first row's key opens on a host the test names.
const USER_LINKS = `[bases]
wiki = "https://wiki.example.com"

[[record]]
service = "jira"
field = "key"
url = "{wiki}/browse/{value}"
`
const ISSUES = [
  ['DEV-1', 'First issue'],
  ['DEV-2', 'Second issue'],
  ['DEV-3', 'Third issue'],
  ['DEV-4', 'Fourth issue'],
  ['DEV-5', 'Fifth issue'],
]
const RESPONSE = JSON.stringify({ data: { jira_searchIssues: { issues: ISSUES.map(([key, summary]) => ({ key, fields: { summary } })) } } })

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Reply = { text: string; isError?: boolean; retained?: string }

/**
 * Agent Services beneath the plugin and the engine's own result row (one Text), counting its drawings by call.
 * `reply` is what the tool answers; `held` leaves the call running until released.
 */
function world(on: On, options: { reply?: () => Reply; held?: boolean; saved?: Record<string, string> } = {}) {
  const clock = mock.clock(on)
  const seen = { argv: [] as string[][], draws: new Map<string, number>(), ids: [] as string[], statuses: [] as (string | undefined)[] }
  on('ui.status', (_, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('tool.list', () => ({ value: [...GAS_TOOLS, ...GITHUB_TOOLS] }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['jira'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds issues"}', usage: USAGE } }))
  on('process.run', (_, e) => {
    seen.argv.push([...e.argv])
    const stdout = e.argv[0] === 'printenv' ? '/home/me\n' : e.argv[0] === 'uname' ? 'Darwin\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path === LINKS_FILE) return { value: USER_LINKS }
    if (options.saved?.[e.path] !== undefined) return { value: options.saved[e.path]! }
    throw new Error('ENOENT')
  })
  // The engine's own drawing of a result row: one line.
  on('ui.render', { component: 'ToolResult' }, (_, e) => {
    seen.draws.set(e.props.tool_use_id, (seen.draws.get(e.props.tool_use_id) ?? 0) + 1)
    return { type: 'Text', props: {}, children: ['engine result'] }
  })
  on('ui.render', { component: 'ToolGroup' }, () => ({ type: 'Text', props: {}, children: ['group'] }))
  let release = () => {}
  const isReleased = new Promise<void>(resolve => (release = resolve))
  on('tool.call', { tool: /__execute$/ }, async (_, e) => {
    if (e.tool_use_id !== undefined) seen.ids.push(e.tool_use_id)
    if (options.held === true) await isReleased
    const answer = options.reply?.() ?? { text: RESPONSE }
    return {
      ...(answer.retained !== undefined && { text: answer.text }),
      result: { content: [{ type: 'text' as const, text: answer.retained ?? answer.text }], isError: answer.isError === true },
      ...(answer.isError === true && { isError: true as const }),
    }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return { clock, seen, release }
}

const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

async function settle(clock: MockClock) {
  for (let step = 0; step < 12; step++) {
    await clock.advance(100)
    await pause(5)
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const resultRow = ($: Engine, id: string, props: { tool?: string; isErrored?: boolean } = {}, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: props.tool ?? EXECUTE, output: {}, isErrored: props.isErrored ?? false } })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a call that ran gets a RESULT block with its first records above the engine's own result row (${surface})`, async ($, on) => {
    const gas = world(on)
    await start($)
    await $.tool.call({ tool: EXECUTE, operation: OPERATION })
    await settle(gas.clock)
    const view = await resultRow($, gas.seen.ids[0]!, {}, surface)
    // Augmented, not replaced.
    expect(await view.find({ text: /engine result/ })).toBeDefined()
    expect(await view.find({ text: /RESULT/ })).toBeDefined()
    expect(await view.find({ text: /5/ })).toBeDefined()
    // The first line carries how big the response was.
    expect(await view.find({ text: /\d+\sB/ })).toBeDefined()
    expect(await view.find({ text: /First issue/ })).toBeDefined()
    // Three records, the rest counted.
    expect(await view.find({ text: /Third issue/ })).toBeDefined()
    expect(await view.find({ text: /Fourth issue/ })).toBeUndefined()
    expect(await view.find({ text: /2 more/ })).toBeDefined()
  })
}

test('a record key is a link a press opens, on the host the link rules name', async ($, on) => {
  const gas = world(on)
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await settle(gas.clock)
  const view = await resultRow($, gas.seen.ids[0]!)
  const keys = await view.findAll({ type: 'Markdown' })
  expect(keys.length).toBeGreaterThanOrEqual(3)
  const first = keys[0]!
  const href = /\(<(https:[^>]+)>\)/.exec(String(first.props.text))?.[1]
  expect(href).toBe('https://wiki.example.com/browse/DEV-1')
  await view.press({ key: first.key!, link: { href: href! } })
  await settle(gas.clock)
  expect(gas.seen.argv.filter(argv => argv[0] === 'open').map(argv => argv.at(-1))).toEqual(['https://wiki.example.com/browse/DEV-1'])
})

const groupCall = (id: string, isErrored = false) => ({ tool_use_id: id, tool: EXECUTE, input: { operation: OPERATION }, isRunning: false, isErrored, isInterrupted: false })

test('a call folded into a group has its block under its own line there; unfolded, the engine draws the output inline and the group adds none', async ($, on) => {
  const gas = world(on)
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await settle(gas.clock)
  const id = gas.seen.ids[0]!
  const folded = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolGroup', props: { calls: [groupCall(id)], isActive: false, isExpanded: false } })
  expect(await folded.find({ text: /group/ })).toBeDefined()
  expect(await folded.find({ text: /RESULT/ })).toBeDefined()
  expect(await folded.find({ text: /First issue/ })).toBeDefined()
  const unfolded = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolGroup', props: { calls: [groupCall(id)], isActive: false, isExpanded: true } })
  expect(await unfolded.find({ text: /group/ })).toBeDefined()
  expect(await unfolded.find({ text: /RESULT/ })).toBeUndefined()
})

test('nothing is drawn while the call is still running', async ($, on) => {
  const gas = world(on, { held: true })
  await start($)
  const running = $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await settle(gas.clock)
  const view = await resultRow($, gas.seen.ids[0]!)
  expect(await view.find({ text: /engine result/ })).toBeDefined()
  expect(await view.find({ text: /RESULT/ })).toBeUndefined()
  gas.release()
  await running
})

test('nothing for a call that failed, a response that could not be read, or another server’s execute', async ($, on) => {
  let next: Reply = { text: 'Error: the tool broke', isError: true }
  const gas = world(on, { reply: () => next })
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await settle(gas.clock)
  // The engine marks a failed call's row errored: the hook is never asked.
  const failed = await resultRow($, gas.seen.ids[0]!, { isErrored: true })
  expect(await failed.find({ text: /RESULT/ })).toBeUndefined()
  await failed.unmount()
  // Even asked, a failure has no block.
  const asked = await resultRow($, gas.seen.ids[0]!)
  expect(await asked.find({ text: /RESULT/ })).toBeUndefined()

  next = { text: 'this is not a GraphQL response' }
  await $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await settle(gas.clock)
  const unreadable = await resultRow($, gas.seen.ids[1]!)
  expect(await unreadable.find({ text: /engine result/ })).toBeDefined()
  expect(await unreadable.find({ text: /RESULT/ })).toBeUndefined()

  await $.tool.call({ tool: 'mcp__github__execute', operation: '{ viewer { login } }' })
  const github = await resultRow($, gas.seen.ids[2]!, { tool: 'mcp__github__execute' })
  expect(await github.find({ text: /engine result/ })).toBeDefined()
  expect(await github.find({ text: /RESULT/ })).toBeUndefined()
})

for (const retained of [false, true]) {
  test(`an oversized result flagged errored shows saved records from ${retained ? 'retained blocks' : 'the saved file'}`, async ($, on) => {
    const saved = '/home/me/.claude/projects/p/s/tool-results/big.json'
    const stand = `<persisted-output>\nOutput too large (58.2KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n...\n</persisted-output>`
    const gas = world(on, {
      reply: () => ({ text: stand, isError: true, ...(retained && { retained: RESPONSE }) }),
      saved: retained ? {} : { [saved]: RESPONSE },
    })
    await start($)
    const answer = await $.tool.call({ tool: EXECUTE, operation: OPERATION })
    expect(answer.isError).toBe(true)
    expect(JSON.stringify(answer)).toContain('persisted-output')
    if (retained) expect(JSON.stringify(answer)).toContain('First issue')
    await settle(gas.clock)
    const id = gas.seen.ids[0]!
    const view = await resultRow($, id, { isErrored: true })
    expect(await view.find({ text: /engine result/ })).toBeDefined()
    expect(await view.find({ text: /First issue/ })).toBeDefined()
    expect(await view.find({ text: /saved to a file/ })).toBeDefined()
    expect(gas.seen.statuses.at(-1)).toMatch(/1 call\b/)
    expect(gas.seen.statuses.some(line => / read\b/.test(line ?? ''))).toBe(false)
    const folded = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolGroup', props: { calls: [groupCall(id, true)], isActive: false, isExpanded: false } })
    expect(await folded.find({ text: /First issue/ })).toBeDefined()
  })
}

test('a settled row keeps its block after it leaves the history, and redraws for no one else’s call', async ($, on) => {
  const gas = world(on)
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await settle(gas.clock)
  const first = gas.seen.ids[0]!
  const own = await resultRow($, first)
  expect(await own.find({ text: /First issue/ })).toBeDefined()

  // Twenty more calls push the first out of the pane's history; its row is drawn no more for them.
  const drawn = gas.seen.draws.get(first)
  for (let call = 0; call < 20; call++) {
    await $.tool.call({ tool: EXECUTE, operation: OPERATION.replace('Open', `Open${call}`) })
    await settle(gas.clock)
  }
  expect(await own.find({ text: /engine result/ })).toBeDefined()
  expect(gas.seen.draws.get(first)).toBe(drawn)
  expect(await own.find({ text: /First issue/ })).toBeDefined()

  // A row drawn afresh (scrolled back to) still has it.
  await own.unmount()
  const again = await resultRow($, first)
  expect(await again.find({ text: /First issue/ })).toBeDefined()
})

test('a key too long for a column wraps on rows of its own on a narrow screen, nothing cut, and short keys keep their column', () => {
  const long = '[A-VERY-LONG-RECORD-KEY-THAT-IS-FAR-WIDER-THAN-THIS-NARROW-SCREEN-1234]'
  const wide = ResultBlockView({ kit: stubKit(), block: { heads: ['3 pages'], items: [{ key: long, text: 'its summary' }, { key: '[DEV-1]', text: 'short' }], more: 0 }, onOpen: () => undefined })
  const rows = renderText(wide, 30).split('\n')
  expect(Math.max(...rows.map(row => row.length))).toBeLessThanOrEqual(30)
  expect(rows.join('').replace(/\s+/g, '')).toContain(long)
  expect(rows.join('')).not.toContain('…')
  expect(rows.join('').replace(/\s+/g, '')).toContain('itssummary')

  const short = ResultBlockView({ kit: stubKit(), block: { heads: ['2 issues'], items: [{ key: '[DEV-1]', text: 'First' }, { key: '[DEV-22]', text: 'Second' }], more: 0 }, onOpen: () => undefined })
  const lines = renderText(short, 60).split('\n')
  // A key and its word share a row.
  expect(lines.some(row => /\[DEV-1\] +First/.test(row))).toBe(true)
})

test('the first line carries the size after what came back, or alone where there is nothing else to say on it', () => {
  const first = (heads: string[], size?: string) => renderText(ResultBlockView({ kit: stubKit(), block: { heads, items: [], more: 0, ...(size !== undefined && { size }) }, onOpen: () => undefined }), 60).split('\n')[0] ?? ''
  expect(first(['5 issues · first page'], '58 KB')).toMatch(/RESULT +5 issues · first page · 58 KB/)
  expect(first([], '58 KB saved to a file')).toMatch(/RESULT +58 KB saved to a file/)
  expect(first(['5 issues'])).not.toMatch(/KB/)
})
