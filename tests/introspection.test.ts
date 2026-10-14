import { expect, test } from 'claude-code/testing'
import { adaptLookup, settledLookup } from '../src/lookup.ts'
import { callStatusOf, headlineOf, lookupNotes } from '../src/view/kinds.ts'
import type { InspectedCall } from '../types'
import { CLOSED, planFor, viewOf } from '../src/view.tsx'
import { displayWidth, renderText, stubKit } from '../src/snapshot/text.ts'
import { cardId } from '../src/view/plan.ts'
import { detailOf } from '../src/view/details.ts'
import type { RenderElement } from 'claude-code'

function memberCall(sdl: string): InspectedCall {
  const adapted = adaptLookup('introspect', { scope: 'acme', type: 'Example' })
  return { id: 'members', tool: 'introspect', input: adapted.input, server: 'gas', operation: '', variables: '', arrivedAt: 0, status: 'ran', ...settledLookup('members', 'introspect', adapted, { types: [sdl] }, 100) }
}

for (const [kind, sdl] of [
  ['scalar', 'scalar Example'],
  ['union', 'union Example = First | Second'],
  ['enum', 'enum Example { FIRST SECOND }'],
  ['input', 'input Example { id: ID! }'],
  ['interface', 'interface Example { id: ID! }'],
  ['object', 'type Example { id: ID! }'],
] as const) {
  test(`a declared ${kind} has a successful introspection status and headline`, () => {
    const adapted = adaptLookup('introspect', { scope: 'acme', type: 'Example' })
    const settled = settledLookup(kind, 'introspect', adapted, { types: [sdl] }, 100)
    const call: InspectedCall = { id: kind, tool: 'introspect', input: adapted.input, server: 'gas', operation: '', variables: '', arrivedAt: 0, status: 'ran', ...settled }
    expect(callStatusOf(call, 0)?.word === 'not found').toBe(false)
    expect(headlineOf(call)?.includes('has no')).toBe(false)
    if (kind === 'union') expect(renderText(viewOf(stubKit(), { call, waiting: 0 }, 50), 50)).toContain('Declared union')
  })
}

test('each visible enum value has its own truthful card, and older stored members still draw', () => {
  const call = memberCall('enum Example { "The active choice.\\u001b[31m" ACTIVE OLD @deprecated(reason: "Use ACTIVE.") UNKNOWN FOUR FIVE SIX SEVEN }')
  const active = detailOf(call, 'member:0')
  const old = detailOf(call, 'member:1')
  expect(active?.lines.join('\n')).toContain('The active choice.')
  expect(active?.lines.join('\n').includes('\u001b')).toBe(false)
  expect(old?.lines.join('\n')).toContain('Deprecated: Use ACTIVE.')
  expect(detailOf(call, 'member:2')?.lines.join('\n')).toContain('No description')
  expect(renderText(viewOf(stubKit(), { call, waiting: 0 }, 50), 50)).toContain('SEVEN')

  if (call.found !== undefined) {
    delete call.found.memberDetails
    delete call.found.typeKind
  }
  expect(detailOf(call, 'member:0')?.lines.join('\n')).toContain('No description')
  expect(renderText(viewOf(stubKit(), { call, waiting: 0 }, 50, CLOSED), 50)).toContain('ACTIVE')
})

for (const sdl of [
  'enum Example { FIRST SECOND THIRD FOURTH FIFTH SIXTH SEVENTH EIGHTH }',
  'union Example = First | Second',
  'input Example { "Maximum." limit: Int = 25 old: String @deprecated }',
]) {
  test(`introspection member rows and individual card anchors match their rendered layout: ${sdl.split(' ')[0]}`, () => {
    const call = memberCall(sdl)
    for (const columns of [32, 50, 64, 84]) for (const bodyRows of [12, 40]) {
      const options = { surface: 'terminal' as const, bodyRows }
      const plan = planFor(stubKit(), call, columns, CLOSED, () => undefined, options)
      const text = renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, CLOSED, () => undefined, options), columns, { clip: false })
      expect(plan.total).toBe(text.split('\n').length)
      for (const row of text.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
      expect(plan.roots.length).toBe(0)
      for (const shown of plan.notes.shown) {
        const note = plan.notes.all[shown.index]
        if (note?.card !== undefined) expect(plan.anchors.has(cardId.note(shown.index))).toBe(true)
      }
    }
  })
}

function elements(node: unknown): RenderElement[] {
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const element = node as RenderElement
  return [element, ...('children' in element && Array.isArray(element.children) ? element.children.flatMap(elements) : [])]
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object' || !('children' in node) || !Array.isArray(node.children)) return ''
  return node.children.map(textOf).join('')
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`enum member names light distinct hidden cards with schema facts (${surface})`, async ($, on) => {
    const call = memberCall('enum Example { "Current choice." CURRENT "Historical choice." OLD @deprecated(reason: "Use CURRENT.") }')
    on('ui.render', { component: 'Pane', requestId: 'members' }, ($, e) => {
      const { Box, Text, Code } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code }, { call, waiting: 0 }, e.props.bodyColumns, CLOSED, undefined, { surface: e.surface })
    })
    const mounted = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'members', props: { title: 'Inspector', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    const all = elements(await mounted.drawn())
    const scopes = new Set<unknown>()
    for (const [name, description] of [['CURRENT', 'Current choice.'], ['OLD', 'Historical choice.']]) {
      const card = all.find(el => el.type === 'Box' && 'props' in el && el.props?.display === 'none' && textOf(el).includes(description ?? ''))
      expect(card).toBeDefined()
      const hover = card !== undefined && 'hover' in card ? card.hover : undefined
      expect(hover !== undefined && 'display' in hover ? hover.display : undefined).toBe('flex')
      expect(hover?.scope).toBeDefined()
      scopes.add(hover?.scope)
      expect(all.some(el => el.type === 'Text' && 'hover' in el && el.hover?.scope === hover?.scope && textOf(el).includes(name ?? ''))).toBe(true)
      if (name === 'OLD') expect(textOf(card)).toContain('Deprecated: Use CURRENT.')
    }
    expect(scopes.size).toBe(2)
  })
}
