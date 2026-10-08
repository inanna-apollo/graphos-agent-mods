import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptExecute } from '../../src/adapter.ts'

const OP = 'query Q { me { id } }'

test('object variables pass through', () => {
  assert.deepEqual(adaptExecute({ operation: OP, variables: { a: 1, b: { c: [2] } } }), {
    ok: true,
    input: { operation: OP, variables: { a: 1, b: { c: [2] } } },
  })
})

test('JSON-string variables are parsed', () => {
  assert.deepEqual(adaptExecute({ operation: OP, variables: '{"id":"x","n":3}' }), {
    ok: true,
    input: { operation: OP, variables: { id: 'x', n: 3 } },
  })
})

test('empty and whitespace-only string variables mean none', () => {
  for (const variables of ['', '  \n\t']) {
    assert.deepEqual(adaptExecute({ operation: OP, variables }), { ok: true, input: { operation: OP, variables: {} } })
  }
})

test('null and undefined variables mean none', () => {
  assert.deepEqual(adaptExecute({ operation: OP, variables: null }), { ok: true, input: { operation: OP, variables: {} } })
  assert.deepEqual(adaptExecute({ operation: OP, variables: undefined }), { ok: true, input: { operation: OP, variables: {} } })
  assert.deepEqual(adaptExecute({ operation: OP }), { ok: true, input: { operation: OP, variables: {} } })
})

test('invalid JSON string is reported with the raw text', () => {
  const result = adaptExecute({ operation: OP, variables: '{not json' })
  assert.deepEqual(result, {
    ok: false,
    error: 'variables is a string that is not valid JSON',
    operation: OP,
    variables: '{not json',
  })
})

test('JSON string that is not an object is reported', () => {
  for (const variables of ['[1,2]', 'null', '42', '"s"', 'true']) {
    const result = adaptExecute({ operation: OP, variables })
    assert.equal(result.ok, false, variables)
    if (!result.ok) {
      assert.equal(result.error, 'variables is not a JSON object')
      assert.equal(result.variables, variables)
      assert.equal(result.operation, OP)
    }
  }
})

test('array variables are rejected, not treated as an object', () => {
  const result = adaptExecute({ operation: OP, variables: [1, 2] })
  assert.deepEqual(result, {
    ok: false,
    error: 'variables is not an object',
    operation: OP,
    variables: JSON.stringify([1, 2], null, 2),
  })
})

test('non-object, non-string variables are rejected', () => {
  const result = adaptExecute({ operation: OP, variables: 7 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.variables, '7')
})

test('non-string operation is rejected and shown as JSON', () => {
  const num = adaptExecute({ operation: 5, variables: {} })
  assert.deepEqual(num, { ok: false, error: 'operation is not a string', operation: '5', variables: '{}' })

  const obj = adaptExecute({ operation: { a: 1 }, variables: undefined })
  assert.equal(obj.ok, false)
  if (!obj.ok) {
    assert.equal(obj.operation, JSON.stringify({ a: 1 }, null, 2))
    assert.equal(obj.variables, '')
  }
})

test('missing operation is rejected', () => {
  const result = adaptExecute({})
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.variables, '')
})

test('operation text is preserved exactly, including control characters', () => {
  const operation = 'query { a }\x1b[31m\u202e'
  const result = adaptExecute({ operation, variables: '' })
  assert.equal(result.ok && result.input.operation, operation)
})

test('unserializable values fall back to String()', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const result = adaptExecute({ operation: cyclic, variables: 1n })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.operation, '[object Object]')
    assert.equal(result.variables, '1')
  }
})
