// Trust enforcement survives conversation resets; activity never posts a status footer.

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

for (const source of ['clear', 'resume', 'fork'] as const) {
  test(`trust enforcement resets after ${source} resets the conversation`, async ($, on) => {
    const clock = mock.clock(on)
    const status = world(on, RULES)
    const checked = caller(on)
    let isReset = false
    // Classic events in the harness dispatch hooks only. Model the host's
    // documented atom reset independently of the module's surviving locals.
    on('state.get', (_, e, next) => isReset && e.key === 'isTrustOff' ? { value: { value: undefined, version: 0 } } : next(e))
    on('classic.SessionStart', () => ({}))
    await start($)
    await command($, 'trust off')
    expect((await checked($, clock, FITS)).decision).toBe('ask')
    const reads = status.reads.filter(path => path === RULES_FILE).length
    isReset = true
    await $.classic.SessionStart({ source })
    expect((await checked($, clock, FITS)).decision).toBe('allow')
    expect(status.reads.filter(path => path === RULES_FILE).length).toBe(reads)
  })
}

test('session activity leaves the retired footer cleared', async ($, on) => {
  const clock = mock.clock(on)
  const status = world(on, RULES)
  const checked = caller(on)
  await start($)
  await checked($, clock, FITS)
  await command($, 'trust off')
  await checked($, clock, OUTSIDE)
  expect(status.lines.length).toBeGreaterThan(0)
  expect(status.lines.every(line => line === undefined)).toBe(true)
})
