import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { CALL_CACHE_BYTES, CALL_CACHE_ENTRIES, CALL_ENTRY_BYTES, legacyDetails, normalizeStoredCalls, overviewOf } from '../../src/call-cache.ts'
import type { InspectedCall } from '../../types/index.d.ts'

const call = (id: string, operation = `query ${id} { saved }`): InspectedCall => ({ id, operation, variables: `{"id":"${id}"}`, server: 'saved-server', status: 'ran', arrivedAt: 1, ir: { toolCallId: id, state: 'partial', roots: [] }, outcome: { rows: [], errors: [], authLinks: [], hasData: true } })

test('legacy import retains authentic newest models within entry and byte budgets', () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 100 }), { minLength: 120, maxLength: 180 }), values => {
    const history = values.map((value, index) => call(`saved${index}`, value))
    const before = JSON.stringify(history)
    const cache = legacyDetails({ queue: [], last: history[0] ?? null, history })
    assert.equal(cache.size, Math.min(history.length, CALL_CACHE_ENTRIES))
    assert.ok(cache.bytes <= CALL_CACHE_BYTES)
    for (const model of history.slice(0, CALL_CACHE_ENTRIES)) assert.deepEqual(cache.get(model.id), model)
    assert.equal(JSON.stringify(history), before)
    assert.equal(cache.bytes, cache.serialized().reduce((sum, entry) => sum + Buffer.byteLength(entry.json), 0))
  }))
})

test('byte pressure keeps newer legacy models and oversized models remain genuine metadata', () => {
  const history = Array.from({ length: 20 }, (_, index) => call(`saved${index}`, 'x'.repeat(1_000_000)))
  const cache = legacyDetails({ queue: [], history })
  assert.ok(cache.bytes <= CALL_CACHE_BYTES)
  assert.ok(cache.get('saved0'))
  assert.equal(cache.get('saved19'), undefined)
  const oversized = call('oversized', 'x'.repeat(CALL_ENTRY_BYTES))
  assert.equal(legacyDetails({ queue: [], history: [oversized] }).size, 0)
  assert.deepEqual(normalizeStoredCalls({ queue: [], history: [oversized] }).history[0], overviewOf(oversized, 'reloaded'))
})

test('modern metadata and invalid legacy objects cannot establish full details', () => {
  const full = call('saved')
  assert.equal(legacyDetails({ version: 2, queue: [], history: [full] }).size, 0)
  assert.equal(legacyDetails({ queue: [], history: [{ ...full, variables: undefined }, { ...full, ir: { ...full.ir, toolCallId: 'different' } }, overviewOf(full)] }).size, 0)
  const history = Array.from({ length: 150 }, (_, index) => call(`saved${index}`))
  assert.equal(normalizeStoredCalls({ queue: history, history }).history.length, CALL_CACHE_ENTRIES)
  assert.equal(normalizeStoredCalls({ queue: history, history }).queue.length, CALL_CACHE_ENTRIES)
})
