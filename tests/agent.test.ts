// A call a subagent made, through the engine: the pane says a subagent made it
// and which one, the main loop's own calls say nothing, and looking the agent
// up never holds the call. Behaviour only: the text a person would see.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const OPERATION = 'query Find($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }'
const VARIABLES = JSON.stringify({ cql: 'type=page' })

const PANE_PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }
const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const AGENT = { id: 'agent-7', type: 'Explore', description: 'find naming pages', status: 'running' as const }

/** Agent Services beneath the plugin and `agents` as the session's agent list. */
function world(on: On, agents: () => Promise<readonly (typeof AGENT)[]> | readonly (typeof AGENT)[]) {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds pages"}', usage: USAGE } }))
  on('agent.list', async () => ({ value: [...(await agents())] }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text' as const, text: '{"data":{"confluence_search":{"results":[]}}}' }], isError: false } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return clock
}

const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

/** Lets the work started beside the call finish. */
async function settle(clock: MockClock) {
  for (let step = 0; step < 15; step++) {
    await clock.advance(100)
    await pause(5)
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const pane = ($: Engine) => $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })

/** The call as the engine raises it inside a subagent's loop: `agentId` rides on the event. */
const fromAgent = ($: Engine, agentId: string) => $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES, agentId } as never)

test('a call a subagent made says so in the pane, with the agent’s type and task', async ($, on) => {
  const clock = world(on, () => [AGENT])
  await start($)
  await fromAgent($, 'agent-7')
  await settle(clock)
  const view = await pane($)
  expect(await view.find({ text: /from subagent/ })).toBeDefined()
  expect(await view.find({ text: /Explore: find naming pages/ })).toBeDefined()
})

test('the main loop’s own call says nothing of an agent', async ($, on) => {
  const clock = world(on, () => [AGENT])
  await start($)
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await settle(clock)
  const view = await pane($)
  expect(await view.find({ text: /subagent/ })).toBeUndefined()
  // Nor of a plugin: the call is Claude's.
  expect(await view.find({ text: /from the .* plugin/ })).toBeUndefined()
})

test('an agent the list does not know still says a subagent made the call', async ($, on) => {
  const clock = world(on, () => [])
  await start($)
  await fromAgent($, 'agent-ghost')
  await settle(clock)
  const view = await pane($)
  expect(await view.find({ text: /from subagent/ })).toBeDefined()
  expect(await view.find({ text: /Explore/ })).toBeUndefined()
})

test('a lookup that never answers holds up neither the call nor the pane', async ($, on) => {
  const clock = world(on, () => new Promise(() => undefined))
  await start($)
  // The call returns though its agent lookup is still out.
  const ran = await fromAgent($, 'agent-7')
  expect(ran.deny).toBeUndefined()
  await settle(clock)
  expect(await (await pane($)).find({ text: /from subagent/ })).toBeDefined()
})

test('what a subagent’s task says is drawn escaped', async ($, on) => {
  const clock = world(on, () => [{ ...AGENT, description: 'read \x1b[2J this' }])
  await start($)
  await fromAgent($, 'agent-7')
  await settle(clock)
  const view = await pane($)
  expect(await view.find({ text: /read/ })).toBeDefined()
  expect(JSON.stringify(await view.find({ text: /from subagent/ }))).not.toContain('\\u001b')
})
