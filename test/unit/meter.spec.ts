import test from 'node:test'
import assert from 'node:assert/strict'
import { meterOf } from '../../src/view/meter.ts'

test('meterOf: ten cells, every state that occurs keeps one, nothing known is no meter', () => {
  const sum = (cells: NonNullable<ReturnType<typeof meterOf>>) => cells.allow + cells.mask + cells.deny + cells.unknown
  assert.deepEqual(meterOf({ allow: 9, mask: 1, deny: 0, unknown: 0 }), { allow: 9, mask: 1, deny: 0, unknown: 0 })
  const lone = meterOf({ allow: 50, mask: 1, deny: 1, unknown: 0 })!
  assert.equal(sum(lone), 10)
  assert.ok(lone.mask >= 1 && lone.deny >= 1)
  assert.equal(sum(meterOf({ allow: 3, mask: 0, deny: 0, unknown: 4 })!), 10)
  assert.equal(meterOf({ allow: 0, mask: 0, deny: 0, unknown: 5 }), undefined)
  assert.equal(meterOf({ allow: 0, mask: 0, deny: 0, unknown: 0 }), undefined)
})
