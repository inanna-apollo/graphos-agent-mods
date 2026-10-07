// A write's CHANGES section, on both surfaces, and its verdict line in the
// transcript. Behaviour only: the change is said, a delete reads as removed, a
// flag shows, a settled write is confirmed, every row has a card; never
// exact lines or offsets.

import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { InspectedCall } from '../types'
import { CLOSED, viewOf } from '../src/view.tsx'
import { LINKS } from '../test/unit/link-fixture.ts'
import { deleteCall, editCall, pageCall, postCall, transitionCall, unmappedCall } from './write-fixtures.ts'

const PANE_PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} }

type Body = Parameters<Extract<Parameters<typeof test>[1], Function>>

function elements(node: unknown): RenderElement[] {
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const element = node as RenderElement
  const children = 'children' in element && Array.isArray(element.children) ? element.children : []
  return [element, ...children.flatMap(elements)]
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node.replace(/\n */g, ' ')
  if (node === null || typeof node !== 'object') return ''
  const element = node as { type?: string; props?: { label?: unknown }; children?: unknown[] }
  if (element.type === 'Button' && typeof element.props?.label === 'string') return element.props.label
  return (element.children ?? []).map(textOf).join('')
}

const propsOf = (element: RenderElement | undefined) => ((element !== undefined && 'props' in element ? element.props : undefined) ?? {}) as Record<string, unknown>
const hoverOf = (element: RenderElement) => ('hover' in element ? (element.hover as Record<string, unknown> | undefined) : undefined)
const isCard = (element: RenderElement) => element.type === 'Box' && String(propsOf(element).key ?? '').startsWith('card:')

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = async ($: Body[0], on: Body[1], one: InspectedCall) => {
    on('ui.render', { component: 'Pane', requestId: 'changes-test' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code, Button }, { call: one, waiting: one.status === 'pending' ? 1 : 0 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, links: LINKS })
    })
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'changes-test', props: PANE_PROPS })
  }

  test(`a pending transition says what it changes, new values only, with nothing to press (${surface})`, async ($, on) => {
    const pane = await mount($, on, transitionCall())
    expect(await pane.find({ text: /^CHANGES$/ })).toBeDefined()
    expect(await pane.find({ text: /issue DEV-634/ })).toBeDefined()
    expect(await pane.find({ text: /^transition$/ })).toBeDefined()
    expect(await pane.find({ text: /^\+$/ })).toBeDefined()
    expect(await pane.find({ text: /current state not read/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test(`an edit shows each field and a rich-text description as its lines (${surface})`, async ($, on) => {
    const pane = await mount($, on, editCall())
    expect(await pane.find({ text: /Add CSV export to the reports page/ })).toBeDefined()
    expect(await pane.find({ text: /## Goal/ })).toBeDefined()
    expect(await pane.find({ text: /^backend$/ })).toBeDefined()
    expect(await pane.find({ text: /^frontend$/ })).toBeDefined()
    expect(await pane.find({ text: /watchers are not told/ })).toBeDefined()
  })

  test(`a delete reads as removed, and says it cannot be undone (${surface})`, async ($, on) => {
    const pane = await mount($, on, deleteCall())
    expect(await pane.find({ text: /^-$/ })).toBeDefined()
    expect(await pane.find({ text: /cannot be undone/ })).toBeDefined()
    expect(await pane.find({ text: /also deletes its subtasks/ })).toBeDefined()
  })

  test(`a Slack post is a new message, its text as lines, @channel flagged (${surface})`, async ($, on) => {
    const pane = await mount($, on, postCall())
    expect(await pane.find({ text: /^NEW MESSAGE$/ })).toBeDefined()
    expect(await pane.find({ text: /Search is about twice as fast/ })).toBeDefined()
    expect(await pane.find({ text: /@channel notifies the channel/ })).toBeDefined()
  })

  test(`a pending page update shows its storage body as lines, and no RESULT yet (${surface})`, async ($, on) => {
    const pending = await mount($, on, pageCall())
    expect(await pending.find({ text: /## Escalation/ })).toBeDefined()
    expect(await pending.find({ text: /^RESULT$/ })).toBeUndefined()
  })

  test(`the form names the arguments CHANGES shows on one row, each lighting its card, rather than repeating them (${surface})`, async ($, on) => {
    const pane = await mount($, on, pageCall())
    const all = elements(await pane.drawn())
    // What the pane shows, cards left out: they are hidden until lit.
    const outside = (node: unknown): RenderElement[] => {
      if (node === null || typeof node !== 'object' || !('type' in node)) return []
      const element = node as RenderElement
      const children = 'children' in element && Array.isArray(element.children) ? element.children : []
      return isCard(element) ? [] : [element, ...children.flatMap(outside)]
    }
    const shown = outside(await pane.drawn())
    expect(await pane.find({ text: /^in CHANGES$/ })).toBeDefined()
    // The body is said once, as CHANGES lines: never again as markup in the form.
    expect(shown.some(one => one.type === 'Text' && /<h2>/.test(textOf(one)))).toBe(false)
    // An argument that steers the change stays a row of its own.
    expect(await pane.find({ text: /^bodyRepresentation$/ })).toBeDefined()
    const chip = shown.find(one => one.type === 'Text' && textOf(one) === 'bodyValue')
    expect(chip).toBeDefined()
    const scope = chip === undefined ? undefined : hoverOf(chip)?.scope
    expect(all.some(one => isCard(one) && hoverOf(one)?.scope === scope && /^bodyValue: /.test(textOf(one)))).toBe(true)
  })

  test(`a settled page update is confirmed by its response (${surface})`, async ($, on) => {
    const pane = await mount($, on, pageCall('ran'))
    expect(await pane.find({ text: /^RESULT$/ })).toBeDefined()
    expect(await pane.find({ text: /version 13/ })).toBeDefined()
    expect(await pane.find({ text: /✓/ })).toBeDefined()
  })

  test(`a mutation the table does not know still says its target and new values (${surface})`, async ($, on) => {
    const pane = await mount($, on, unmappedCall())
    expect(await pane.find({ text: /incident 01HXYZINCIDENT/ })).toBeDefined()
    expect(await pane.find({ text: /Database failover in eu-west/ })).toBeDefined()
  })

  test(`every CHANGES name has a hidden card, lit by it: the section, the target and a row (${surface})`, async ($, on) => {
    const pane = await mount($, on, editCall())
    const all = elements(await pane.drawn())
    const cards = all.filter(isCard)
    for (const pattern of [/^changes · built-in mapping/, /^issue DEV-634 · target/, /^summary · untyped JSON/]) {
      const card = cards.find(one => pattern.test(textOf(one)))
      expect(card, String(pattern)).toBeDefined()
      if (card === undefined) continue
      expect(propsOf(card).display).toBe('none')
      const scope = hoverOf(card)?.scope
      expect(all.some(one => !isCard(one) && one.type !== 'Box' && scope !== undefined && hoverOf(one)?.scope === scope)).toBe(true)
    }
    const summary = cards.find(one => /^summary · untyped JSON/.test(textOf(one)))
    expect(textOf(summary)).toMatch(/one-line title/)
    expect(textOf(summary)).toMatch(/untyped JSON/)
  })
}

// ---- The verdict line in the transcript

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const OPERATION = 'mutation Close { jira_doTransition(issueIdOrKey: "DEV-634", transition: { id: "31" }) }'
const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test("a write's verdict line, under its row and right above the dialog, leads with the change", async ($: Engine, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['jira'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [{ decision: 'allow', path: 'jira_doTransition' }] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Moves DEV-634"}', usage: USAGE } }))
  const ids: string[] = []
  on('tool.call', { tool: /__execute$/ }, (_, e) => {
    if (e.tool_use_id !== undefined) ids.push(e.tool_use_id)
    return { result: { content: [{ type: 'text', text: '{"data":{"jira_doTransition":null}}' }], isError: false } }
  })
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['row'] }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: '{}' })
  for (let step = 0; step < 10; step++) await clock.advance(100)
  const id = ids[0] ?? ''
  const row = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolUse', requestId: id, props: { tool_use_id: id, tool: EXECUTE, input: { operation: OPERATION, variables: '{}' }, isRunning: false, isErrored: false, isInterrupted: false } })
  expect(await row.find({ text: /✎ DEV-634 → transition 31/ })).toBeDefined()
  expect(await row.find({ text: /writes Jira/ })).toBeDefined()
})
