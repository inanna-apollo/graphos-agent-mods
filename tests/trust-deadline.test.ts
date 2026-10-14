import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const INPUT = { operation: 'query Read { jira_read }', variables: {} }
const RULES = 'query Allowed { jira_read }'
const RULES_FILE = '/home/me/.claude/graphos-agent-mods/trust.graphql'
const ORIGINAL = { decision: 'ask' as const, reason: 'original engine permission' }
const pause = () => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, 5))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => release = resolve)
  return { promise, release }
}
async function observed(isDone: () => boolean) {
  for (let tries = 0; tries < 200 && !isDone(); tries++) await pause()
  expect(isDone()).toBe(true)
}
type Stages = { discovery?: () => Promise<void>; home?: () => Promise<void>; file?: () => Promise<void>; permission?: () => Promise<void> }
function world(on: On, stages: Stages = {}) {
  on('tool.check', async () => { await stages.permission?.(); return ORIGINAL })
  on('tool.list', async () => { await stages.discovery?.(); return { value: ['execute', 'search', 'validate', 'dry_run', 'introspect'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) } })
  on('process.run', async () => { await stages.home?.(); return { value: { exitCode: 0, stdout: '/home/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('fs.read', async (_, e) => {
    if (e.path === RULES_FILE) { await stages.file?.(); return { value: RULES } }
    throw new Error('ENOENT')
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
}
function check($: Engine, id = 'deadline-call') { return $.tool.check({ tool: EXECUTE, input: INPUT, tool_use_id: id }) }
function caller(on: On) {
  const held = deferred()
  let id: string | undefined
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    id = e.tool_use_id
    await held.promise
    return { result: { content: [{ type: 'text' as const, text: '{"data":{"jira_read":"ok"}}' }], isError: false } }
  })
  return { id: () => id, release: held.release, run: ($: Engine) => $.tool.call({ tool: EXECUTE, ...INPUT }) }
}
async function deadline(clock: MockClock, pending: Promise<unknown>) {
  let done = false
  let answer: unknown
  void pending.then(value => { done = true; answer = value })
  await clock.advance(999)
  await pause()
  expect(done).toBe(false)
  await clock.advance(1)
  await observed(() => done)
  return answer
}

for (const stage of ['discovery', 'home directory', 'trust file', 'trust toggle'] as const) {
  test(`trust preserves the original verdict after one second stalled in ${stage}, including a late answer`, async ($, on) => {
    const clock = mock.clock(on)
    const held = deferred()
    let reached = false
    const stall = async () => { reached = true; await held.promise }
    world(on, { ...(stage === 'discovery' && { discovery: stall }), ...(stage === 'home directory' && { home: stall }), ...(stage === 'trust file' && { file: stall }) })
    if (stage === 'trust toggle') on('state.get', { plugin: 'graphos-agent-mods', key: 'isTrustOff' }, async (_, e, next) => { reached = true; await held.promise; return next(e) })
    const called = caller(on)
    let recorded = false
    let allowedSpinner = false
    let allowedEvidence = false
    on('state.set', { plugin: 'graphos-agent-mods' }, (_, e, next) => {
      if (e.key === 'spinner' && e.value.id === called.id()) allowedSpinner = true
      if (e.key === 'callDetails' && e.value?.id === called.id()) recorded = true
      if (e.key === 'callDetails' && e.value?.json?.includes('"isAllowed":true')) allowedEvidence = true
      return next(e)
    })
    const running = called.run($)
    await observed(() => called.id() !== undefined)
    const pending = check($, called.id())
    await observed(() => reached)
    expect(await deadline(clock, pending)).toEqual(ORIGINAL)
    held.release()
    // Let the loser finish; it must have no path to publish an allowed fit.
    await observed(() => recorded)
    for (let tries = 0; tries < 20; tries++) await pause()
    expect(allowedSpinner).toBe(false)
    expect(allowedEvidence).toBe(false)
    called.release()
    await running
    await clock.advance(1)
  })
}

test('the one-second budget covers all trust stages together', async ($, on) => {
  const clock = mock.clock(on)
  let discovery = false
  let file = false
  const discoveryHold = deferred()
  const fileHold = deferred()
  world(on, { discovery: async () => { discovery = true; await discoveryHold.promise }, file: async () => { file = true; await fileHold.promise } })
  let done = false
  const pending = check($).then(value => { done = true; return value })
  await observed(() => discovery)
  await clock.advance(600)
  discoveryHold.release()
  await observed(() => file)
  await clock.advance(399)
  expect(done).toBe(false)
  await clock.advance(1)
  await observed(() => done)
  expect(await pending).toEqual(ORIGINAL)
  fileHold.release()
})

test('a trust match returns allow without awaiting evidence storage', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  const held = deferred()
  const called = caller(on)
  let readEvidence = false
  let recorded = false
  on('state.get', { plugin: 'graphos-agent-mods', key: 'calls' }, async (_, e, next) => { readEvidence = true; await held.promise; return next(e) })
  on('state.set', { plugin: 'graphos-agent-mods', key: 'callDetails' }, (_, e, next) => {
    if (e.value?.id === called.id() && e.value?.json?.includes('"isAllowed":true')) recorded = true
    return next(e)
  })
  const running = called.run($)
  await observed(() => called.id() !== undefined)
  let answer: Awaited<ReturnType<typeof check>> | undefined
  void check($, called.id()).then(value => answer = value)
  await observed(() => answer !== undefined)
  expect(answer?.decision).toBe('allow')
  expect(answer?.reason).toContain('Allowed')
  await clock.advance(1)
  await observed(() => readEvidence)
  expect(recorded).toBe(false)
  await clock.advance(1_000)
  held.release()
  await observed(() => recorded)
  called.release()
  await running
  await clock.advance(1)
})

test('engine permission work runs outside the Inspector deadline', async ($, on) => {
  const clock = mock.clock(on)
  const held = deferred()
  let reached = false
  world(on, { permission: async () => { reached = true; await held.promise } })
  let answer: Awaited<ReturnType<typeof check>> | undefined
  void check($).then(value => answer = value)
  await observed(() => reached)
  await clock.advance(5_000)
  expect(answer).toBeUndefined()
  held.release()
  await observed(() => answer !== undefined)
  expect(answer?.decision).toBe('allow')
})

test('a generation change discards an in-flight trust match', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  const held = deferred()
  let reached = false
  on('state.get', { plugin: 'graphos-agent-mods', key: 'isTrustOff' }, async (_, e, next) => { reached = true; await held.promise; return next(e) })
  const pending = check($)
  await observed(() => reached)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<Engine['session']['end']>[0])
  // Session teardown cancels waiting immediately, without waiting for this
  // stage or spending the remaining deadline.
  let answer: unknown
  void pending.then(value => answer = value)
  await observed(() => answer !== undefined)
  expect(answer).toEqual(ORIGINAL)
  held.release()
  await clock.advance(1_000)
})


test('lookup permission returns while optional dialog discovery is stalled', async ($, on) => {
  const clock = mock.clock(on)
  const held = deferred()
  let discovering = false
  world(on, { discovery: async () => { discovering = true; await held.promise } })
  let answer: unknown
  void $.tool.check({ tool: `mcp__${SERVER}__search`, input: {}, tool_use_id: 'lookup-dialog' }).then(value => answer = value)
  await observed(() => discovering)
  await observed(() => answer !== undefined)
  expect(answer).toEqual(ORIGINAL)
  held.release()
  await clock.advance(1_000)
})

test('failed discovery preserves the engine permission verdict', async ($, on) => {
  mock.clock(on)
  world(on, { discovery: async () => { throw new Error('discovery unavailable') } })
  expect(await check($)).toEqual(ORIGINAL)
})
