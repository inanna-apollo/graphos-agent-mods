import { untilCache } from './cache-observer.ts'
import { expect, mock, test } from 'claude-code/testing'
import { normalize } from '../src/normalize.ts'
import { buildIR } from '../src/build.ts'
import { overviewOf } from '../src/call-cache.ts'
import type { CallDetailIndex, CallDetailSlot, InspectedCall, StoredInspectorCalls } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const replacementWriter = 'replacement-module'
const replacement: InspectedCall = {
  id: 'replacement-call', server: SERVER, status: 'ran', owner: replacementWriter, arrivedAt: 1,
  operation: 'query Replacement { jira_issue(key: "RELOAD-1") { key } }', variables: '',
  ir: { ...buildIR('replacement-call', normalize('query Replacement { jira_issue(key: "RELOAD-1") { key } }', {})), state: 'ready' },
}

for (const heldTarget of ['calls', 'catalog', 'slot'] as const) {
  test(`a retired writer cannot replace a newer claim after its ${heldTarget} CAS conflicts`, async ($, on) => {
    const clock = mock.clock(on)
    on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
    let executions = 0
    on('tool.call', { tool: EXECUTE }, () => {
      executions += 1
      return { result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } }
    })
    let reached!: () => void; let release!: () => void
    const stalled = new Promise<void>(resolve => reached = resolve)
    const held = new Promise<void>(resolve => release = resolve)
    let intercept = true
    let conflicted = false
    let savedCalls: StoredInspectorCalls | undefined
    let savedIndex: CallDetailIndex | undefined
    let newerCalls!: StoredInspectorCalls
    let newerIndex!: CallDetailIndex
    let newerSlot!: CallDetailSlot
    const savedSlots = new Map<string, CallDetailSlot | null>()
    on('state.set', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
      const isTarget = heldTarget === 'calls' ? e.key === 'calls' && [...e.value.queue, ...e.value.history].some(call => call.overview.operationName === 'Retired')
        : heldTarget === 'catalog' ? e.key === 'callDetailIndex' && e.value.entries.length > 0
          : e.key === 'callDetails' && e.value?.json !== null && e.value?.json !== undefined
      const isHeld = intercept && isTarget
      if (isHeld) {
        intercept = false
        reached()
        await held
        // Claim this exact CAS target through the real host; middleware may
        // replace its value, but cannot change the state reference it handles.
        if (e.key === 'calls') {
          expect((await next({ ...e, value: newerCalls })).value?.isSet).toBe(true)
          savedCalls = newerCalls
        } else if (e.key === 'callDetailIndex') {
          expect((await next({ ...e, value: newerIndex })).value?.isSet).toBe(true)
          savedIndex = newerIndex
        } else if (e.key === 'callDetails') {
          expect((await next({ ...e, value: newerSlot })).value?.isSet).toBe(true)
          savedSlots.set(e.id, newerSlot)
        }
      }
      const answer = await next(e)
      if (isHeld) conflicted = answer.value?.isSet === false
      if (answer.value?.isSet) {
        if (e.key === 'calls') savedCalls = e.value
        if (e.key === 'callDetailIndex') savedIndex = e.value
        if (e.key === 'callDetails') savedSlots.set(e.id, e.value)
      }
      return answer
    })
    const original = $.tool.call({ tool: EXECUTE, operation: 'query Retired { jira_issue(key: "OLD-1") { key } }' })
    await untilCache(clock, () => !intercept)
    await stalled
    expect(savedIndex).toBeDefined()
    expect(savedIndex?.epoch).not.toBe('')
    const epoch = savedIndex!.epoch
    const json = JSON.stringify(replacement)
    const overview = overviewOf(replacement)
    newerCalls = { version: 2, writer: replacementWriter, queue: [], last: overview, history: [overview] }
    newerIndex = {
      version: 1, epoch, writer: replacementWriter, active: null,
      entries: [{ id: replacement.id, slot: 0, bytes: new TextEncoder().encode(json).length }],
    }
    newerSlot = { epoch, writer: replacementWriter, id: replacement.id, json }
    // A reload transfers ownership without rotating the retained data epoch.
    // Real host writes move each CAS version while the retired write is held.
    release()
    await original
    await untilCache(clock, () => conflicted)
    expect(conflicted).toBe(true)
    expect(executions).toBe(1)
    await untilCache(clock, () => heldTarget === 'calls' ? savedCalls?.writer === replacementWriter : heldTarget === 'catalog' ? savedIndex?.writer === replacementWriter : savedSlots.get('0')?.writer === replacementWriter)
    if (heldTarget === 'calls') expect(savedCalls).toEqual(newerCalls)
    if (heldTarget === 'catalog') expect(savedIndex).toEqual(newerIndex)
    if (heldTarget === 'slot') expect(savedSlots.get('0')).toEqual(newerSlot)
  })
}
