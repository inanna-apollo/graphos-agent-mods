import { expect, mock, test } from 'claude-code/testing'
import { buildIR } from '../src/build.ts'
import { normalize } from '../src/normalize.ts'
import { overviewOf } from '../src/call-cache.ts'
import { untilCache } from './cache-observer.ts'
import type { CallDetailIndex, CallDetailSlot, InspectedCall, StoredInspectorCalls } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const WRITER = 'replacement-module'
const replacement: InspectedCall = {
  id: 'replacement-call', server: SERVER, status: 'pending', owner: WRITER, arrivedAt: 1,
  operation: 'query Replacement { jira_issue(key: "RELOAD-1") { key } }', variables: '',
  ir: { ...buildIR('replacement-call', normalize('query Replacement { jira_issue(key: "RELOAD-1") { key } }', {})), state: 'ready' },
}
const pause = () => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, 5))
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => release = resolve)
  return { promise, release }
}

for (const target of ['catalog', 'slot', 'calls'] as const) {
  test(`retired session cleanup preserves a replacement writer after its ${target} CAS conflicts`, async ($, on) => {
    const clock = mock.clock(on)
    on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const toolHeld = deferred()
    on('tool.call', { tool: EXECUTE }, async () => {
      await toolHeld.promise
      return { result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } }
    })
    let savedCalls: StoredInspectorCalls | undefined
    let savedIndex: CallDetailIndex | undefined
    const savedSlots = new Map<string, CallDetailSlot | null>()
    let ending = false
    let previousEpoch = ''
    let intercepted = false
    let conflicted = false
    const held = deferred()
    let claimed: StoredInspectorCalls | CallDetailIndex | CallDetailSlot | undefined
    on('state.set', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
      const isTarget = target === 'catalog' ? e.key === 'callDetailIndex' && e.value.epoch !== previousEpoch && e.value.entries.length === 0
        : target === 'slot' ? e.key === 'callDetails' && e.id === '0' && e.value?.epoch !== previousEpoch && e.value?.json === null
          : e.key === 'calls' && e.value.queue.length === 0
      const intercept = ending && !intercepted && isTarget
      if (intercept) {
        intercepted = true
        await held.promise
        const json = JSON.stringify(replacement)
        const overview = overviewOf(replacement)
        claimed = e.key === 'calls' ? { version: 2, writer: WRITER, queue: [overview], history: [], last: null }
          : e.key === 'callDetailIndex' ? { version: 1, writer: WRITER, epoch: previousEpoch, active: replacement.id, entries: [{ id: replacement.id, slot: 0, bytes: new TextEncoder().encode(json).length }] }
            : { writer: WRITER, epoch: (e.value as CallDetailSlot).epoch, id: replacement.id, json }
        expect((await next({ ...e, value: claimed } as typeof e)).value?.isSet).toBe(true)
        if (e.key === 'calls') savedCalls = claimed as StoredInspectorCalls
        if (e.key === 'callDetailIndex') savedIndex = claimed as CallDetailIndex
        if (e.key === 'callDetails') savedSlots.set(e.id, claimed as CallDetailSlot)
      }
      const answer = await next(e)
      if (intercept) conflicted = answer.value?.isSet === false
      if (answer.value?.isSet) {
        if (e.key === 'calls') savedCalls = e.value
        if (e.key === 'callDetailIndex') savedIndex = e.value
        if (e.key === 'callDetails') savedSlots.set(e.id, e.value)
      }
      return answer
    })
    const running = $.tool.call({ tool: EXECUTE, operation: 'not a GraphQL operation' })
    await untilCache(clock, () => [...savedSlots.values()].some(slot => slot?.json !== null && slot?.json !== undefined))
    previousEpoch = savedIndex!.epoch
    expect(previousEpoch).not.toBe('')
    ending = true
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
    await untilCache(clock, () => intercepted)
    held.release()
    await untilCache(clock, () => conflicted)
    for (let tries = 0; tries < 20; tries++) await pause()
    if (target === 'catalog') expect(savedIndex).toEqual(claimed)
    if (target === 'slot') expect(savedSlots.get('0')).toEqual(claimed)
    if (target === 'calls') expect(savedCalls).toEqual(claimed)
    toolHeld.release()
    await running
  })
}
