// The spinner's text while an Agent Services call runs, through the engine's Spinner render
// event. Behaviour only: what the spinner reads. It names a call that runs with
// no dialog (the check answered allow), is left alone while a dialog could be
// up and for every other mode, and goes back to the engine's word when the call ends.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const OPERATION = 'query FindPages($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }'
const VARIABLES = { cql: 'type = page' }
const RULES_FILE = '/home/me/.claude/graphos-agent-mods/trust.graphql'
const RULES = 'query DocsLookup { confluence_search(cql: "type = page*", limit: 25) { results { title } } }'

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Options = { decision: 'ask' | 'allow'; headline?: string; rules?: string }

/**
 * Agent Services beneath the plugin with the engine's own Spinner (one Text, the message
 * or the word, then the suffix) and `decision` as the permission check's answer.
 * The call itself waits until `release`.
 */
function world(on: On, options: Options) {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', (_, e) => ({ decision: e.tool === EXECUTE ? options.decision : ('allow' as const) }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () =>
    options.headline === undefined
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text: JSON.stringify({ headline: options.headline }), usage: USAGE } },
  )
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (e.path === RULES_FILE && options.rules !== undefined) return { value: options.rules }
    throw new Error('ENOENT')
  })
  on('ui.render', { component: 'Spinner' }, (_, e) => ({ type: 'Text', props: {}, children: [`${e.props.message ?? e.props.word}${e.props.suffix}`] }))
  let id: string | undefined
  let release = () => {}
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    id = e.tool_use_id
    await new Promise<void>(resolve => (release = resolve))
    return { result: { content: [{ type: 'text' as const, text: '{"data":{"confluence_search":{"results":[]}}}' }], isError: false } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return {
    clock,
    /** The id of the latest call, and its permission check asked again as a late or repeated check would. */
    checkAgain: ($: Engine) => $.tool.check({ tool: EXECUTE, input: { operation: OPERATION, variables: VARIABLES }, tool_use_id: id }),
    /** The call, held in its tool; its permission check asked as the engine asks before running it. */
    async begin($: Engine) {
      id = undefined
      const running = $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
      for (let passed = 0; passed < 2_000 && id === undefined; passed += 100) {
        await clock.advance(100)
        if (id === undefined) await pause(5)
      }
      await $.tool.check({ tool: EXECUTE, input: { operation: OPERATION, variables: VARIABLES }, tool_use_id: id })
      // Boxed: an async function returning the promise itself would wait for the call.
      return { running }
    },
    finish: async (call: { running: Promise<unknown> }) => {
      release()
      await call.running
    },
  }
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
type SpinnerProps = { word: string; message: string | null; suffix: string; mode: 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use' }
const SPINNER: SpinnerProps = { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' }
let instances = 0
/** A spinner row as the engine draws one; each mount is an instance of its own. */
const spinner = ($: Engine, props: Partial<SpinnerProps> = {}) =>
  $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Spinner', requestId: `spinner-${(instances += 1)}`, props: { ...SPINNER, ...props } })

test('while a call the engine allowed runs, the spinner reads the call’s headline in place of its word', async ($, on) => {
  const gas = world(on, { decision: 'allow', headline: 'Find the wiki pages on query plans.' })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  const text = (await (await spinner($)).find({ type: 'Text' }))?.text ?? ''
  expect(text).toContain('Find the wiki pages on query plans')
  expect(text).not.toContain('Sauteing')
  await gas.finish(running)
})

test('a call a trust rule let through is named too', async ($, on) => {
  const gas = world(on, { decision: 'ask', headline: 'Find the wiki pages on query plans.', rules: RULES })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  expect((await (await spinner($)).find({ type: 'Text' }))?.text).toContain('Find the wiki pages')
  await gas.finish(running)
})

test('with no headline the spinner reads Agent Services and the operation’s name', async ($, on) => {
  const gas = world(on, { decision: 'allow' })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  expect((await (await spinner($)).find({ type: 'Text' }))?.text).toContain('Agent Services · FindPages')
  await gas.finish(running)
})

test('a call that asks is left to the engine’s own word: no spinner text is claimed for a dialog', async ($, on) => {
  const gas = world(on, { decision: 'ask', headline: 'Find the wiki pages on query plans.' })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  const text = (await (await spinner($)).find({ type: 'Text' }))?.text ?? ''
  expect(text).toContain('Sauteing')
  expect(text).not.toContain('Find the wiki pages')
  await gas.finish(running)
})

test('the other spinner modes, and a word the engine already overrides, are left alone', async ($, on) => {
  const gas = world(on, { decision: 'allow', headline: 'Find the wiki pages on query plans.' })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  expect((await (await spinner($, { mode: 'thinking' })).find({ type: 'Text' }))?.text).toContain('Sauteing')
  expect((await (await spinner($, { message: 'Compacting conversation' })).find({ type: 'Text' }))?.text).toContain('Compacting conversation')
  await gas.finish(running)
})

test('when the call ends the spinner goes back to the engine’s word', async ($, on) => {
  const gas = world(on, { decision: 'allow', headline: 'Find the wiki pages on query plans.' })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  await gas.finish(running)
  await settle(gas.clock)
  const text = (await (await spinner($)).find({ type: 'Text' }))?.text ?? ''
  expect(text).toContain('Sauteing')
  expect(text).not.toContain('Find the wiki pages')
})

test('a headline is drawn escaped', async ($, on) => {
  const gas = world(on, { decision: 'allow', headline: 'Read \x1b[2J the pages' })
  await start($)
  const running = await gas.begin($)
  await settle(gas.clock)
  const text = (await (await spinner($)).find({ type: 'Text' }))?.text ?? ''
  expect(text).toContain('Read')
  expect(text).not.toContain('\x1b')
  await gas.finish(running)
})

test('a permission check that lands after the call has ended leaves no spinner text behind', async ($, on) => {
  const gas = world(on, { decision: 'allow', headline: 'Find the wiki pages on query plans.' })
  await start($)
  const running = await gas.begin($)
  await gas.finish(running)
  await settle(gas.clock)
  // Asked again, as a repeated or late check would be.
  await gas.checkAgain($)
  await settle(gas.clock)
  const text = (await (await spinner($)).find({ type: 'Text' }))?.text ?? ''
  expect(text).toContain('Sauteing')
  expect(text).not.toContain('Find the wiki pages')
})
