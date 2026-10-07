import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TomlError, parseToml, tryParseToml } from '../../src/toml.ts'

test('tables, arrays of tables, strings, booleans, integers and comments', () => {
  const doc = parseToml(`
# a comment
[bases]
atlassian = "https://x.atlassian.net"   # trailing comment
lit = 'C:\\raw\\path'

[[record]]
service = "jira"
is_on = true
n = -3
tags = ["a", 'b', ]

[[record]]
service = "confluence"
`)
  assert.deepEqual({ ...(doc.bases as object) }, { atlassian: 'https://x.atlassian.net', lit: 'C:\\raw\\path' })
  const records = doc.record as Record<string, unknown>[]
  assert.equal(records.length, 2)
  assert.deepEqual({ ...records[0] }, { service: 'jira', is_on: true, n: -3, tags: ['a', 'b'] })
  assert.equal(records[1]?.service, 'confluence')
})

test('string escapes, including a # inside a string and CRLF endings', () => {
  const doc = parseToml('a = "x # y \\"q\\" \\\\ \\u00e9 \\n"\r\nb = false\r\n')
  assert.equal(doc.a, 'x # y "q" \\ é \n')
  assert.equal(doc.b, false)
})

test('strict: anything outside the subset throws a TomlError with the line', () => {
  const bad: [string, RegExp][] = [
    ['a = 1.5', /unsupported value/],
    ['a = 2026-01-01', /unsupported value/],
    ['a = """x"""', /multi-line/],
    ['a = "open', /unterminated/],
    ['a = "x" junk', /unexpected/],
    ['a = "\\q"', /bad escape/],
    ['a = ', /missing value/],
    ['a b = 1', /expected =/],
    ['a = 1\na = 2', /duplicate key/],
    ['[t]\n[t]', /defined twice/],
    ['[a.b]', /closing bracket/],
    ['[[t]]\n[t]', /defined twice/],
    ['t = 1\n[[t]]', /not an array of tables/],
    ['a = {x = 1}', /unsupported value/],
    ['= 1', /expected a key/],
    ['a = [1, 2', /expected , or \]|unsupported/],
  ]
  for (const [text, message] of bad) assert.throws(() => parseToml(text), (e: unknown) => e instanceof TomlError && message.test(e.message), text)
  assert.throws(() => parseToml('ok = 1\nbad'), (e: unknown) => e instanceof TomlError && e.line === 2)
  assert.throws(() => parseToml(`a = "${'x'.repeat(70_000)}"`), /too large/)
})

test('keys named like prototype members are plain keys', () => {
  const doc = parseToml('__proto__ = "x"\nconstructor = "y"')
  assert.equal(Object.getPrototypeOf(doc), null)
  assert.equal(doc.constructor, 'y')
  assert.equal(({} as Record<string, unknown>).x, undefined)
})

test('tryParseToml reports instead of throwing', () => {
  assert.equal(tryParseToml('a = 1').ok, true)
  assert.equal(tryParseToml('a = ?').ok, false)
})
