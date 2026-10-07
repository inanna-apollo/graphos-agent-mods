// The standing line under the prompt through the engine ($.ui.status): what
// it says as calls arrive and settle, as trust rules load and switch, and that
// a session with nothing to report says nothing at all. Behaviour only: the
// text the engine was handed. The wording is covered in test/unit/status.spec.ts.

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

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** Agent Services beneath the plugin, the engine asking for execute, $HOME at /home/me, `rules` as the trust file; records every line the status was given. */
function world(on: On, rules: string | undefined, options: { decision?: 'ask' | 'allow'; isError?: boolean; files?: Record<string, string> } = {}) {
  const lines: (string | undefined)[] = []
  const reads: string[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', (_, e) => ({ decision: e.tool === EXECUTE ? (options.decision ?? 'ask') : ('allow' as const) }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds pages"}', usage: USAGE } }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    if (e.path === RULES_FILE && rules !== undefined) return { value: rules }
    const file = options.files?.[e.path]
    if (file !== undefined) return { value: file }
    throw new Error('ENOENT')
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return { lines, reads, last: () => lines.filter(line => line !== undefined).at(-1) }
}

const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

async function until(clock: MockClock, isDone: () => boolean, ms: number) {
  for (let passed = 0; passed < ms && !isDone(); passed += 100) {
    await clock.advance(100)
    if (!isDone()) await pause(5)
  }
}

/**
 * A call as the model makes one: the tool.call recorded, then its permission
 * check asked under its id while the call waits, as the engine asks before its
 * dialog; the call then returns. Resolves once it has.
 */
function caller(on: On, answer = '{"data":{"confluence_search":{"results":[]}}}') {
  let id: string | undefined
  let release = () => {}
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    id = e.tool_use_id
    await new Promise<void>(resolve => (release = resolve))
    return { result: { content: [{ type: 'text' as const, text: answer }], isError: false } }
  })
  return async ($: Engine, clock: MockClock, input: { operation: string; variables: Record<string, unknown> }) => {
    id = undefined
    const running = $.tool.call({ tool: EXECUTE, ...input })
    await until(clock, () => id !== undefined, 2_000)
    const verdict = await $.tool.check({ tool: EXECUTE, input, tool_use_id: id })
    release()
    await running
    return verdict
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) => $.command.run({ command: 'gas', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

test('a session with no Agent Services call and no trust rules says nothing at all', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, undefined)
  await start($)
  await until(clock, () => false, 500)
  expect(status.lines).toEqual([])
})

test('trust rules loaded at the start show as a count', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, RULES)
  await start($)
  await until(clock, () => status.last() !== undefined, 2_000)
  expect(status.last()).toMatch(/1 trust rule\b/)
})

test('calls are counted as they arrive, and a call that fit a rule is counted as having run unasked, one that asked is not', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, RULES)
  const checked = caller(on)
  await start($)

  expect((await checked($, clock, OUTSIDE)).decision).toBe('ask')
  await until(clock, () => /1 call\b/.test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(/1 call\b/)
  expect(status.last()).not.toMatch(/unasked/)

  expect((await checked($, clock, FITS)).decision).toBe('allow')
  await until(clock, () => /2 calls/.test(status.last() ?? '') && /unasked/.test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(/2 calls/)
  expect(status.last()).toMatch(/1 ran unasked/)
  expect(status.last()).toMatch(/1 trust rule\b/)
})

test('the engine’s own allow is not a trust rule: such a call is counted, and never as ran unasked', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, RULES, { decision: 'allow' })
  const checked = caller(on)
  await start($)
  await checked($, clock, FITS)
  await until(clock, () => /1 call\b/.test(status.last() ?? ''), 2_000)
  await until(clock, () => false, 500)
  expect(status.last()).toMatch(/1 call\b/)
  expect(status.last()).not.toMatch(/unasked/)
})

test('/gas trust off says so in the line, and /gas trust on takes it back', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, RULES)
  await start($)
  await until(clock, () => status.last() !== undefined, 2_000)
  await command($, 'trust off')
  await until(clock, () => /trust off/.test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(/trust off/)
  await command($, 'trust on')
  await until(clock, () => /1 trust rule\b/.test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(/1 trust rule\b/)
})

test('trust turned off during a call is in the line when the call settles, though the call began before', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, RULES)
  const checked = caller(on)
  await start($)
  await until(clock, () => status.last() !== undefined, 2_000)
  await command($, 'trust off')
  await until(clock, () => /trust off/.test(status.last() ?? ''), 2_000)
  await checked($, clock, OUTSIDE)
  await until(clock, () => /1 call\b/.test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(/1 call\b/)
  expect(status.last()).toMatch(/trust off/)
})

test('the line adds up the bytes of the responses Claude read, each call once', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, undefined)
  const checked = caller(on)
  await start($)
  await checked($, clock, OUTSIDE)
  await until(clock, () => /\d+ B read/.test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(/1 call\b.*\d+ B read/)
  const once = Number(/(\d+) B read/.exec(status.last() ?? '')?.[1])
  await checked($, clock, OUTSIDE)
  await until(clock, () => /2 calls/.test(status.last() ?? '') && new RegExp(`${once * 2} B read`).test(status.last() ?? ''), 2_000)
  expect(status.last()).toMatch(new RegExp(`2 calls.*${once * 2} B read`))
})

test('a response Claude Code kept out of the context was not read: the file the mod read back is not counted', async ($, on) => {
  const clock = mock.clock(on)
  const saved = '/home/me/.claude/projects/-p/abc/tool-results/toolu_big.json'
  const response = { data: { confluence_search: { results: Array.from({ length: 30 }, () => ({ title: 't'.repeat(900) })) } } }
  const status = world(on, undefined, { files: { [saved]: JSON.stringify([{ type: 'text', text: JSON.stringify(response) }], null, 2) } })
  const checked = caller(on, `<persisted-output>\nOutput too large (28.1KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n...\n</persisted-output>`)
  await start($)
  await checked($, clock, OUTSIDE)
  await until(clock, () => status.reads.includes(saved), 2_000)
  // The file was read back (the pane shows its rows), and the line counts the call and no bytes.
  expect(status.reads).toContain(saved)
  await until(clock, () => false, 500)
  expect(status.last()).toMatch(/1 call\b/)
  expect(status.last()).not.toMatch(/ read/)
})
