import { expect, mock, test } from 'claude-code/testing'
import type { CallDetailSlot } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
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

test('a verdict hydrated before session teardown cannot republish its retired transcript records', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text', props: {}, children: ['engine result'] }))
  let id = ''
  on('tool.call', { tool: EXECUTE }, (_, e) => {
    id = e.tool_use_id
    return { result: { content: [{ type: 'text' as const, text: '{"errors":[{"message":"retired-result-secret"}]}' }], isError: false } }
  })
  const held = deferred()
  let outcomeWritten = false
  let outcomeReads = 0
  let hydrated = false
  let retired = false
  let retiredVerdictWrites = 0
  let cleared = false
  on('state.set', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const answer = await next(e)
    if (answer.value?.isSet) {
      if (e.key === 'callDetails' && e.value?.id === id && e.value?.json?.includes('"outcome":')) outcomeWritten = true
      if (retired && e.key === 'verdicts') retiredVerdictWrites += 1
      if (retired && e.key === 'callDetailIndex' && e.value.entries.length === 0) cleared = true
    }
    return answer
  })
  on('state.get', { plugin: 'graphos-agent-mods', key: 'callDetails' }, async (_, e, next) => {
    const answer = await next(e)
    const slot = answer.value?.value as CallDetailSlot | undefined
    // The first read returns the completed outcome update; the next hydrates
    // the independent verdict publication. Hold its real host snapshot.
    if (outcomeWritten && slot?.id === id && ++outcomeReads === 2) {
      hydrated = true
      await held.promise
    }
    return answer
  })
  await $.tool.call({ tool: EXECUTE, operation: 'not a GraphQL operation' })
  await clock.advance(1)
  await observed(() => hydrated)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
  retired = true
  held.release()
  await clock.advance(1)
  await observed(() => cleared)
  for (let tries = 0; tries < 20; tries++) await pause()
  expect(retiredVerdictWrites).toBe(0)
  const row = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolResult', requestId: id, props: { tool: EXECUTE, tool_use_id: id, output: {}, isErrored: false } })
  expect(await row.find({ text: /engine result/ })).toBeDefined()
  expect(await row.find({ text: /retired-result-secret/ })).toBeUndefined()
})
