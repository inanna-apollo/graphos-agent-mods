import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { expect } from 'claude-code/testing'
import type { CallDetailSlot, InspectedCall, StoredInspectorCalls } from '../types'

/** Observe committed models so tests wait for delivery, independently of tool completion. */
export function observeCache(on: On) {
  let calls: StoredInspectorCalls | undefined
  const details = new Map<string, CallDetailSlot | null>()
  on('state.set', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) {
      if (e.key === 'calls') calls = e.value
      if (e.key === 'callDetails') details.set(e.id, e.value)
    }
    return result
  })
  return {
    get calls() { return calls },
    get models(): InspectedCall[] { return [...details.values()].flatMap(slot => slot?.json == null ? [] : [JSON.parse(slot.json) as InspectedCall]) },
    settled(operation: string) {
      return this.models.some(call => call.operation.includes(operation) && call.status !== 'pending' && (call.status !== 'ran' || call.outcome !== undefined))
    },
  }
}

/** Timers advance until an actual host boundary or committed state is observed. */
export async function untilCache(clock: MockClock, condition: () => boolean | Promise<boolean>) {
  for (let step = 0; step < 200; step++) {
    if (await condition()) return
    await clock.advance(10)
  }
  expect(await condition()).toBe(true)
}
