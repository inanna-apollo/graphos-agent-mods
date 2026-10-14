import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adaptLookup, settledLookup } from '../../src/lookup.ts'
import { lookupNoticeOf } from '../../src/view/notice.ts'
import type { InspectedCall } from '../../types/index.d.ts'

const introspect = (type: string, types: unknown) => settledLookup('declaration', 'introspect', adaptLookup('introspect', { type }), { types }, 100)

test('41 fields and 61 enum values retain the complete declaration independently of display limits', () => {
  const object = introspect('Example', [`type Example { ${Array.from({ length: 41 }, (_, i) => `field${i}: String`).join(' ')} }`])
  assert.equal(object.ir.roots[0]?.children.length, 41)
  assert.equal(object.ir.roots[0]?.children.at(-1)?.name, 'field40')
  assert.deepEqual(object.found.counts?.fields, { kind: 'exact', value: 41 })
  const members = Array.from({ length: 61 }, (_, i) => `CHOICE_${i}`)
  const enumeration = introspect('Example', [`enum Example { ${members.join(' ')} }`])
  assert.deepEqual(enumeration.found.members, members)
  assert.deepEqual(enumeration.found.counts?.members, { kind: 'exact', value: 61 })
})

test('retention caps report omissions without changing exact source counts', () => {
  const object = introspect('Example', [`type Example { ${Array.from({ length: 1_200 }, (_, i) => `field${i}: String`).join(' ')} }`])
  assert.deepEqual(object.found.counts?.fields, { kind: 'exact', value: 1_200 })
  assert.ok((object.ir.roots[0]?.children.length ?? 0) < 1_200)
  assert.equal(object.found.completeness, 'partial')
  assert.ok(object.found.omissions?.some(one => /node limit/.test(one)))
  const enumeration = introspect('Example', [`enum Example { ${Array.from({ length: 600 }, (_, i) => `CHOICE_${i}`).join(' ')} }`])
  assert.deepEqual(enumeration.found.counts?.members, { kind: 'exact', value: 600 })
  assert.ok((enumeration.found.members?.length ?? 0) < 600)
  assert.ok(enumeration.found.omissions?.some(one => /declared members omitted/.test(one)))
})

test('a declaration beyond the source size cap is unavailable, never confirmed absent', () => {
  const object = introspect('Example', [`"${'x'.repeat(64 * 1_024)}" type Example { id: ID }`])
  assert.equal(object.found.typeKind, 'unavailable')
  assert.equal(object.found.completeness, 'unavailable')
  assert.deepEqual(object.found.counts?.types, { kind: 'unknown' })
  assert.ok(object.found.omissions?.some(one => /size limit/.test(one)))
})

test('missing, malformed and partially parsed source distinguish unknown from absent declarations', () => {
  for (const types of [undefined, ['type Example {'], ['scalar Other', 42], ['query FindExample { Example }']]) {
    const object = introspect('Example', types)
    assert.equal(object.found.typeKind, 'unavailable')
    assert.ok(object.found.omissions?.length)
    assert.equal(object.ir.roots[0]?.schema, undefined)
  }
  const present = introspect('Example', ['type Example { id: ID }', 'extend type Example {'])
  assert.equal(present.found.typeKind, 'object')
  assert.deepEqual(present.found.counts?.fields, { kind: 'at-least', value: 1 })
  assert.equal(present.found.completeness, 'partial')
  assert.equal(introspect('Example', []).found.typeKind, 'absent')
})

test('source string count and total character limits also prevent false absence', () => {
  const strings = Array.from({ length: 200 }, (_, i) => `scalar Type${i}`)
  const overflow = introspect('Example', [...strings, 'scalar Example'])
  assert.equal(overflow.found.typeKind, 'unavailable')
  assert.deepEqual(overflow.found.counts?.types, { kind: 'at-least', value: 200 })
  const large = Array.from({ length: 8 }, (_, i) => `"${'x'.repeat(64 * 1_024 - 40)}" scalar Type${i}`)
  const total = introspect('Example', [...large, `"${'x'.repeat(1_024)}" scalar Example`])
  assert.equal(total.found.typeKind, 'unavailable')
  assert.ok(total.found.omissions?.some(one => /size limit/.test(one)))
})

for (const [kind, sdl, members] of [
  ['scalar', 'scalar Example', []],
  ['union', 'union Example = First | Second\nextend union Example = Third', ['First', 'Second', 'Third']],
  ['enum', 'enum Example { FIRST SECOND }', ['FIRST', 'SECOND']],
  ['input', 'input Example { id: ID! }', ['id: ID!']],
  ['interface', 'interface Example { id: ID! }', []],
  ['object', 'type Example { id: ID! }', []],
] as const) {
  test(`introspection recognizes a declared ${kind} and draws it as found`, () => {
    const adapted = adaptLookup('introspect', { scope: 'acme', type: 'Example' })
    const settled = settledLookup(kind, 'introspect', adapted, { types: [sdl] }, 100)
    const call: InspectedCall = { id: kind, tool: 'introspect', input: adapted.input, server: 'gas', operation: '', variables: '', arrivedAt: 0, status: 'ran', ...settled }
    assert.equal(settled.found.typeKind, kind)
    assert.deepEqual(settled.found.members ?? [], members)
    assert.notEqual(lookupNoticeOf(call), 'no such type')
  })
}

test('introspection distinguishes an absent declaration from an existing type with no fields', () => {
  const adapted = adaptLookup('introspect', { type: 'Missing' })
  const settled = settledLookup('missing', 'introspect', adapted, { types: ['scalar Present'] }, 100)
  const call: InspectedCall = { id: 'missing', tool: 'introspect', input: adapted.input, server: 'gas', operation: '', variables: '', arrivedAt: 0, status: 'ran', ...settled }
  assert.equal(settled.found.typeKind, 'absent')
  assert.match(lookupNoticeOf(call) ?? '', /no .*type.*visible.*complete response/i)
})

test('enum values retain their own descriptions and deprecations across extensions', () => {
  const adapted = adaptLookup('introspect', { type: 'Choice' })
  const settled = settledLookup('enum', 'introspect', adapted, { types: [
    '"Parent description" enum Choice { "The active choice." ACTIVE OLD @deprecated(reason: "Use ACTIVE.") }',
    'extend enum Choice { UNKNOWN }',
  ] }, 100)
  assert.deepEqual(settled.found.members, ['ACTIVE', 'OLD', 'UNKNOWN'])
  assert.deepEqual(settled.found.memberDetails, [
    { name: 'ACTIVE', description: 'The active choice.' },
    { name: 'OLD', deprecated: 'Use ACTIVE.' },
    { name: 'UNKNOWN' },
  ])
})

test('input fields retain SDL types and defaults beside their own card facts', () => {
  const adapted = adaptLookup('introspect', { type: 'Filter' })
  const settled = settledLookup('input', 'introspect', adapted, { types: ['input Filter { "Maximum results." limit: Int = 25 old: String @deprecated }'] }, 100)
  assert.deepEqual(settled.found.members, ['limit: Int = 25', 'old: String'])
  assert.deepEqual(settled.found.memberDetails, [{ name: 'limit', description: 'Maximum results.' }, { name: 'old', deprecated: 'deprecated' }])
})

test('union member descriptions come only from each possible object type', () => {
  const adapted = adaptLookup('introspect', { type: 'Result' })
  const settled = settledLookup('union', 'introspect', adapted, { types: ['"Parent prose" union Result = Page | Issue', '"A document." type Page { title: String }'] }, 100)
  assert.deepEqual(settled.found.memberDetails, [{ name: 'Page', description: 'A document.' }, { name: 'Issue' }])
})

test('stored member text is bounded without inventing descriptions or losing deprecation', () => {
  const adapted = adaptLookup('introspect', { type: 'Choice' })
  const settled = settledLookup('bounded', 'introspect', adapted, { types: [`enum Choice { "${'x'.repeat(2_001)}" OLD @deprecated(reason: "${'y'.repeat(2_001)}") }`] }, 100)
  assert.equal(settled.found.isTrimmed, true)
  assert.deepEqual(settled.found.memberDetails, [{ name: 'OLD', deprecated: 'deprecated' }])
})
