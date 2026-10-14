import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { buildIR } from '../src/build.ts'
import { normalize } from '../src/normalize.ts'
import { EMPTY_DETAILS } from '../src/call-cache.ts'
import { untilCache } from './cache-observer.ts'
import type { CallDetailIndex, CallDetailSlot, InspectedCall, StoredInspectorCalls } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 50 }, view: {} }
const operation = 'query SavedLegacy($key: String!) { jira_issue(key: $key) { key fields } }'
const variables = '{"key":"LEGACY-1"}'
const saved: InspectedCall = {
  id: 'saved-legacy', server: SERVER, operation, variables, status: 'ran', owner: 'previous-plugin', arrivedAt: 23,
  ir: { ...buildIR('saved-legacy', normalize(operation, JSON.parse(variables))), state: 'partial', summary: { headline: 'Reads the saved legacy issue' } },
  outcome: { rows: [{ field: 'jira_issue', root: 'jira_issue', count: 1 }], errors: [], authLinks: [], hasData: true,
    preview: [{ field: 'jira_issue', root: 'jira_issue', items: [{ label: 'LEGACY-1', text: 'Authentic saved response' }], more: 0 }] },
}

function legacyHost(on: On, model = saved, catalog?: CallDetailIndex, slot?: CallDetailSlot) {
  const clock = mock.clock(on)
  const seeded: Record<string, unknown> = { calls: { queue: [], last: model, history: [model] }, paneUi: { selection: { kind: 'call', id: model.id } }, ...(catalog !== undefined && { callDetailIndex: catalog }), ...(slot !== undefined && { 'callDetails:0': slot }) }
  on('state.get', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const result = await next(e)
    const value = seeded[e.key + (e.id === undefined ? '' : `:${e.id}`)]
    return result.value?.value === undefined && value !== undefined ? { value: { value, version: 0 } } as typeof result : result
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  let external = 0
  on('mcp.call', () => { external += 1; throw new Error('Legacy migration uses saved state only') })
  on('model.complete', () => { external += 1; throw new Error('Legacy migration uses saved state only') })
  let calls: StoredInspectorCalls | undefined
  let index: CallDetailIndex | undefined
  const slots = new Map<string, CallDetailSlot | null>()
  on('state.set', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) {
      if (e.key === 'calls') calls = e.value
      if (e.key === 'callDetailIndex') index = e.value
      if (e.key === 'callDetails') slots.set(e.id, e.value)
    }
    return result
  })
  return { clock, get calls() { return calls }, get index() { return index }, slots, get external() { return external } }
}

test('a new writer imports actual legacy query, variables, and saved response without external recovery', async ($, on) => {
  const host = legacyHost(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await untilCache(host.clock, () => host.calls?.history[0]?.details === 'available' && [...host.slots.values()].some(slot => slot?.id === saved.id && slot.json === JSON.stringify(saved)))
  const main = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await main.find({ text: /Authentic saved response/ })).toBeDefined()
  expect(await raw.find({ type: 'Code', text: /query SavedLegacy/ })).toBeDefined()
  expect(await raw.find({ type: 'Code', text: /LEGACY-1/ })).toBeDefined()
  expect(host.external).toBe(0)
})

test('legacy full objects do not replace an existing modern detail catalog', async ($, on) => {
  const modernOperation = operation.replace('SavedLegacy', 'ModernCatalog')
  const modernVariables = '{"key":"MODERN-1"}'
  const modern: InspectedCall = { ...saved, operation: modernOperation, variables: modernVariables, ir: { ...buildIR(saved.id, normalize(modernOperation, JSON.parse(modernVariables))), state: 'partial' } }
  const json = JSON.stringify(modern)
  const catalog: CallDetailIndex = { ...EMPTY_DETAILS, epoch: 'modern-epoch', entries: [{ id: modern.id, slot: 0, bytes: new TextEncoder().encode(json).length }] }
  const host = legacyHost(on, saved, catalog, { epoch: catalog.epoch, writer: '', id: modern.id, json })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await untilCache(host.clock, () => host.slots.size === 128)
  expect(host.index?.epoch).toBe(catalog.epoch)
  expect(host.slots.get('0')?.json).toBe(json)
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await raw.find({ type: 'Code', text: /ModernCatalog/ })).toBeDefined()
  expect(await raw.find({ type: 'Code', text: /MODERN-1/ })).toBeDefined()
  expect(host.external).toBe(0)
})

for (const unavailable of ['ended epoch', 'invalid catalog', 'oversize legacy'] as const) {
  test(`legacy details remain unavailable for ${unavailable}`, async ($, on) => {
    const model = unavailable === 'oversize legacy' ? { ...saved, variables: 'x'.repeat(2 * 1024 * 1024) } : saved
    const catalog = unavailable === 'ended epoch' ? { ...EMPTY_DETAILS, epoch: 'ended-session-epoch' } : unavailable === 'invalid catalog' ? { ...EMPTY_DETAILS, epoch: 'ended-session-epoch', entries: [{ id: saved.id, slot: 0, bytes: 0 }] } : undefined
    const stale = catalog === undefined ? undefined : { epoch: catalog.epoch, writer: '', id: saved.id, json: JSON.stringify(saved) }
    const host = legacyHost(on, model, catalog, stale)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await untilCache(host.clock, () => host.slots.size === 128)
    expect(host.index?.entries).toHaveLength(0)
    expect([...host.slots.values()].every(slot => slot?.json === null)).toBe(true)
    const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
    expect(await raw.find({ text: /unavailable/ })).toBeDefined()
    expect(await raw.find({ type: 'Code' })).toBeUndefined()
    expect(host.external).toBe(0)
  })
}

test('a legacy writer-claim CAS retry imports the actual newer saved model', async ($, on) => {
  const host = legacyHost(on)
  const newerOperation = operation.replace('SavedLegacy', 'NewerSaved')
  const newerVariables = '{"key":"NEWER-1"}'
  const newer: InspectedCall = { ...saved, operation: newerOperation, variables: newerVariables, ir: { ...buildIR(saved.id, normalize(newerOperation, JSON.parse(newerVariables))), state: 'partial' } }
  let first = true
  let conflicted = false
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    if (!first) return next(e)
    first = false
    const replaced = await next({ ...e, value: { queue: [], last: newer, history: [newer] } as unknown as StoredInspectorCalls })
    expect(replaced.value?.isSet).toBe(true)
    const original = await next(e)
    conflicted = original.value?.isSet === false
    return original
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await untilCache(host.clock, () => host.calls?.history[0]?.details === 'available' && [...host.slots.values()].some(slot => slot?.id === newer.id && slot.json === JSON.stringify(newer)))
  expect(conflicted).toBe(true)
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await raw.find({ type: 'Code', text: /NewerSaved/ })).toBeDefined()
  expect(await raw.find({ type: 'Code', text: /NEWER-1/ })).toBeDefined()
  expect(host.external).toBe(0)
})
