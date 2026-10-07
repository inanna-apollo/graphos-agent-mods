// The pane after the review pass, through the text renderer: repeats cut,
// one value column, the flags line, group heads in RESULT. Behavior only:
// which words appear, and where they do not.
import { expect, test } from 'claude-code/testing'

import { displayWidth, renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, viewOf } from '../src/view.tsx'
import { BADGE_HUE, STRUCT } from '../src/view/ui/theme.ts'
import { gnarlyCall, relayCall, reviewCall } from './review-fixtures.ts'
import { LINKS, SITE } from '../test/unit/link-fixture.ts'

const render = (call: ReturnType<typeof reviewCall>, columns: number) =>
  renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, CLOSED, () => undefined, { surface: 'terminal', links: LINKS }), columns)

for (const columns of [50, 64, 84]) {
  test(`ReviewSample, settled, at ${columns} columns: each fact said once`, () => {
    const text = render(reviewCall('ran'), columns)
    const lines = text.split('\n')
    const flat = text.replace(/\s+/g, ' ')
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    // Nothing reads as a disclosure arrow unless it opens something.
    expect(text).not.toMatch(/[❯▹]/)
    // The status is the word alone; the counts carry the denial, with DENIED the one loud word.
    expect(lines[0]).toMatch(/✓ ran$/)
    expect(lines[0]).not.toMatch(/denied/i)
    expect(text).toMatch(/DENIED 1/)
    // Services by the names the flags line uses, not their slugs.
    expect(lines[0]).toMatch(/Jira · acme customer data|\d services/i)
    expect(lines[0]).not.toMatch(/acme-customer-data|\bjira\b/)
    // The rule under the header is one plain rule: no heavy lead, no fade.
    expect(lines[2]).toMatch(/^─+$/)
    // The credit is an eyebrow right above the box, at its left edge; the box holds only the headline.
    expect(text).toMatch(/^summary · Haiku\n╭─+╮$/m)
    expect(text).not.toMatch(/│.*Haiku/)
    // The flags line sits right under the box and says what the denial cost.
    const bottom = lines.findIndex(line => line.startsWith('╰'))
    expect(lines[bottom + 1]).toMatch(/^⚑/)
    // Settled with presses, the request is its own button under the line: it drafts, never files.
    expect(flat).toMatch(/⚑ email denied for 4 members a: draft access request/)
    expect(text).not.toMatch(/access request can be filed/)
    expect(text).not.toMatch(/withheld/)
    // The text after a glyph starts where every other row's does: one cell and a space.
    expect(text).toMatch(/^⚑ \S/m)
    expect(text).toMatch(/^↗ \S/m)
    // The field's facts are on its name in the tree, said once there: no notes line repeats them, and no scope line.
    expect(text).toMatch(/╰ ✕ email {2}denied · pii\.contact$/m)
    expect(text.match(/denied · pii\.contact/g)).toHaveLength(1)
    expect(text).not.toMatch(/pii-high|—/)
    expect(text).not.toMatch(/1 field denied|personal data: email/)
    expect(text).not.toMatch(/no scopes|needs/)
    // Group heads say their noun once; each member row keeps its own denial, the tags in one column.
    expect(text).toMatch(/\bmembers {2}4\n/)
    expect(text).toMatch(/\bopen {2}5 issues/)
    expect(text).not.toMatch(/members {2}4 members|open {2}issues/)
    const tagged = lines.filter(line => /mem_\w+ +✕ email/.test(line))
    expect(tagged).toHaveLength(4)
    expect(new Set(tagged.map(line => line.indexOf('✕'))).size).toBe(1)
    // `return type` is a row of the root's form, never a section in the gutter; its type facts say no jargon.
    expect(text).not.toMatch(/RETURNS|ACCESS/)
    expect(lines.filter(line => /^ {2}return type\b/.test(line))).toHaveLength(2)
    expect(text).not.toMatch(/issues!|each present|\(got \d+\)|\bjson\b/)
    expect(text).toMatch(/fields {2}untyped JSON/)
    // A root's place in the call is not a fraction.
    expect(text).not.toMatch(/\d\/2\b/)
    // The deep link says what it opens; settled, it is a button (`o`).
    expect(text).toMatch(/↗ +\[this search in Jira\]/)
    expect(text).toMatch(/o: open$/m)
  })
}

test('ReviewSample, pending: the flags line names the path and nothing is pressable', () => {
  const text = renderText(viewOf(stubKit(), { call: reviewCall('pending'), waiting: 0 }, 64, CLOSED, undefined, { surface: 'terminal', links: LINKS }), 64)
  // Only dry_run's token exists before the call runs, and the agent never sees it: no request is offered.
  expect(text.replace(/\s+/g, ' ')).toMatch(/⚑ members\.email denied/)
  expect(text).not.toMatch(/access request/)
  expect(text).not.toMatch(/c: copy|r: raw/)
})

test('a description shows only when it fits whole on its row; none is cut', () => {
  for (const columns of [50, 64, 84]) {
    const text = render(reviewCall('ran'), columns)
    // The search root's description is a long sentence: left to the root's card.
    expect(text).not.toMatch(/“Search for issues/)
    expect(text).not.toMatch(/…”/)
    expect(text).toMatch(/“List organization members\.”/)
  }
})

for (const columns of [50, 64, 84]) {
  test(`GnarlyOverview, settled, at ${columns} columns: overflow is a flag, and every root has its place`, () => {
    const text = render(gnarlyCall('ran'), columns)
    const flat = text.replace(/\s+/g, ' ')
    for (const line of text.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    expect(flat).toMatch(/Jira returned 50 \(asked 3\)/)
    expect(flat).toMatch(/incident\.io returned 25 \(asked 3\)/)
    // RESULT does not say it again.
    expect(text).not.toMatch(/asked for/)
    expect(text).toMatch(/\btotal {2}412\b/)
    // A name too long for the value column stacks its value under the column.
    expect(text).toMatch(/^ {2}statusCategory\n +live · closed$/m)
    // Each root runs out in a rule, with no `2/4` after it.
    expect(text).not.toMatch(/\d\/4/)
    if (columns === 84) expect(text).toMatch(/total: jira_countIssues ─+$/m)
    // The return tree does not repeat what the flags line says came back.
    expect(text).not.toMatch(/\(got \d+\)/)
    // Personal data takes one glyph everywhere: ◆ before the name in the tree, and no notes line repeats it.
    expect(text).toMatch(/◆ email {2}personal data/)
    expect(text).not.toMatch(/▴/)
    expect(text.match(/personal data/g)).toHaveLength(1)
  })
}

/** The Buttons in a plain-data tree from stubKit, with their props (onPress among them). */
function buttons(node: unknown): { key?: string; label?: string; onPress?: () => void }[] {
  if (node === null || typeof node !== 'object') return []
  const el = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const own = el.type === 'Button' ? [el.props as { key?: string; label?: string; onPress?: () => void }] : []
  return [...own, ...(Array.isArray(node) ? node : (el.children ?? [])).flatMap(buttons)]
}

test('settled, every drawn link is a button that sends openUrl through act: the deep link and each record', () => {
  const changes: { openUrl?: string }[] = []
  const tree = viewOf(stubKit(), { call: reviewCall('ran'), waiting: 0 }, 84, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  const found = buttons(tree)
  found.find(one => one.key === 'open:link:0')?.onPress?.()
  expect(changes.at(-1)?.openUrl).toMatch(/^https:\/\/example\.atlassian\.net\/issues\/\?jql=project/)
  const pending = buttons(viewOf(stubKit(), { call: reviewCall('pending'), waiting: 0 }, 84, CLOSED, undefined, { surface: 'terminal', links: LINKS }))
  expect(pending).toHaveLength(0)
})

test('settled, each record row is a button that opens its own issue', () => {
  const changes: { openUrl?: string }[] = []
  const tree = viewOf(stubKit(), { call: reviewCall('ran'), waiting: 0 }, 84, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  const rows = buttons(tree).filter(one => one.key?.startsWith('open:row:'))
  expect(rows).toHaveLength(5)
  for (const row of rows) {
    row.onPress?.()
    // Bracketed, as links are written; the press opens the key inside.
    expect(row.label).toMatch(/^\[DEV-\d+\]$/)
    expect(changes.at(-1)?.openUrl).toBe(`${SITE}/browse/${row.label?.slice(1, -1)}`)
  }
})

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
/** Every element in a plain-data tree from stubKit, depth first. */
const all = (node: unknown): Node[] => {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(all)
  const el = node as Node
  return [el, ...(el.children ?? []).flatMap(all)]
}
/** The text an element says. */
const said = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(said).join('')
  return ((node as Node).children ?? []).map(said).join('')
}

test('with Markdown, a press on a record key opens that record through act', () => {
  const changes: { openUrl?: string }[] = []
  const kit = { ...stubKit(), Markdown: (props: Record<string, unknown>) => ({ type: 'Markdown', props, children: [] }) }
  const tree = viewOf(kit, { call: reviewCall('ran'), waiting: 0 }, 84, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  const keys = all(tree).filter(el => el.type === 'Markdown' && String(el.props?.key ?? '').startsWith('open:row:'))
  expect(keys).toHaveLength(5)
  for (const key of keys) {
    const url = (key.props?.pressableLinks as string[])[0] ?? ''
    ;(key.props?.onLinkPress as (url: string) => void)(url)
    expect(url).toMatch(/^https:\/\/example\.atlassian\.net\/browse\/DEV-\d+$/)
    expect(changes.at(-1)?.openUrl).toBe(url)
  }
})

test('the rule under the header is faint for a read and in the badge hue for a write', () => {
  const rule = (call: ReturnType<typeof reviewCall>) =>
    all(viewOf(stubKit(), { call, waiting: 0 }, 64, CLOSED, () => undefined, { surface: 'terminal', links: LINKS })).find(el => el.type === 'Text' && /^─{60,}$/.test(said(el)))
  const read = reviewCall('ran')
  const write = { ...read, ir: { ...read.ir, opType: 'mutation' as const } }
  expect(rule(read)?.props?.color).toBe(STRUCT.guide)
  expect(rule(write)?.props?.color).toBe(BADGE_HUE.mutation)
})

test('at 50 columns a long summary wraps, never cut', () => {
  const text = render(reviewCall('ran'), 50)
  // Read as words, the whole summary is there.
  expect(text.replace(/\s+/g, ' ')).toMatch(/\[DEV-467\] Research: Connect the Acme exporter with other storage vendors/)
  expect(text).not.toMatch(/\[DEV-\d+\][^\n]*…$/m)
})

test('settled, the access request is a press that drafts it into the prompt, naming the field and the call', () => {
  const changes: { draftPrompt?: string }[] = []
  const tree = viewOf(stubKit(), { call: reviewCall('ran'), waiting: 0 }, 64, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  const button = buttons(tree).find(one => one.label === 'draft access request')
  expect(button).toBeDefined()
  button?.onPress?.()
  expect(changes.at(-1)?.draftPrompt).toMatch(/^File an Agent Services access request for `email` on .*members, denied in the ReviewSample call\./)
  // Settled with nothing to press, the line says it instead.
  const unpressable = renderText(viewOf(stubKit(), { call: reviewCall('ran'), waiting: 0 }, 64, CLOSED, undefined, { surface: 'terminal', links: LINKS }), 64)
  expect(unpressable.replace(/\s+/g, ' ')).toMatch(/⚑ email denied for 4 members · access request can be filed/)
})

test('settled, a row opens out on a press to the fields it kept, and closes on another', () => {
  const call = reviewCall('ran')
  const changes: { row?: string | null }[] = []
  const toggles = buttons(viewOf(stubKit(), { call, waiting: 0 }, 64, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })).filter(one => one.label === '▸')
  expect(toggles.length).toBeGreaterThan(0)
  toggles[0]?.onPress?.()
  const row = changes.at(-1)?.row ?? null
  expect(row).not.toBeNull()
  const open = { ...CLOSED, row }
  // What the row didn't say already, under it: the status the summary row leaves out, never the key or the summary again.
  const opened = render2(call, open)
  expect(opened).toMatch(/fields\.status\.name +Open/)
  expect(opened).not.toMatch(/^ +key +DEV-634$/m)
  buttons(viewOf(stubKit(), { call, waiting: 0 }, 64, open, change => changes.push(change), { surface: 'terminal', links: LINKS })).find(one => one.label === '▾')?.onPress?.()
  expect(changes.at(-1)?.row).toBeNull()
})

const render2 = (call: ReturnType<typeof reviewCall>, ui: typeof CLOSED) => renderText(viewOf(stubKit(), { call, waiting: 0 }, 64, ui, () => undefined, { surface: 'terminal', links: LINKS }), 64)

test('settled in a short pane, the rows that came back stay; the form is trimmed first', () => {
  const text = renderText(viewOf(stubKit(), { call: reviewCall('ran'), waiting: 0 }, 64, CLOSED, () => undefined, { surface: 'terminal', bodyRows: 30, links: LINKS }), 64)
  expect(text).toMatch(/\[DEV-634\]/)
  expect(text).toMatch(/Leo Marsh/)
})

test('a Relay connection shows its nodes as rows, and records named only by an id show their ids', () => {
  const text = renderText(viewOf(stubKit(), { call: relayCall(), waiting: 0 }, 80, CLOSED, () => undefined, { surface: 'terminal', links: LINKS }), 80)
  const flat = text.replace(/\s+/g, ' ')
  expect(flat).toMatch(/Plan cache misses/)
  expect(flat).toMatch(/Router drops the trace header/)
  expect(flat).toMatch(/acct_01J9Z8/)
  // The edge's cursor is plumbing, never a row.
  expect(text).not.toMatch(/Y3Vyc29y/)
})

test('an opened member row says what was denied there, with its classification', () => {
  const call = reviewCall('ran')
  const changes: { row?: string | null }[] = []
  // The member list's first toggle, pressed: the row it opens.
  const tree = viewOf(stubKit(), { call, waiting: 0 }, 64, CLOSED, change => changes.push(change), { surface: 'terminal', links: LINKS })
  buttons(tree).filter(one => one.label === '▸').at(-4)?.onPress?.()
  expect(render2(call, { ...CLOSED, row: changes.at(-1)?.row ?? null })).toMatch(/email +✕ denied · pii/)
})
