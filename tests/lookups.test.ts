// Claude's lookups (search, introspect, validate, dry_run) through the engine:
// each shows in the pane with what it found and gets a verdict line under its
// row; an execute waiting at its dialog keeps the view; the pane opens for a
// call only at a dialog; the engine's verdict on a lookup is never changed.
// Behaviour only: the text a person would see.

import { summarySystemPrompt } from '../src/summary.ts'
import type { LookupTool } from '../types'

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const SEARCH = `mcp__${SERVER}__search`
const VALIDATE = `mcp__${SERVER}__validate`
const DRY_RUN = `mcp__${SERVER}__dry_run`
const INTROSPECT = `mcp__${SERVER}__introspect`
const GAS_TOOLS = ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const OPERATION = 'query Find($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }'
const VARIABLES = JSON.stringify({ cql: 'type=page' })

const PANE_PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} }
const text = (value: unknown) => ({ result: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const payload = (value: unknown) => ({ value: text(value).result })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const SEARCH_ANSWER = {
  bundleDigest: 'd',
  results: [
    {
      operationName: 'confluence_search',
      operationType: 'query',
      scope: 'confluence',
      score: 0.03,
      types: ['type Query {\n  """Search Confluence content with CQL."""\n  confluence_search(cql: String!, limit: Int): Confluence_SearchResult\n}\n', 'type Confluence_SearchResult {\n  totalSize: Int\n}\n'],
    },
  ],
  scopes: ['confluence', 'jira'],
}
const INVALID = 'query FindPages { confluence_search(cql: "type=page") { nosuch } }'
const INVALID_ANSWER = { bundleDigest: 'd', valid: false, scope: 'confluence', errors: ['Error: type `Confluence_SearchResult` does not have a field `nosuch`'] }
const MEMBERS = 'query Members { acme_listMembers(orgId: "o1") { name email } }'
const DRY_ANSWER = {
  bundleDigest: 'd',
  results: [{ denyOperation: false, fields: [{ decision: 'allow', path: 'acme_listMembers' }, { decision: 'allow', path: 'acme_listMembers.name' }, { decision: 'deny', path: 'acme_listMembers.email' }] }],
}

type Options = { check?: (tool: string) => 'ask' | 'allow'; isReadLate?: boolean; introspectAnswer?: unknown; dryRunAnswer?: unknown; headline?: string; isHeadlineFailure?: boolean }

/** Agent Services beneath the plugin, answering each lookup with its canned answer; records the panes opened and every check's verdict. */
function world(on: On, options: Options = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  const opened: string[] = []
  const modelRequests: { prompt: string; system: string }[] = []
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', (_, e) => ({ decision: options.check?.(e.tool) ?? ('allow' as const) }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('mcp.call', async (_, e) => {
    // With isReadLate, the mod's own schema reads answer only after Claude's lookup has.
    if (options.isReadLate === true) await gate.answered
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', (_, e) => {
    modelRequests.push({ prompt: e.prompt, system: e.system ?? '' })
    if (options.isHeadlineFailure === true) throw new Error('helper unavailable')
    return { value: { isAnswered: true as const, text: JSON.stringify({ headline: options.headline ?? 'Finds pages' }), usage: USAGE } }
  })
  // Each lookup waits at its dialog until the test has asked its check, as the engine does.
  let answer = () => {}
  const gate = { id: undefined as string | undefined, release: () => {}, answered: new Promise<void>(resolve => (answer = resolve)) }
  const held = (value: unknown) => async (_: unknown, e: { tool_use_id?: string }) => {
    gate.id = e.tool_use_id
    await new Promise<void>(resolve => (gate.release = resolve))
    // Claude's answer is in once this returns; the late reads follow it.
    setTimeout(answer, 20)
    return text(value)
  }
  on('tool.call', { tool: SEARCH }, held(SEARCH_ANSWER))
  on('tool.call', { tool: VALIDATE }, held(INVALID_ANSWER))
  on('tool.call', { tool: DRY_RUN }, held(options.dryRunAnswer ?? DRY_ANSWER))
  on('tool.call', { tool: INTROSPECT }, async (_, e) => {
    gate.id = e.tool_use_id
    await new Promise<void>(resolve => (gate.release = resolve))
    if (options.introspectAnswer !== undefined) return text(options.introspectAnswer)
    const error = { bundleDigest: 'd', errors: [{ extensions: { code: 'TYPE_NOT_AVAILABLE' }, message: 'scope `confluence` has no type `SearchResult`' }] }
    // As core relays a tool's error: the text, flagged.
    return { isError: true as const, result: JSON.stringify(error), text: JSON.stringify(error) }
  })
  on('ui.render', { component: 'ToolUse' }, (_, e) => ({ type: 'Text', props: {}, children: [`row ${e.props.tool}`] }))
  on('ui.render', { component: 'ToolGroup' }, () => ({ type: 'Text', props: {}, children: ['group'] }))
  on('command.run', () => ({ text: '' }))
  return { clock, opened, gate, modelRequests }
}

const setTimeout = (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout
const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

/** Lets the work started beside a call finish. */
async function settle(clock: MockClock) {
  for (let step = 0; step < 15; step++) {
    await clock.advance(100)
    await pause(5)
  }
}

const pane = ($: Engine) => $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })
const row = (id: string, tool: string) => ({ tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })
const command = ($: Engine, args: string) => $.command.run({ command: 'gas', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

/** A lookup as the model makes one, its permission check asked under its id while it waits; resolves its id once it has run. */
async function asModel($: Engine, gas: ReturnType<typeof world>, tool: string, input: Record<string, unknown>) {
  gas.gate.id = undefined
  const running = $.tool.call({ tool, ...input } as never)
  for (let waited = 0; waited < 2_000 && gas.gate.id === undefined; waited += 100) {
    await gas.clock.advance(100)
    await pause(5)
  }
  const id = gas.gate.id ?? ''
  // The dialog stays up a while, as a person reads it: the pump runs meanwhile.
  await settle(gas.clock)
  const verdict = await $.tool.check({ tool, input, tool_use_id: id } as never)
  gas.gate.release()
  await running
  await settle(gas.clock)
  return { id, verdict }
}

/** Verdict lines drawn: each starts with the inspector's dim label. */
const verdictLines = async (view: { findAll: (query: { type: string; text: RegExp }) => Promise<unknown[]> }) => (await view.findAll({ type: 'Box', text: /^⎿ {2}GraphOS Inspector/ })).length

for (const surface of ['terminal', 'desktop'] as const) {
  test(`expanded introspection members stay visible when opened and can collapse (${surface})`, async ($, on) => {
    const sdl = `enum Example { ${Array.from({ length: 61 }, (_, at) => `"Choice ${at}." CHOICE_${at}`).join(' ')} }`
    const gas = world(on, { introspectAnswer: { types: [sdl] } })
    await asModel($, gas, INTROSPECT, { type: 'Example' })
    const view = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'gas', props: PANE_PROPS })
    expect(await view.find({ type: 'Button', text: /^\s*CHOICE_15\s*$/ })).toBeUndefined()
    const expand = await view.find({ type: 'Button', text: /Show 49 more members/ })
    expect(expand?.key).toBeDefined()
    await view.press({ key: expand!.key! })
    const member = await view.find({ type: 'Button', text: /^\s*CHOICE_15\s*$/ })
    expect(member?.key).toBeDefined()
    await view.press({ key: member!.key! })
    expect(await view.find({ type: 'Button', text: /^\s*CHOICE_15\s*$/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^Choice 15\.$/ })).toBeDefined()
    const less = await view.find({ type: 'Button', text: /^Show fewer$/ })
    await view.press({ key: less!.key! })
    expect(await view.find({ type: 'Button', text: /^\s*CHOICE_15\s*$/ })).toBeUndefined()
  })
}

test('a search shows the operations it found, and its row gets a verdict line', async ($, on) => {
  const gas = world(on)
  const { id } = await asModel($, gas, SEARCH, { terms: ['confluence', 'pages'] })
  const view = await pane($)
  expect(await view.find({ text: /SEARCH/ })).toBeDefined()
  expect(await view.find({ text: /confluence_search/ })).toBeDefined()
  expect(await view.find({ text: /Search Confluence content with CQL/ })).toBeDefined()

  const own = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: id, props: row(id, SEARCH) })
  expect(await verdictLines(own)).toBe(1)
  expect(await own.find({ type: 'Box', text: /confluence_search/ })).toBeDefined()
})

test('a validate that fails says the operation will fail, and why', async ($, on) => {
  const gas = world(on)
  await asModel($, gas, VALIDATE, { scope: 'confluence', operation: INVALID })
  const view = await pane($)
  expect(await view.find({ text: /will fail/ })).toBeDefined()
  expect(await view.find({ text: /nosuch/ })).toBeDefined()
})

test('a validate’s answer stands when the schema pass lands after it', async ($, on) => {
  const gas = world(on, { isReadLate: true })
  const { id } = await asModel($, gas, VALIDATE, { scope: 'confluence', operation: INVALID })
  await settle(gas.clock)
  const view = await pane($)
  expect(await view.find({ text: /will fail/ })).toBeDefined()
  // The schema pass ran once the answer was in, and is over.
  expect(await view.find({ text: /not read yet/ })).toBeUndefined()
  const own = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: id, props: row(id, VALIDATE) })
  expect(await own.find({ type: 'Box', text: /will fail: .*nosuch/ })).toBeDefined()
})

test('a failed introspect says what Agent Services answered, in the pane and under its row', async ($, on) => {
  const gas = world(on)
  const { id } = await asModel($, gas, INTROSPECT, { scope: 'confluence', type: 'SearchResult' })
  const view = await pane($)
  expect(await view.find({ text: /has no type/ })).toBeDefined()
  expect(await view.find({ text: /checking/ })).toBeUndefined()
  const own = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: id, props: row(id, INTROSPECT) })
  expect(await own.find({ type: 'Box', text: /has no type/ })).toBeDefined()
})

test('a dry_run says which fields policy denies', async ($, on) => {
  const gas = world(on)
  await asModel($, gas, DRY_RUN, { requests: [{ scope: 'acme', operation: MEMBERS }] })
  const view = await pane($)
  expect(await view.find({ text: /DRY RUN/ })).toBeDefined()
  expect(await view.find({ text: /email.*denied|denied.*email/ })).toBeDefined()
})

test('a lookup while an execute waits at its dialog leaves the execute shown', async ($, on) => {
  const gas = world(on, { check: tool => (tool === EXECUTE ? 'ask' : 'allow') })
  let release = () => {}
  on('tool.call', { tool: EXECUTE }, async () => {
    await new Promise<void>(resolve => (release = resolve))
    return text({ data: { confluence_search: { results: [] } } })
  })
  const running = $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await settle(gas.clock)
  await asModel($, gas, SEARCH, { terms: ['jira'] })
  const view = await pane($)
  expect(await view.find({ text: /Finds pages/ })).toBeDefined()
  expect(await view.find({ text: /“jira”/ })).toBeUndefined()
  release()
  await running
})

test('a lookup leaves a person on the past call they stepped back to', async ($, on) => {
  const gas = world(on)
  on('tool.call', { tool: EXECUTE }, () => text({ data: { confluence_search: { results: [] } } }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await settle(gas.clock)
  await asModel($, gas, SEARCH, { terms: ['confluence'] })
  const view = await pane($)
  expect(await view.find({ text: /“confluence”/ }), 'the search, live').toBeDefined()
  await command($, 'older')
  await view.redraw()
  expect(await view.find({ text: /Finds pages/ }), 'the execute, stepped back to').toBeDefined()
  await asModel($, gas, SEARCH, { terms: ['jira'] })
  await view.redraw()
  expect(await view.find({ text: /Finds pages/ }), 'still the execute').toBeDefined()
  expect(await view.find({ text: /“jira”/ })).toBeUndefined()
})

test('the pane opens for a lookup that asks, and not for one that runs unasked', async ($, on) => {
  let decision: 'ask' | 'allow' = 'allow'
  const gas = world(on, { check: () => decision })
  await asModel($, gas, SEARCH, { terms: ['confluence'] })
  expect(gas.opened).not.toContain('gas')
  decision = 'ask'
  await asModel($, gas, SEARCH, { terms: ['jira'] })
  expect(gas.opened).toContain('gas')
})

test('a lookup’s verdict is the engine’s: no trust rule lifts its ask', async ($, on) => {
  const gas = world(on, { check: () => 'ask' })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('trust.graphql')) return { value: 'query Any { confluence_search(cql: "*") { totalSize } }' }
    throw new Error('ENOENT')
  })
  const { verdict } = await asModel($, gas, SEARCH, { terms: ['confluence'] })
  expect(verdict.decision).toBe('ask')
})

test('a folded group gets one verdict line for each call in it, lookups included', async ($, on) => {
  const gas = world(on)
  const search = await asModel($, gas, SEARCH, { terms: ['confluence'] })
  const validate = await asModel($, gas, VALIDATE, { scope: 'confluence', operation: INVALID })
  const folded = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolGroup', props: { calls: [row(search.id, SEARCH), row(validate.id, VALIDATE)], isActive: false, isExpanded: false } })
  expect(await verdictLines(folded)).toBe(2)
})

test('another server’s search is none of its business', async ($, on) => {
  const gas = world(on)
  on('tool.call', { tool: 'mcp__github__search' }, () => text({ results: [] }))
  await $.tool.call({ tool: 'mcp__github__search', terms: ['viewer'] } as never)
  await settle(gas.clock)
  expect(await (await pane($)).find({ text: /“viewer”/ })).toBeUndefined()
})

for (const [tool, input] of [
  [SEARCH, { terms: ['confluence', 'pages'] }],
  [INTROSPECT, { scope: 'confluence', type: 'Role' }],
  [VALIDATE, { scope: 'confluence', operation: INVALID }],
  [DRY_RUN, { requests: [{ scope: 'acme', operation: MEMBERS }] }],
] as const) {
  test(`${tool.split('__').pop()} gets a Haiku explanation without changing its check facts`, async ($, on) => {
    const gas = world(on, { headline: 'Explains the available schema choices', introspectAnswer: { types: ['"A member role." enum Role { ADMIN MEMBER }'] } })
    await asModel($, gas, tool, input)
    const view = await pane($)
    expect(await view.find({ text: /Explains the available schema choices/ })).toBeDefined()
    expect(await view.find({ text: /Haiku/ })).toBeDefined()
    expect(gas.modelRequests).toHaveLength(1)
    expect(gas.modelRequests[0]?.system).toBe(summarySystemPrompt(tool.split('__').at(-1) as LookupTool))
    if (tool === VALIDATE) expect(await view.find({ text: /will fail/ })).toBeDefined()
    if (tool === DRY_RUN) expect(await view.find({ text: /email.*denied|denied.*email/ })).toBeDefined()
  })
}

test('different searches cannot reuse a headline merely because their schema matches', async ($, on) => {
  const gas = world(on)
  await asModel($, gas, SEARCH, { terms: ['pages'] })
  await asModel($, gas, SEARCH, { terms: ['members'] })
  expect(gas.modelRequests).toHaveLength(2)
  expect(gas.modelRequests[0]?.prompt.includes('pages')).toBe(true)
  expect(gas.modelRequests[1]?.prompt.includes('members')).toBe(true)
})

test('an unusable Haiku answer leaves the factual lookup headline and no credit', async ($, on) => {
  const gas = world(on, { headline: '' })
  await asModel($, gas, SEARCH, { terms: ['pages'] })
  const view = await pane($)
  expect(await view.find({ text: /Found.*matching operation/ })).toBeDefined()
  expect(await view.find({ text: /Haiku/ })).toBeUndefined()
  expect(gas.modelRequests).toHaveLength(1)
})

test('a failed Haiku helper leaves a readable lookup and clears its pending headline', async ($, on) => {
  const gas = world(on, { isHeadlineFailure: true })
  await asModel($, gas, SEARCH, { terms: ['pages'] })
  const view = await pane($)
  expect(await view.find({ text: /Found.*matching operation/ })).toBeDefined()
  expect(await view.find({ text: /Haiku/ })).toBeUndefined()
  expect(await view.find({ type: 'Client', key: 'headline' })).toBeUndefined()
  await settle(gas.clock)
  expect(gas.modelRequests).toHaveLength(1)
})

test('an unreadable operation-check answer is not sent to the headline helper', async ($, on) => {
  const gas = world(on, { dryRunAnswer: 'not a schema/check answer' })
  await asModel($, gas, DRY_RUN, { requests: [{ scope: 'acme', operation: MEMBERS }] })
  expect(gas.modelRequests).toHaveLength(0)
  expect(await (await pane($)).find({ text: /could not be read|outcomes are unavailable/ })).toBeDefined()
})
