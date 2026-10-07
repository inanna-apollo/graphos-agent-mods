// The verdict line under an Agent Services call's transcript row, through the engine's
// ToolUse and ToolGroup render events. Behaviour only: whether the line is
// there, once, and what drawing it costs.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const GITHUB_TOOLS = ['execute', 'validate', 'introspect', 'search'].map(tool => ({ name: `mcp__github__${tool}`, description: '', mcp: true }))
const OPERATION = 'query Find($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }'
const VARIABLES = JSON.stringify({ cql: 'type=page' })

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** The engine's own row beneath the plugin: one line naming the tool. Counts each row's drawings. */
function engineRows(on: On) {
  const draws = new Map<string, number>()
  on('ui.render', { component: 'ToolUse' }, (_, e) => {
    draws.set(e.props.tool_use_id, (draws.get(e.props.tool_use_id) ?? 0) + 1)
    return { type: 'Text', props: {}, children: [`row ${e.props.tool}`] }
  })
  on('ui.render', { component: 'ToolGroup' }, () => ({ type: 'Text', props: {}, children: ['group'] }))
  return (id: string) => draws.get(id) ?? 0
}

/** Agent Services beneath the plugin, every field allowed; resolves the settled call's tool_use_id. */
function settledGasCall(on: On) {
  const clock = mock.clock(on)
  let lists = 0
  on('tool.list', () => {
    lists += 1
    return { value: [...GAS_TOOLS, ...GITHUB_TOOLS] }
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') {
      const fields = ['confluence_search', 'confluence_search.results', 'confluence_search.results.title'].map(path => ({ decision: 'allow', path }))
      return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields }] })
    }
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Reads pages"}', usage: USAGE } }))
  const ids: string[] = []
  on('tool.call', { tool: /__execute$/ }, (_, e) => {
    if (e.tool_use_id !== undefined) ids.push(e.tool_use_id)
    return { result: { content: [{ type: 'text', text: '{"data":{"confluence_search":{"results":[]}}}' }], isError: false } }
  })
  const draws = engineRows(on)
  return { clock, ids, lists: () => lists, draws }
}

const row = (id: string, tool = EXECUTE) => ({ tool_use_id: id, tool, input: { operation: OPERATION, variables: VARIABLES }, isRunning: false, isErrored: false, isInterrupted: false })

/** Verdict lines drawn: each is a row of its own that starts with the inspector's dim label. */
async function verdictLines(view: { findAll: (query: { type: string; text: RegExp }) => Promise<unknown[]> }) {
  return (await view.findAll({ type: 'Box', text: /^⎿ {2}GraphOS Inspector/ })).length
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`an Agent Services call's verdict sits under its ToolUse row and under a folded group, never twice when the group unfolds (${surface})`, async ($: Engine, on) => {
    const gas = settledGasCall(on)
    await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
    for (let step = 0; step < 10; step++) await gas.clock.advance(100)
    const id = gas.ids[0]!

    const own = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'ToolUse', requestId: id, props: row(id) })
    expect(await own.find({ text: /row mcp__/ }), 'the engine row').toBeDefined()
    expect(await verdictLines(own)).toBe(1)
    expect(await own.find({ type: 'Box', text: /allowed · reads Confluence/ })).toBeDefined()

    const folded = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'ToolGroup', props: { calls: [row(id)], isActive: false, isExpanded: false } })
    expect(await verdictLines(folded)).toBe(1)

    // Unfolded, each call is a ToolUse row of its own, which carries the line: the group adds none.
    const unfolded = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'ToolGroup', props: { calls: [row(id)], isActive: false, isExpanded: true } })
    expect(await unfolded.find({ text: /group/ }), 'the engine group').toBeDefined()
    expect(await verdictLines(unfolded)).toBe(0)
  })
}

test('another server’s execute row is drawn without listing every tool on each redraw', async ($, on) => {
  const gas = settledGasCall(on)
  await $.tool.call({ tool: 'mcp__github__execute', operation: '{ viewer { login } }' })
  const before = gas.lists()

  const github = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: 'gh-1', props: row('gh-1', 'mcp__github__execute') })
  for (let redraw = 0; redraw < 5; redraw++) await github.redraw()
  expect(await verdictLines(github)).toBe(0)
  // At most the one listing that found github is not Agent Services.
  expect(gas.lists() - before).toBeLessThanOrEqual(1)

  const bash = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: 'bash-1', props: row('bash-1', 'Bash') })
  await bash.redraw()
  expect(await bash.find({ text: /row Bash/ })).toBeDefined()
  expect(gas.lists() - before).toBeLessThanOrEqual(1)
})

test('a settled call keeps its verdict line after it leaves the history', async ($, on) => {
  const gas = settledGasCall(on)
  const settle = async () => {
    for (let step = 0; step < 10; step++) await gas.clock.advance(100)
  }
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await settle()
  const first = gas.ids[0]!
  const own = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: first, props: row(first) })
  expect(await verdictLines(own)).toBeGreaterThan(0)

  // Twenty more calls push the first out of the pane's history; its row keeps its verdict.
  for (let call = 0; call < 20; call++) {
    await $.tool.call({ tool: EXECUTE, operation: OPERATION.replace('Find', `Find${call}`), variables: VARIABLES })
    await settle()
  }
  // A read draws whatever the row was invalidated for.
  expect(await own.find({ text: /row mcp__/ })).toBeDefined()
  expect(await verdictLines(own)).toBeGreaterThan(0)

  // A row drawn afresh (scrolled back to) still has it.
  await own.unmount()
  const again = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: first, props: row(first) })
  expect(await again.find({ type: 'Box', text: /allowed · reads Confluence/ })).toBeDefined()
})
