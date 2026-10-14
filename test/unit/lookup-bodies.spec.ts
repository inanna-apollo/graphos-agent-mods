import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adaptLookup, settledLookup } from '../../src/lookup.ts'
import { CLOSED } from '../../src/view/kit.ts'
import { detailPage } from '../../src/view/details.ts'
import { lookupBody } from '../../src/view/lookups.ts'
import type { InspectedCall } from '../../types'
import fc from 'fast-check'
import { cellWidth } from '../../src/view/text-width.ts'
import { searchCall } from '../../tests/lookup-fixtures.ts'

const intro = (sdl: string): InspectedCall => {
  const adapted = adaptLookup('introspect', { type: 'Example' })
  return { id: 'example', server: 'gas', tool: 'introspect', input: adapted.input, operation: '', variables: '', arrivedAt: 0, status: 'ran', ...settledLookup('example', 'introspect', adapted, { types: [sdl] }, 100) }
}

test('large declarations expose twelve initial members and keep an expanded member visible when opened', () => {
  const call = intro(`enum Example { ${Array.from({ length: 61 }, (_, i) => `CHOICE_${i}`).join(' ')} }`)
  const initial = lookupBody(call, CLOSED, 50, 0)!
  assert.equal(initial.lines.filter(one => one.detailId?.startsWith('member:')).length, 12)
  assert.ok(initial.lines.some(one => one.expand && /49/.test(one.text)))
  const opened = lookupBody(call, { ...CLOSED, detail: { callId: call.id, detailId: 'member:15' } }, 50, 0)!
  assert.equal(opened.lines.filter(one => one.detailId?.startsWith('member:')).length, 61)
  assert.ok(opened.lines.some(one => one.detailId === 'member:15'))
  assert.ok(opened.lines.some(one => one.bold && /CHOICE_15/.test(one.text)), 'the opened member has a detail heading')
  assert.ok(opened.lines.some(one => /No description/.test(one.text)), 'the opened member exposes its description status')
})

test('opening a field beyond the initial twelve preserves the expanded range and its facts', () => {
  const call = intro(`type Example { ${Array.from({ length: 41 }, (_, i) => `"Field ${i}." field${i}: String`).join(' ')} }`)
  const opened = lookupBody(call, { ...CLOSED, detail: { callId: call.id, detailId: 'f:field15' } }, 64, 0)!
  assert.equal(opened.lines.filter(one => one.detailId !== undefined).length, 41)
  assert.ok(opened.lines.some(one => one.text === 'Field 15.'))
  assert.ok(!opened.lines.some(one => one.text.startsWith('TYPE')))
})

test('complete argument detail pages preserve values beyond the former 9000-character limit', () => {
  const call = intro('type Example { id: ID }')
  const value = `${'x'.repeat(80_000)} final-marker`
  call.ir.roots[0]!.args = [{ name: 'value', type: 'String', value, fromVariable: false }]
  const first = detailPage(call, 'a:Example.value')!
  assert.ok(first.pages > 1)
  const text = Array.from({ length: first.pages }, (_, page) => detailPage(call, `a:Example.value@page:${page}`)!.lines.join('\n')).join('')
  assert.ok(text.includes(value))
})

test('retained deprecation reasons and defaults survive complete detail paging', () => {
  const reason = `${'x'.repeat(10_000)} REASON_END`
  const call = intro(`type Example { old: String @deprecated(reason: "${reason}") other(arg: String = "${reason}"): String }`)
  assert.ok(detailPage(call, 'f:old')?.lines.join('\n').includes(reason))
  assert.ok(detailPage(call, 'f:other')?.lines.join('\n').includes(reason))
})

test('search groups real read and write capabilities with their required inputs and return types', () => {
  const plan = lookupBody(searchCall(), CLOSED, 64, 10)!
  const headings = plan.lines.filter(line => line.detailId !== undefined)
  assert.equal(headings.length, 3)
  assert.match(headings[0]!.text, /READ.*confluence_search.*Confluence/)
  assert.match(headings[2]!.text, /WRITE.*jira_createIssue.*Jira/)
  assert.ok(plan.lines.some(line => /cql: String!/.test(line.text)))
  assert.ok(plan.lines.some(line => /Confluence_SearchResult/.test(line.text)))
  assert.ok(plan.lines.some(line => line.dim && /Search Confluence content/.test(line.text)))
  for (const root of searchCall().ir.roots) assert.ok(plan.anchors.has(`f:${root.path}`))
})

test('aligned declaration rows keep wrapped names, list nullability, defaults and deprecations', () => {
  const call = intro('input Example { short: [String!]! = ["keep"] veryLongInputFieldName: String @deprecated(reason: "Use short.") }')
  for (const width of [24, 36, 64, 111]) {
    const plan = lookupBody(call, CLOSED, width, 7)!
    const text = plan.lines.flatMap(line => line.rows).join('\n')
    assert.ok(text.replace(/\s/g, '').includes('[String!]!=["keep"]'))
    assert.match(text, /veryLongInputFieldName/)
    assert.match(text, /deprecated/)
    assert.ok(plan.anchors.has('member:1'))
    assert.equal(plan.rows, plan.lines.reduce((n, line) => n + line.rows.length, 0))
    for (const line of plan.lines) {
      assert.deepEqual(line.rowParts.map(parts => parts.map(part => part.text).join('')), line.rows)
      for (const row of line.rows) assert.ok(cellWidth(row) <= width)
    }
  }
})

test('presentation styles preserve every wrapped row and each field trigger across widths', () => {
  // Independent text equality guards against styled slices dropping or duplicating
  // characters when names wrap or a narrow viewport stacks a type below its name.
  fc.assert(fc.property(fc.integer({ min: 16, max: 140 }), fc.integer({ min: 1, max: 90 }), (width, length) => {
    const name = `field_${'x'.repeat(length)}`
    const call = intro(`type Example { ${name}: [String!]! id: ID }`)
    const plan = lookupBody(call, CLOSED, width, 3)!
    const trigger = plan.lines.find(line => line.detailId === `f:${name}`)!
    assert.ok(trigger)
    assert.ok(trigger.rows.join('').replace(/\s/g, '').includes(name))
    assert.ok(trigger.rows.join('').replace(/\s/g, '').includes('[String!]!'))
    assert.equal(plan.anchors.get(`f:${name}`)?.rows, trigger.rows.length)
    for (const line of plan.lines) {
      assert.deepEqual(line.rowParts.map(parts => parts.map(part => part.text).join('')), line.rows)
      for (const row of line.rows) assert.ok(cellWidth(row) <= width)
    }
  }))
})
