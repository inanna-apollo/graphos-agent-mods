import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { ObservationQueue } from '../../src/observation.ts'

type End = { status: 'ran' | 'interrupted'; text?: string }
const queue = () => new ObservationQueue<{ operation: string; trust?: string }, End>()
const fallback: End = { status: 'ran' }

test('completion before persistence preserves input and the first terminal event, then releases payloads', () => {
  const q = queue()
  const input = { operation: 'query Read { jira_issue { key } }' }
  assert.ok(q.admit('one', input))
  input.operation = 'changed by producer'
  assert.ok(q.finish('one', { status: 'ran', text: 'A-1' }, fallback))
  assert.equal(q.finish('one', { status: 'interrupted' }, fallback), false)
  const arrival = q.take()!
  assert.equal(arrival.phase, 'arrival')
  assert.equal(arrival.arrival.operation, 'query Read { jira_issue { key } }')
  assert.deepEqual(arrival.terminal, { status: 'ran', text: 'A-1' })
  assert.equal(q.take(), undefined)
  q.complete(arrival)
  const terminal = q.take()!
  assert.equal(terminal.phase, 'terminal')
  assert.deepEqual(terminal.terminal, { status: 'ran', text: 'A-1' })
  q.complete(terminal)
  assert.equal(q.size, 0)
  assert.equal(q.bytes, 0)
  assert.equal(q.take(), undefined)
})

test('a pending call does not prevent a second call from being inspected and settled', () => {
  const q = queue()
  q.admit('waiting', { operation: 'first' })
  const first = q.take()!
  q.complete(first)
  q.admit('done', { operation: 'second' })
  q.finish('done', { status: 'ran' }, fallback)
  const next = q.take()!
  assert.equal(next.id, 'done')
  q.complete(next)
  q.complete(q.take()!)
  assert.equal(q.size, 1)
  assert.equal(q.take(), undefined)
})

test('trust evidence arriving during a write gets its own update without repeating arrival', () => {
  const q = queue()
  q.admit('one', { operation: 'read' })
  const original = q.take()!
  assert.ok(q.updateArrival('one', input => ({ ...input, trust: 'AllowedRead' })))
  q.complete(original)
  const update = q.take()!
  assert.equal(update.phase, 'update')
  assert.equal(update.arrival.trust, 'AllowedRead')
  q.complete(update)
  assert.equal(q.take(), undefined)
  q.finish('one', fallback, fallback)
  const terminal = q.take()!
  assert.equal(terminal.phase, 'terminal')
  assert.equal(terminal.arrival.trust, 'AllowedRead')
  q.complete(terminal)
})

test('a paused writer rejects new calls but keeps the admitted completion for recovery', () => {
  const q = queue()
  q.admit('one', { operation: 'read' })
  const held = q.take()!
  q.setPaused(true)
  for (let n = 0; n < 200; n++) assert.equal(q.admit(`skipped-${n}`, { operation: 'read' }), false)
  assert.equal(q.size, 1)
  assert.equal(q.skipped, 200)
  assert.ok(q.finish('one', fallback, fallback))
  q.complete(held)
  q.complete(q.take()!)
  q.setPaused(false)
  assert.ok(q.admit('recovered', { operation: 'new' }))
})

test('oversized responses keep explicit terminal fallback and budgets include in-flight data', () => {
  const q = new ObservationQueue<{ operation: string }, End>({ entries: 2, bytes: 600, entryBytes: 400 })
  assert.ok(q.admit('one', { operation: '🙂'.repeat(30) }))
  const held = q.take()!
  assert.ok(q.finish('one', { status: 'ran', text: 'x'.repeat(1000) }, fallback))
  assert.deepEqual(q.getTerminal('one'), fallback)
  assert.ok(q.bytes <= 600)
  assert.ok(q.admit('two', { operation: 'read' }))
  assert.equal(q.admit('three', { operation: 'read' }), false)
  q.complete(held)
  q.complete(q.take()!)
  assert.ok(q.admit('three', { operation: 'read' }))
})

test('oversized input retains bounded metadata and reserves room for its completion', () => {
  const q = new ObservationQueue<{ operation?: string; unavailable?: boolean }, End>({ entries: 2, bytes: 600, entryBytes: 400 })
  assert.ok(q.admit('one', { operation: 'x'.repeat(1000) }, () => ({ unavailable: true })))
  assert.deepEqual(q.getArrival('one'), { unavailable: true })
  assert.ok(q.finish('one', { status: 'ran' }, fallback))
  const arrival = q.take()!
  assert.deepEqual(arrival.terminal, { status: 'ran' })
  q.complete(arrival)
  q.complete(q.take()!)
  assert.equal(q.bytes, 0)
})

test('metadata replacement charges the old arrival while its drain is suspended', () => {
  const q = new ObservationQueue<{ operation: string; trust?: string }, End>({ entries: 3, bytes: 700, entryBytes: 400 })
  q.admit('held', { operation: 'x'.repeat(100) })
  const job = q.take()!
  const before = q.bytes
  assert.ok(q.updateArrival('held', input => ({ ...input, trust: 'allowed' })))
  assert.ok(q.bytes > before + 100)
  const replacementCharge = q.bytes
  q.clear()
  assert.equal(q.bytes, replacementCharge)
  q.complete(job)
  assert.equal(q.bytes, 0)
})

test('retirement charges the uncancellable active payload until acknowledgement and rejects stale updates', () => {
  const q = new ObservationQueue<{ operation: string }, End>({ entries: 1, bytes: 600, entryBytes: 400 })
  q.admit('old', { operation: 'old' })
  const old = q.take()!
  const heldBytes = q.bytes
  q.clear()
  assert.equal(q.bytes, heldBytes)
  assert.equal(q.size, 1)
  assert.equal(q.admit('new', { operation: 'new' }), false)
  q.complete(old)
  assert.equal(q.bytes, 0)
  assert.ok(q.admit('new', { operation: 'new' }))
  q.discard(old)
  assert.equal(q.size, 1)
  assert.equal(q.take()!.id, 'new')
})

test('generated completion timings conserve admitted calls and their first terminal outcomes', () => {
  fc.assert(fc.property(fc.array(fc.record({ text: fc.string({ maxLength: 100 }), early: fc.boolean(), interrupted: fc.boolean() }), { minLength: 1, maxLength: 30 }), records => {
    const q = queue()
    const expected = new Map<string, End>()
    const delivered = new Map<string, End>()
    for (const [n, record] of records.entries()) {
      const id = String(n)
      assert.ok(q.admit(id, { operation: record.text }))
      const terminal: End = { status: record.interrupted ? 'interrupted' : 'ran', text: record.text }
      expected.set(id, terminal)
      if (record.early) q.finish(id, terminal, fallback)
    }
    // Arrival is independent of whether the underlying tool has finished.
    let job
    while ((job = q.take()) !== undefined) {
      if (job.phase === 'terminal') {
        assert.equal(delivered.has(job.id), false)
        delivered.set(job.id, job.terminal!)
      }
      q.complete(job)
    }
    for (const [id, end] of expected) {
      q.finish(id, end, fallback)
      q.finish(id, { status: end.status === 'ran' ? 'interrupted' : 'ran' }, fallback)
    }
    while ((job = q.take()) !== undefined) {
      assert.equal(job.phase, 'terminal')
      assert.equal(delivered.has(job.id), false)
      delivered.set(job.id, job.terminal!)
      q.complete(job)
    }
    assert.deepEqual([...delivered].sort(), [...expected].sort())
    assert.equal(q.bytes, 0)
    assert.equal(q.size, 0)
  }))
})
