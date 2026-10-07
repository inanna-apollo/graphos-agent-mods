import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMPTY, arrive, patchAgent, settle } from '../../src/queue.ts'
import { agentLineOf, agentOf, pluginOf } from '../../src/view/agent.ts'
import { reviewCall } from '../../tests/review-fixtures.ts'

test('an agent is recorded as its id and a label of its type and task', () => {
  assert.deepEqual(agentOf('agent-7', { type: 'Explore', description: 'find naming pages' }), { id: 'agent-7', label: 'Explore: find naming pages' })
  // Either half alone is still a label; neither is an empty one (the lookup did not know the agent).
  assert.equal(agentOf('a', { type: 'Plan' }).label, 'Plan')
  assert.equal(agentOf('a', { description: 'fix it' }).label, 'fix it')
  assert.equal(agentOf('a').label, '')
})

test('what a model wrote as a task is escaped and bounded, never drawn as it came', () => {
  const hostile = agentOf('agent\x1b[31m', { type: 'Explore\x07', description: 'read\nthis \x1b]0;title\x07 and ‮ reverse' })
  for (const text of [hostile.id, hostile.label]) {
    assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/)
  }
  // The whitespace of a multi-line task is laid flat.
  assert.doesNotMatch(hostile.label, /\n/)
  const huge = agentOf('x'.repeat(10_000), { type: 'T'.repeat(10_000), description: 'D'.repeat(100_000) })
  assert.ok(huge.id.length <= 200)
  assert.ok(huge.label.length <= 1_200)
})

test('only a call an agent made has an agent line, and it says so even before the list has named the agent', () => {
  assert.equal(agentLineOf(undefined), undefined)
  assert.equal(agentLineOf({ id: 'a', label: '' })?.text, 'from subagent')
  assert.equal(agentLineOf({ id: 'a', label: 'Explore: find naming pages' })?.text, 'from subagent · Explore: find naming pages')
})

test('the line escapes the label again: a stored one may predate the escaping', () => {
  const line = agentLineOf({ id: 'a', label: 'bad\x1b[2Jlabel' })
  assert.ok(line !== undefined)
  assert.doesNotMatch(line.text, /\x1b/)
  assert.match(line.text, /bad/)
})

test('a label found later is patched onto the call wherever it is: pending, or already settled', () => {
  const call = { ...reviewCall('pending'), agent: { id: 'agent-7', label: '' } }
  const pending = patchAgent(arrive(EMPTY, call), call.id, { id: 'agent-7', label: 'Explore: find naming pages' })
  assert.equal(pending.queue[0]?.agent?.label, 'Explore: find naming pages')
  const settled = patchAgent(settle(arrive(EMPTY, call), call.id, 'ran'), call.id, { id: 'agent-7', label: 'Plan: sketch it' })
  assert.equal(settled.last?.agent?.label, 'Plan: sketch it')
  assert.equal(settled.history[0]?.agent?.label, 'Plan: sketch it')
})

test('a call a plugin made names the plugin; the engine and a surface post are Claude and the person, not a plugin', () => {
  assert.equal(pluginOf(undefined), undefined)
  assert.equal(pluginOf('engine'), undefined)
  assert.equal(pluginOf('client'), undefined)
  assert.equal(pluginOf('   '), undefined)
  assert.equal(pluginOf('acme-helper'), 'acme-helper')
  // Laid flat, escaped and bounded as it is kept.
  const odd = pluginOf(`acme\x1b[2J  helper${'x'.repeat(500)}`) ?? ''
  assert.doesNotMatch(odd, /\x1b|\s{2}/)
  assert.ok(odd.length <= 101)
  const line = agentLineOf({ id: '', label: '', plugin: 'acme-helper' })
  assert.equal(line?.text, 'from the acme-helper plugin')
  assert.equal(line?.plugin, 'acme-helper')
  // A plugin calling from a subagent's loop says both.
  assert.equal(agentLineOf({ id: 'a', label: 'Explore: find it', plugin: 'acme-helper' })?.text, 'from the acme-helper plugin · in subagent Explore: find it')
  // The line escapes a stored name again.
  assert.doesNotMatch(agentLineOf({ id: '', label: '', plugin: 'bad\x1b[2Jname' })?.text ?? '', /\x1b/)
})
