// A requestable denial in RESULT offers its own press: `request access`
// drafts the access request for that one field into the prompt box, and
// sends nothing. Behaviour only: what appears and what a press asks for.

import { expect, test } from 'claude-code/testing'
import { renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, viewOf } from '../src/view.tsx'
import { directoryCall } from './review-fixtures.ts'
import { LINKS } from '../test/unit/link-fixture.ts'

type Pressable = { props?: { key?: string; label?: string; onPress?: () => void }; children?: unknown[] }
function buttons(node: unknown, found: Pressable['props'][] = []): Pressable['props'][] {
  if (Array.isArray(node)) for (const one of node) buttons(one, found)
  else if (node !== null && typeof node === 'object') {
    const element = node as Pressable & { type?: unknown; props?: Record<string, unknown> }
    if (element.type === 'Button') found.push(element.props as Pressable['props'])
    buttons(element.children, found)
    buttons((element.props as { children?: unknown } | undefined)?.children, found)
  }
  return found
}

test('a requestable denial offers request access, which drafts that field\'s request and sends nothing', () => {
  const changes: { draftPrompt?: string }[] = []
  const tree = viewOf(stubKit(), { call: directoryCall(), waiting: 0 }, 64, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  const presses = buttons(tree).filter(one => one?.label === 'request access')
  expect(presses.length).toBeGreaterThan(0)
  presses[0]?.onPress?.()
  expect(changes.at(-1)?.draftPrompt).toMatch(/access request for `(realName|profile)`, denied in the TeamDirectory call/)
})

test('with nothing to press, the denial says requestable in words instead', () => {
  const text = renderText(viewOf(stubKit(), { call: directoryCall(), waiting: 0 }, 64, CLOSED, undefined, { surface: 'terminal', links: LINKS }), 64)
  expect(text).toMatch(/requestable/)
  expect(text).not.toMatch(/request access/)
})

test('… N more opens the list out to every kept row, and show fewer folds it back', () => {
  const changes: { more?: string | null }[] = []
  const tree = viewOf(stubKit(), { call: directoryCall(), waiting: 0 }, 64, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  const more = buttons(tree).find(one => /^… \d+ more$/.test(one?.label ?? ''))
  expect(more).toBeDefined()
  more?.onPress?.()
  const opened = changes.at(-1)?.more
  expect(typeof opened).toBe('string')
  const open = viewOf(stubKit(), { call: directoryCall(), waiting: 0 }, 64, { ...CLOSED, more: opened ?? null }, change => changes.push(change), { surface: 'terminal', links: LINKS })
  expect(renderText(open, 64)).toMatch(/vik/)
  const fewer = buttons(open).find(one => one?.label === 'show fewer')
  fewer?.onPress?.()
  expect(changes.at(-1)?.more).toBe(null)
})
