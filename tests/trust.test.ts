// Trust rules through the engine: an Agent Services call that fits the person's
// trust.graphql is let through at its permission check, anything else is
// left to the engine. Behaviour only: the verdict, and that the transcript
// and the pane say so. The matcher itself is covered in test/unit/trust.spec.ts.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const RULES_FILE = '/home/me/.claude/graphos-agent-mods/trust.graphql'

const RULES = 'query DocsLookup { confluence_search(cql: "type = page*", limit: 25) { results { title } } }'
const FITS = { operation: 'query Q($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }', variables: { cql: 'type = page AND space = ENG' } }
const OUTSIDE = { operation: 'query Q { confluence_search(cql: "type = page", limit: 5) { results { title body } } }', variables: {} }

const PANE_PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }
const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * Agent Services beneath the plugin, the engine asking for execute (allowing the
 * read-only tools), $HOME at /home/me and `rules` as the trust file (none
 * when undefined).
 */
function world(on: On, rules: string | undefined, decision: 'ask' | 'deny' | 'allow' = 'ask') {
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', (_, e) => ({ decision: e.tool === EXECUTE ? decision : ('allow' as const) }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds pages"}', usage: USAGE } }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (e.path === RULES_FILE && rules !== undefined) return { value: rules }
    throw new Error('ENOENT')
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
}

/** Real time between clock steps: the engine's answers cross a worker boundary. */
const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

async function until(clock: MockClock, isDone: () => boolean, ms: number) {
  for (let passed = 0; passed < ms && !isDone(); passed += 100) {
    await clock.advance(100)
    if (!isDone()) await pause(5)
  }
}

/**
 * A call as the model makes one: the tool.call recorded (as the engine's
 * own call site raises it), then its permission check asked under its id
 * while the call waits, as the engine asks before its dialog. The engine's
 * tool beneath is registered before the test first calls $.
 */
function caller(on: On, ceiling?: 'ask' | 'deny' | 'allow') {
  let id: string | undefined
  let release = () => {}
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    id = e.tool_use_id
    await new Promise<void>(resolve => (release = resolve))
    return { result: { content: [{ type: 'text' as const, text: '{"data":{"confluence_search":{"results":[]}}}' }], isError: false } }
  })
  return async ($: Engine, clock: MockClock, input: { operation: string; variables: Record<string, unknown> }) => {
    id = undefined
    const running = $.tool.call({ tool: EXECUTE, ...input })
    await until(clock, () => id !== undefined, 2_000)
    const verdict = await $.tool.check({ tool: EXECUTE, input, tool_use_id: id, ...(ceiling !== undefined && { ceiling }) })
    release()
    await running
    return verdict
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const pane = ($: Engine) => $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })

test('a call that fits a trust rule is allowed at its check, and the pane says which rule', async ($, on) => {
  const clock = mock.clock(on)
  world(on, RULES)
  const checked = caller(on)
  await start($)
  const verdict = await checked($, clock, FITS)
  expect(verdict.decision).toBe('allow')
  expect(verdict.reason).toContain('DocsLookup')
  await until(clock, () => false, 500)
  expect(await (await pane($)).find({ text: /ran without asking · trust rule DocsLookup/ })).toBeDefined()
})

test('a call outside the rules is left to ask, and the pane says what fell outside', async ($, on) => {
  const clock = mock.clock(on)
  world(on, RULES)
  const checked = caller(on)
  await start($)
  const verdict = await checked($, clock, OUTSIDE)
  expect(verdict.decision).toBe('ask')
  await until(clock, () => false, 500)
  const view = await pane($)
  // A short line in the pane; why it asked is the line's card's to say.
  expect(await view.find({ text: /asked · no trust rule fits/ })).toBeDefined()
  expect(await view.find({ text: /body is outside DocsLookup/ })).toBeDefined()
})

test('with no rules file nothing changes: the call asks and the pane says nothing of trust', async ($, on) => {
  const clock = mock.clock(on)
  world(on, undefined)
  const checked = caller(on)
  await start($)
  expect((await checked($, clock, FITS)).decision).toBe('ask')
  await until(clock, () => false, 500)
  expect(await (await pane($)).find({ text: /trust rule|asked:/ })).toBeUndefined()
})

for (const decision of ['deny', 'allow'] as const) {
  test(`the engine's ${decision} stands, whatever the rules say`, async ($, on) => {
    const clock = mock.clock(on)
    world(on, RULES, decision)
    const checked = caller(on)
    await start($)
    expect((await checked($, clock, FITS)).decision).toBe(decision)
  })
}

for (const [ceiling, expected] of [['ask', 'ask'], ['deny', 'ask'], ['allow', 'allow']] as const) {
  test(`trust respects the engine's ${ceiling} ceiling`, async ($, on) => {
    const clock = mock.clock(on)
    world(on, RULES)
    const checked = caller(on, ceiling)
    await start($)
    const verdict = await checked($, clock, FITS)
    expect(verdict.decision).toBe(expected)
    expect(verdict.ceiling).toBe(ceiling)
  })
}

test('/gas trust off makes every call ask; /gas trust lists the rules and their problems', async ($, on) => {
  const clock = mock.clock(on)
  world(on, `${RULES}\nmutation M { x }`)
  const checked = caller(on)
  await start($)
  const listed = JSON.stringify(await $.command.run({ command: 'gas', args: 'trust', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }))
  expect(listed).toContain('DocsLookup: confluence_search')
  expect(listed).toMatch(/Skipped: .*mutation/)
  await $.command.run({ command: 'gas', args: 'trust off', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })
  expect((await checked($, clock, FITS)).decision).toBe('ask')
})

test('a mutation never runs unasked, even when a rule names its root', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 'query All { confluence_search }')
  const checked = caller(on)
  await start($)
  expect((await checked($, clock, { operation: 'mutation M { confluence_search(cql: "x") { results { title } } }', variables: {} })).decision).toBe('ask')
})
