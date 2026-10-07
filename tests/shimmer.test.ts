// The live "checking policy…" line, through the plugin's own Pane: animated
// by a Client where the surface runs one, still elsewhere, and gone once
// analysis ends. Behaviour only: text appears, frames change.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const OPERATION = 'query Find($cql: String!) { confluence_search(cql: $cql, limit: 5) { results { title } } }'
const VARIABLES = JSON.stringify({ cql: 'type=page' })
const PANE_PROPS = {
  title: 'GraphOS Inspector',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/**
 * An Agent Services execute held at its prompt. The mocked clock moves only when the
 * test moves it, so the enrichment pump does not tick and the call stays
 * `analyzing` until then. With no allow rules the pump makes no Agent Services calls;
 * once it ticks, access is "not checked" and analysis is over.
 */
function heldExecute(on: On) {
  let release!: () => void
  let reached!: () => void
  const isReleased = new Promise<void>(resolve => (release = resolve))
  const isReached = new Promise<void>(resolve => (reached = resolve))
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('tool.call', { tool: EXECUTE }, async () => {
    reached()
    await isReleased
    return { result: { content: [], isError: false } }
  })
  return { release, isReached, clock }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`analyzing shows a live "checking policy" line that animates, until analysis ends (${surface})`, async ($, on) => {
    const gas = heldExecute(on)
    const running = $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
    await gas.isReached

    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'gas', props: PANE_PROPS })
    expect(await pane.find({ type: 'Client', key: 'shimmer' })).toBeDefined()
    expect(await pane.find({ in: 'shimmer', text: /checking policy/ })).toBeDefined()

    // The module draws frames on its own clock: the glyph turns.
    const glyphs = new Set<string>()
    for (let frame = 0; frame < 4; frame++) {
      const glyph = await pane.find({ in: 'shimmer', type: 'Text', text: /^[·✢✳✶✻✽]$/ })
      if (glyph?.text !== undefined) glyphs.add(glyph.text)
      await pane.advance(100)
    }
    expect(glyphs.size).toBeGreaterThan(1)
    expect(await pane.find({ in: 'shimmer', text: /checking policy/ })).toBeDefined()

    // The pump ticks and analysis ends: the line, its Client and its timer leave the pane.
    await gas.clock.advance(1_000)
    expect(await pane.find({ text: /access not checked/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Client' })).toHaveLength(0)
    expect(await pane.find({ text: /checking policy/ })).toBeUndefined()

    gas.release()
    await running
    await pane.unmount()
  })
}

for (const surface of ['vscode', 'mobile'] as const) {
  test(`without Client the line is still: ✻ checking policy… (${surface})`, async ($, on) => {
    const gas = heldExecute(on)
    const running = $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
    await gas.isReached

    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'gas', props: PANE_PROPS })
    expect(await pane.find({ text: /checking policy/ })).toBeDefined()
    expect(await pane.find({ text: /^✻$/ })).toBeDefined()

    gas.release()
    await running
  })
}
