import assert from 'node:assert/strict'
import { test } from 'node:test'

import { statusLine } from '../../src/view/status.ts'

const NONE = { calls: 0, unasked: 0, rules: 0, isTrustOff: false, isTrustFileChanged: false }

test('a session with no call and no rule says nothing at all', () => {
  assert.equal(statusLine(NONE), undefined)
  // Trust turned off with nothing loaded is still nothing.
  assert.equal(statusLine({ ...NONE, isTrustOff: true }), undefined)
})

test('the line counts calls, trust rules and the calls that ran unasked, each with its noun in the right number', () => {
  const line = statusLine({ ...NONE, calls: 5, unasked: 2, rules: 3 })
  assert.ok(line !== undefined)
  assert.match(line, /^Agent Services/)
  assert.match(line, /5 calls/)
  assert.match(line, /3 trust rules/)
  assert.match(line, /2 ran unasked/)
  const one = statusLine({ ...NONE, calls: 1, unasked: 1, rules: 1 })
  assert.match(one ?? '', /1 call\b/)
  assert.match(one ?? '', /1 trust rule\b/)
})

test('only what is true is said: no unasked count when none ran unasked, no rules when none are loaded', () => {
  const calls = statusLine({ ...NONE, calls: 4 })
  assert.match(calls ?? '', /4 calls/)
  assert.doesNotMatch(calls ?? '', /unasked|trust/)
  const rules = statusLine({ ...NONE, rules: 2 })
  assert.match(rules ?? '', /2 trust rules/)
  assert.doesNotMatch(rules ?? '', /call|unasked/)
})

test('turning trust off is said in place of the rule count, and the count of calls that already ran unasked stays', () => {
  const line = statusLine({ ...NONE, calls: 3, unasked: 2, rules: 3, isTrustOff: true })
  assert.match(line ?? '', /trust off/)
  assert.doesNotMatch(line ?? '', /3 trust rules/)
  assert.match(line ?? '', /2 ran unasked/)
})

test('a saved trust file is said even with nothing else to count, and says what to do about it', () => {
  const line = statusLine({ ...NONE, isTrustFileChanged: true })
  assert.match(line ?? '', /^Agent Services/)
  assert.match(line ?? '', /run \/gas trust to reload/)
  assert.match(line ?? '', /\/gas trust/)
  const more = statusLine({ ...NONE, calls: 2, rules: 1, isTrustFileChanged: true })
  assert.match(more ?? '', /2 calls/)
  assert.match(more ?? '', /1 trust rule\b/)
  assert.match(more ?? '', /run \/gas trust to reload/)
})
