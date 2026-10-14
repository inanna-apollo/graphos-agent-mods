import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { CallCache, CALL_CACHE_BYTES, CALL_CACHE_ENTRIES, CALL_ENTRY_BYTES, CALL_OVERVIEW_BYTES, EMPTY_DETAILS, EMPTY_STORED, detailIndexFor, normalizeDetailIndex, fullCalls, normalizeSelection, normalizeStoredCalls, overviewOf, resolveCalls, settleStoredCalls, storeCalls } from '../../src/call-cache.ts'
import { EMPTY, arrive, settle, shownResolvedAt, selectionOlder, selectionNewer } from '../../src/queue.ts'
import type { InspectedCall, SelectedCall } from '../../types/index.d.ts'

const live: SelectedCall = { kind: 'live' }
const call = (id: string, operation = '{ x }'): InspectedCall => ({ id, server: 'gas', operation, variables: '', status: 'pending', arrivedAt: 0, owner: 'session', ir: { toolCallId: id, state: 'ready', roots: [] } })

test('the cache owns serialized copies, measures UTF-8, and rejects the whole oversize detail entry', () => {
  const cache = new CallCache()
  const one = call('one', '🙂'.repeat(1_000))
  assert.equal(cache.put(one), 'available')
  assert.equal(cache.bytes, Buffer.byteLength(JSON.stringify(one)))
  one.operation = 'mutated'
  const got = cache.get('one')!
  assert.notEqual(got.operation, 'mutated')
  got.operation = 'second mutation'
  assert.notEqual(cache.get('one')!.operation, 'second mutation')
  assert.equal(cache.put(call('one', '🙂'.repeat(CALL_ENTRY_BYTES / 4))), 'oversize')
  assert.equal(cache.get('one'), undefined)
  assert.equal(cache.bytes, 0)
})

test('total retained bytes never exceed 16MiB and pressure preserves the selected detail model', () => {
  const cache = new CallCache()
  const model = (id: string) => call(id, 'é'.repeat((CALL_ENTRY_BYTES - 1_000) / 2))
  cache.put(model('pinned'))
  cache.pin({ kind: 'call', id: 'pinned' })
  cache.put(model('active'))
  cache.pinActive('active')
  for (let index = 0; index < 20; index++) {
    assert.equal(cache.put(model(String(index))), 'available')
    assert.ok(cache.bytes <= CALL_CACHE_BYTES)
    assert.ok(cache.get('pinned'))
    assert.ok(cache.get('active'))
  }
  assert.equal(cache.get('0'), undefined)
  cache.retain(new Set(['19']))
  assert.equal(cache.size, 3)
  cache.releaseActive('active')
  cache.retain(new Set(['19']))
  assert.equal(cache.size, 2)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.bytes, 0)
})

test('host metadata is small, contains no input or fabricated IR, and legacy details are explicitly reloaded', () => {
  const full = { ...call('old', 'x'.repeat(500_000)), variables: 'private input', ir: { ...call('old').ir, summary: { headline: 'actual headline'.repeat(1_000) } } }
  const overview = overviewOf(full)
  assert.ok(Buffer.byteLength(JSON.stringify(overview)) <= CALL_OVERVIEW_BYTES)
  assert.ok(!('ir' in overview))
  assert.ok(!('operation' in overview))
  assert.equal(overview.overview.headlineSource, 'model')
  assert.equal(overviewOf(call('derived')).overview.headlineSource, 'derived')
  const migrated = normalizeStoredCalls({ queue: [], last: full })
  assert.equal(migrated.version, 2)
  assert.equal(migrated.history[0]?.details, 'reloaded')
  const resolved = resolveCalls(migrated, new CallCache())
  assert.ok(resolved.last && 'overview' in resolved.last)
  assert.equal(fullCalls(resolved).history.length, 0)
  assert.equal(resolved.last.overview.headlineSource, 'model')
  assert.deepEqual(normalizeSelection({ cursor: 0 }, migrated), { kind: 'call', id: 'old' })
})

test('combined history keeps the newest 127 calls and a selected older call through every ending and late settlement', () => {
  const selection: SelectedCall = { kind: 'call', id: 'selected' }
  let stored = storeCalls(EMPTY_STORED, settle(arrive(EMPTY, call('selected')), 'selected', 'ran'), live)
  for (let i = 0; i < CALL_CACHE_ENTRIES + 35; i++) {
    const next = { ...call(`new-${i}`), ...(i % 3 !== 0 && { tool: 'search' as const }) }
    stored = { ...stored, queue: [overviewOf(next)] }
    stored = settleStoredCalls(stored, next.id, i % 2 ? 'errored' : 'interrupted', selection)
    const shown = shownResolvedAt(resolveCalls(stored, new CallCache()), selection)
    assert.equal(shown.call?.id, 'selected')
  }
  assert.equal(stored.history.length, CALL_CACHE_ENTRIES)
  assert.deepEqual(stored.history.map(one => one.id), [
    ...Array.from({ length: CALL_CACHE_ENTRIES - 1 }, (_, index) => `new-${CALL_CACHE_ENTRIES + 34 - index}`),
    'selected',
  ])
  const lateId = stored.history.find(one => one.status === 'interrupted')!.id
  stored = settleStoredCalls(stored, lateId, 'ran', selection)
  assert.equal(stored.history.find(one => one.id === lateId)?.status, 'ran')
  assert.equal(shownResolvedAt(resolveCalls(stored, new CallCache()), selection).call?.id, 'selected')
})

test('navigation uses ids, and missing selected calls do not silently display live', () => {
  const state = { queue: [call('pending')], last: call('new'), history: [call('new'), call('old')] }
  assert.deepEqual(selectionOlder(live, state), { kind: 'call', id: 'new' })
  assert.deepEqual(selectionNewer({ kind: 'call', id: 'old' }, state), { kind: 'call', id: 'new' })
  assert.deepEqual(selectionNewer({ kind: 'call', id: 'new' }, state), live)
  assert.equal(shownResolvedAt(state, { kind: 'call', id: 'gone' }).call, null)
})

test('one hundred mixed calls retain complete details through the old per-kind boundaries and cache hydration', () => {
  const cache = new CallCache()
  let stored = EMPTY_STORED
  const kinds = [undefined, 'search', 'introspect', 'validate', 'dry_run'] as const
  for (let index = 0; index < 100; index++) {
    const tool = kinds[index % kinds.length]
    const model: InspectedCall = { ...call(`history-${index}`, `query History${index} { jira_issue(key: "HIST-${index}") { key } }`), ...(tool !== undefined && { tool }), outcome: { rows: [], errors: [], authLinks: [], hasData: true } }
    cache.put(model)
    const next = settle(arrive(fullCalls(resolveCalls(stored, cache)), model), model.id, 'ran')
    cache.put(next.last!)
    stored = storeCalls(stored, next, live)
    cache.retain(new Set(stored.history.map(one => one.id)))
  }
  assert.equal(stored.history.length, 100)
  assert.equal(cache.size, 100)
  const persisted = cache.serialized()
  cache.clear()
  const reloaded = new CallCache()
  for (const entry of persisted) assert.equal(reloaded.put(JSON.parse(entry.json) as InspectedCall), 'available')
  const history = fullCalls(resolveCalls(normalizeStoredCalls(JSON.parse(JSON.stringify(stored))), reloaded)).history
  assert.equal(history.length, 100)
  for (const [index, model] of [...history].reverse().entries()) {
    assert.equal(model.id, `history-${index}`)
    assert.match(model.operation, new RegExp(`History${index} `))
    assert.equal(model.tool, kinds[index % kinds.length])
    assert.equal(model.outcome?.hasData, true)
  }
})

test('unselected combined history keeps precisely the newest 128 calls regardless of their tools', () => {
  let stored = EMPTY_STORED
  for (let index = 0; index < CALL_CACHE_ENTRIES + 10; index++) {
    const model = { ...call(`recent-${index}`), ...(index % 2 === 0 && { tool: 'search' as const }) }
    stored = settleStoredCalls({ ...stored, queue: [overviewOf(model)] }, model.id, 'ran', live)
  }
  assert.equal(stored.history.length, CALL_CACHE_ENTRIES)
  assert.deepEqual(stored.history.map(one => one.id), Array.from({ length: CALL_CACHE_ENTRIES }, (_, index) => `recent-${CALL_CACHE_ENTRIES + 9 - index}`))
})

test('generated mixed settlement sequences agree with an independent oldest-unselected eviction oracle', () => {
  fc.assert(fc.property(fc.array(fc.record({ lookup: fc.boolean(), status: fc.constantFrom('ran', 'denied', 'errored', 'interrupted') }), { minLength: CALL_CACHE_ENTRIES, maxLength: CALL_CACHE_ENTRIES + 60 }), events => {
    const selection: SelectedCall = { kind: 'call', id: 'selected' }
    let state = storeCalls(EMPTY_STORED, settle(arrive(EMPTY, call('selected')), 'selected', 'ran'), live)
    const expected = [{ id: 'selected', lookup: false }]
    for (const [index, event] of events.entries()) {
      const model = { ...call(`event-${index}`), ...(event.lookup && { tool: 'search' as const }) }
      state = { ...state, queue: [overviewOf(model)] }
      state = settleStoredCalls(state, model.id, event.status, selection)
      expected.unshift({ id: model.id, lookup: event.lookup })
      while (expected.length > CALL_CACHE_ENTRIES) {
        const victim = expected.findLastIndex(one => one.id !== 'selected')
        expected.splice(victim, 1)
      }
      assert.deepEqual(state.history.map(one => one.id), expected.map(one => one.id))
      assert.equal(shownResolvedAt(resolveCalls(state, new CallCache()), selection).call?.id, 'selected')
    }
  }), { numRuns: 100 })
})


test('many small calls reuse bounded host slots and preserve the selected and active models', () => {
  const cache = new CallCache()
  cache.put(call('selected'))
  cache.put(call('active'))
  cache.pin({ kind: 'call', id: 'selected' })
  cache.pinActive('active')
  let index = detailIndexFor(cache, { ...EMPTY_DETAILS, epoch: 'session' })
  const selectedSlot = index.entries.find(entry => entry.id === 'selected')?.slot
  const activeSlot = index.entries.find(entry => entry.id === 'active')?.slot
  assert.notEqual(selectedSlot, undefined)
  assert.notEqual(activeSlot, undefined)
  const addresses = new Set(index.entries.map(entry => entry.slot))
  for (let i = 0; i < 1_000; i += 1) {
    cache.put(call(String(i)))
    index = detailIndexFor(cache, index)
    for (const entry of index.entries) addresses.add(entry.slot)
    assert.ok(cache.size <= CALL_CACHE_ENTRIES)
    assert.ok(cache.bytes <= CALL_CACHE_BYTES)
    assert.ok(cache.has('selected'))
    assert.ok(cache.has('active'))
    assert.equal(new Set(index.entries.map(entry => entry.slot)).size, index.entries.length)
    assert.deepEqual(normalizeDetailIndex(index), index)
  }
  assert.equal(addresses.size, CALL_CACHE_ENTRIES)
  assert.equal(index.entries.find(entry => entry.id === 'selected')?.slot, selectedSlot)
  assert.equal(index.entries.find(entry => entry.id === 'active')?.slot, activeSlot)
})

test('a fresh cache can hydrate serialized host entries without sharing ownership with the old module', () => {
  const first = new CallCache()
  first.put({ ...call('retained'), outcome: { rows: [], errors: [], authLinks: [], hasData: true } })
  const index = detailIndexFor(first, { ...EMPTY_DETAILS, epoch: 'session' })
  const serialized = first.serialized()
  first.clear()
  const fresh = new CallCache()
  for (const entry of serialized) assert.equal(fresh.put(JSON.parse(entry.json) as InspectedCall), 'available')
  assert.deepEqual(detailIndexFor(fresh, index), index)
  assert.equal(fresh.get('retained')?.outcome?.hasData, true)
})

test('invalid host catalogs cannot overrun the byte or address bounds', () => {
  const entry = { id: 'a', slot: 0, bytes: 20 }
  const catalog = { ...EMPTY_DETAILS, epoch: 'session', entries: [entry] }
  for (const invalid of [
    { ...catalog, entries: [entry, entry] },
    { ...catalog, entries: [{ ...entry, slot: -1 }] },
    { ...catalog, entries: [{ ...entry, slot: CALL_CACHE_ENTRIES }] },
    { ...catalog, entries: [{ ...entry, bytes: CALL_ENTRY_BYTES + 1 }] },
    { ...catalog, entries: Array.from({ length: 9 }, (_, i) => ({ id: String(i), slot: i, bytes: CALL_ENTRY_BYTES })) },
    { ...catalog, entries: Array.from({ length: CALL_CACHE_ENTRIES + 1 }, (_, i) => ({ id: String(i), slot: i, bytes: 1 })) },
  ]) assert.deepEqual(normalizeDetailIndex(invalid), EMPTY_DETAILS)
})
