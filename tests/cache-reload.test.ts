import { observeCache, untilCache } from './cache-observer.ts'
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { normalize } from '../src/normalize.ts'
import { buildIR } from '../src/build.ts'
import { EMPTY_DETAILS, overviewOf } from '../src/call-cache.ts'
import type { CallDetailIndex, CallDetailSlot, InspectedCall, StoredInspectorCalls } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 50 }, view: {} }
const operation = 'query Reloaded($key: String!) { jira_searchIssues(jql: $key) { issues { key } } }'
const variables = '{"key":"RELOAD-1"}'
const model: InspectedCall = {
  id: 'previous-instance', server: SERVER, operation, variables, status: 'ran', owner: 'retired-instance', arrivedAt: 0,
  ir: { ...buildIR('previous-instance', normalize(operation, JSON.parse(variables))), state: 'partial', summary: { headline: 'Reads the retained issue' } },
  outcome: { rows: [{ field: 'issues', root: 'jira_searchIssues', count: 1 }], errors: [], authLinks: [], hasData: true, preview: [{ field: 'issues', root: 'jira_searchIssues', items: [{ label: 'RELOAD-1', text: 'Retained result' }], more: 0 }] },
}
const json = JSON.stringify(model)
const index: CallDetailIndex = { ...EMPTY_DETAILS, epoch: 'previous-session-epoch', entries: [{ id: model.id, slot: 0, bytes: new TextEncoder().encode(json).length }] }
const slot: CallDetailSlot = { epoch: index.epoch, writer: '', id: model.id, json }
const calls: StoredInspectorCalls = { version: 2, queue: [], last: overviewOf(model), history: [overviewOf(model)] }

/** Seed what another module wrote, before this module has observed any tool call. */
function previousHost(on: On, overrides: { slot?: CallDetailSlot; index?: CallDetailIndex } = {}) {
  const seeded: Record<string, unknown> = { calls, callDetailIndex: overrides.index ?? index, 'callDetails:0': overrides.slot ?? slot, paneUi: { field: null, arg: null, selection: { kind: 'call', id: model.id } } }
  on('state.get', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const result = await next(e)
    const value = seeded[e.key + (e.id === undefined ? '' : `:${e.id}`)]
    return result.value?.value === undefined && value !== undefined ? { value: { value, version: 0 } } as typeof result : result
  })
}

for (const start of [false, true]) {
  test(`fresh module reads prior host details in main and raw panes${start ? ' after session.start on reload' : ' without session.start'}`, async ($, on) => {
    const clock = mock.clock(on)
    previousHost(on)
    on('tool.list', () => ({ value: [] }))
    on('session.start', () => ({ cwd: '/tmp' }))
    on('ui.status', () => ({ value: undefined }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    let external = 0
    on('mcp.call', () => { external += 1; throw new Error('No external recovery checks') })
    on('model.complete', () => { external += 1; throw new Error('No model recovery request') })
    if (start) await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const main = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
    const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
    expect({ mainRoot: await main.find({ text: /jira_searchIssues/ }) !== undefined, result: await main.find({ text: /Retained result/ }) !== undefined, rawQuery: await raw.find({ type: 'Code', text: /query Reloaded/ }) !== undefined, rawKey: await raw.find({ type: 'Code', text: /RELOAD-1/ }) !== undefined }).toEqual({ mainRoot: true, result: true, rawQuery: true, rawKey: true })
    expect(external).toBe(0)
  })
}

test('a stale detail slot from a cleared epoch never reconstitutes a full model', async ($, on) => {
  const clock = mock.clock(on)
  previousHost(on, { slot: { ...slot, epoch: 'ended-session-epoch' } })
  const main = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await main.find({ text: /keeps its overview/ })).toBeDefined()
  expect(await main.find({ text: /Retained result/ })).toBeUndefined()
  expect(await raw.find({ type: 'Code' })).toBeUndefined()
})

test('a detail write held across session teardown cannot resurrect its model or catalog', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  let reached!: () => void; let release!: () => void
  const arrived = new Promise<void>(resolve => reached = resolve)
  const held = new Promise<void>(resolve => release = resolve)
  let first = true
  const savedSlots = new Map<string, CallDetailSlot | null>()
  let savedIndex: CallDetailIndex | undefined
  on('state.set', { key: 'callDetails' }, async (_, e, next) => {
    if (first && e.value !== null && e.value.json !== null) { first = false; reached(); await held }
    const result = await next(e)
    if (result.value?.isSet) savedSlots.set(e.id, e.value)
    return result
  })
  on('state.set', { key: 'callDetailIndex' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) savedIndex = e.value
    return result
  })
  const tool = $.tool.call({ tool: EXECUTE, operation, variables })
  await untilCache(clock, () => !first)
  await arrived
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
  // Teardown forwards while the retired writer still owns its held payload.
  release()
  await tool
  await untilCache(clock, () => savedIndex?.entries.length === 0 && [...savedSlots.values()].every(value => value?.json === null))
  expect(savedSlots.size).toBe(128)
  expect(savedIndex?.entries).toHaveLength(0)
  expect([...savedSlots.values()].every(value => value?.json === null)).toBe(true)
})

test('overlapping arrivals preserve both full models beyond the second dispatch snapshot', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  let reached!: () => void; let release!: () => void; let captured!: () => void
  const stalled = new Promise<void>(resolve => reached = resolve)
  const held = new Promise<void>(resolve => release = resolve)
  const snapshot = new Promise<void>(resolve => captured = resolve)
  let blocking = false; let once = true
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    if (once && [...e.value.queue, ...e.value.history].some(call => call.overview.operationName === 'FirstOverlap')) {
      once = false; blocking = true; reached(); await held; blocking = false
    }
    return next(e)
  })
  on('state.get', { key: 'calls' }, async (_, e, next) => {
    const result = await next(e)
    if (blocking) captured()
    return result
  })
  const first = $.tool.call({ tool: EXECUTE, operation: 'query FirstOverlap { jira_issue(key: "FIRST-1") { key } }' })
  await untilCache(clock, () => blocking)
  await stalled
  const second = $.tool.call({ tool: EXECUTE, operation: 'query SecondOverlap { confluence_search(cql: "SECOND-CQL") { totalSize } }' })
  const pendingPane = $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  await untilCache(clock, () => blocking)
  await snapshot
  const newest = await pendingPane
  release()
  await Promise.all([first, second])
  await untilCache(clock, () => observed.settled('FirstOverlap') && observed.settled('SecondOverlap'))
  expect(await newest.find({ type: 'Code', text: /SecondOverlap/ })).toBeDefined()
  expect(await newest.find({ type: 'Code', text: /SECOND-CQL/ })).toBeDefined()
  await $.command.run({ command: 'gas', args: 'older', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const older = newest
  expect(await older.find({ type: 'Code', text: /FirstOverlap/ })).toBeDefined()
  expect(await older.find({ type: 'Code', text: /FIRST-1/ })).toBeDefined()
})

test('a repeated same-module session.start interrupts its retired pending generation and preserves details', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  let reached!: () => void; let release!: () => void
  const arrived = new Promise<void>(resolve => reached = resolve)
  const held = new Promise<void>(resolve => release = resolve)
  let saved: StoredInspectorCalls | undefined
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) saved = e.value
    return result
  })
  on('tool.call', { tool: EXECUTE }, async () => { reached(); await held; return { result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const running = $.tool.call({ tool: EXECUTE, operation, variables })
  await arrived
  await untilCache(clock, () => observed.calls?.queue.length === 1 && observed.models.some(call => call.status === 'pending'))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await untilCache(clock, () => saved?.history[0]?.status === 'interrupted' && observed.models.some(call => call.status === 'interrupted'))
  expect(saved?.queue).toHaveLength(0)
  expect(saved?.history[0]?.status).toBe('interrupted')
  release()
  await running
  await clock.advance(300)
  expect(saved?.queue).toHaveLength(0)
  expect(saved?.history[0]?.status).toBe('interrupted')
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await raw.find({ type: 'Code', text: /query Reloaded/ })).toBeDefined()
})

test('the host accepts a nearly two-MiB serialized entry with heavy JSON escaping', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } }))
  let actualBytes = 0; let hostCharacters = 0
  on('state.set', { key: 'callDetails' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet && e.value?.json !== null && e.value !== null) {
      actualBytes = Math.max(actualBytes, new TextEncoder().encode(e.value.json).length)
      hostCharacters = Math.max(hostCharacters, JSON.stringify(e.value).length)
    }
    return result
  })
  await $.tool.call({ tool: EXECUTE, operation, variables: JSON.stringify({ key: 'RELOAD-1', padding: '\\'.repeat(510_000) }) })
  await untilCache(clock, () => actualBytes > 2_000_000)
  expect(actualBytes > 2_000_000).toBe(true)
  expect(actualBytes <= 2 * 1024 * 1024).toBe(true)
  expect(hostCharacters < 4 * 1024 * 1024).toBe(true)
})

for (const refuseClear of [false, true]) {
  test(`host detail bytes stay within budget during multi-entry eviction${refuseClear ? ' when an old slot refuses to clear' : ''}`, async ($, on) => {
    const clock = mock.clock(on)
    on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
    let executed = 0
    on('tool.call', { tool: EXECUTE }, () => { executed += 1; return { result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } } })
    const retained = Array.from({ length: 15 }, (_, i): InspectedCall => ({ ...model, id: `old-${i}`, ir: { ...model.ir, toolCallId: `old-${i}` }, variables: 'x'.repeat(1_099_000) }))
    const slots = new Map<string, CallDetailSlot | null>(retained.map((call, i) => [String(i), { epoch: 'pressure-epoch', writer: '', id: call.id, json: JSON.stringify(call) }]))
    const catalog: CallDetailIndex = { ...EMPTY_DETAILS, epoch: 'pressure-epoch', entries: retained.map((call, i) => ({ id: call.id, slot: i, bytes: new TextEncoder().encode(slots.get(String(i))!.json!).length })) }
    const overviews = retained.map(call => overviewOf(call))
    const overviewState: StoredInspectorCalls = { version: 2, queue: [], last: overviews[0]!, history: overviews }
    const seeded: Record<string, unknown> = { calls: overviewState, callDetailIndex: catalog }
    on('state.get', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
      const result = await next(e)
      const value = e.key === 'callDetails' ? slots.get(e.id) : seeded[e.key]
      return result.value?.value === undefined && value !== undefined ? { value: { value, version: 0 } } as typeof result : result
    })
    let bytes = catalog.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    let peak = bytes
    const weights = new Map(catalog.entries.map(entry => [String(entry.slot), entry.bytes]))
    let refused = 0
    on('state.set', { key: 'callDetails' }, async (_, e, next) => {
      if (refuseClear && e.id === '1' && e.value?.json === null && slots.get('1')?.json !== null) {
        refused += 1
        return { deny: 'clear unavailable' }
      }
      const result = await next(e)
      if (result.value?.isSet) {
        slots.set(e.id, e.value)
        const weight = e.value?.json == null ? 0 : new TextEncoder().encode(e.value.json).length
        bytes += weight - (weights.get(e.id) ?? 0)
        weights.set(e.id, weight)
        peak = Math.max(peak, bytes)
        expect(bytes <= 16 * 1024 * 1024).toBe(true)
      }
      return result
    })
    await $.tool.call({ tool: EXECUTE, operation, variables: JSON.stringify({ key: 'NEW-1', padding: 'y'.repeat(2_000_000) }) })
    await untilCache(clock, () => refuseClear ? refused > 0 : [...slots.values()].some(slot => slot?.json?.includes('NEW-1')) === true)
    expect(executed).toBe(1)
    expect(peak <= 16 * 1024 * 1024).toBe(true)
    if (refuseClear) expect(refused > 0).toBe(true)
    else expect([...slots.values()].some(slot => slot?.json?.includes('NEW-1'))).toBe(true)
  })
}


test('an immediate new session clears details whose ended-session cleanup was superseded', async ($, on) => {
  const clock = mock.clock(on)
  previousHost(on)
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const cleared = new Set<string>()
  let newEpoch = ''
  on('state.set', { key: 'callDetails' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet && e.value?.json === null) cleared.add(e.id)
    return result
  })
  on('state.set', { key: 'callDetailIndex' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet && e.value.epoch !== index.epoch) newEpoch = e.value.epoch
    return result
  })
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as Parameters<typeof $.session.end>[0])
  // No observer timer runs between these lifecycle calls.
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await untilCache(clock, () => newEpoch !== '' && cleared.size === 128)
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await raw.find({ text: /unavailable/ })).toBeDefined()
  expect(await raw.find({ type: 'Code' })).toBeUndefined()
})
