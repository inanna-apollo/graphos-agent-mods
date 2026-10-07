// The planner counts every block's rows so it can shed detail to fit, and
// says from the same counts where each hover trigger is drawn; here both are
// held against what the text renderer draws, at every width. A drift means
// the pane sheds too much, scrolls when it need not, or pops a card up away
// from what lit it.
import { expect, test } from 'claude-code/testing'

import { renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, planFor, viewOf } from '../src/view.tsx'
import { rowKey } from '../src/view/plan.ts'
import { walk } from '../src/view/kit.ts'
import { batchCall, directoryCall, gnarlyCall, heavyCall, keptOutCall, persistedCall, relayCall, reviewCall, titlesCall } from './review-fixtures.ts'
import { deleteCall, editCall, pageCall, postCall, transitionCall, unmappedCall } from './write-fixtures.ts'
import { LINKS } from '../test/unit/link-fixture.ts'
import { buildIR } from '../src/build.ts'
import { normalize } from '../src/normalize.ts'
import type { InspectedCall } from '../types'

/** The trust line, ran unasked with reasons long enough to wrap, and asked. */
const trusted = () => ({ ...reviewCall('ran'), trust: { isAllowed: true as const, fits: [{ root: 'jira_searchIssues', rule: 'JiraTriageWithAVeryLongRuleNameThatWraps', reasons: ['jql "project = DEV AND status = Open ORDER BY updated DESC" ~ "project = DEV*"'] }] } })
const asked = () => ({ ...gnarlyCall('ran'), trust: { isAllowed: false as const, reason: 'issues.fields.description is outside JiraTriage, so the call asked before it ran' } })

/** A subagent's call: its type and a task long enough to wrap, under the trust line it also carries. */
const delegated = () => ({ ...titlesCall(), trust: trusted().trust, agent: { id: 'agent-7', label: 'Explore: find every page that names the plan cache, then read the ones from this quarter and report what changed in each' } })
/** An agent the list has not named: the bare line. */
const unnamed = () => ({ ...titlesCall(), agent: { id: 'agent-9', label: '' } })
/** A call another plugin made: the plugin's name, wrapped where it is long. */
const pluginMade = () => ({ ...titlesCall(), agent: { id: '', label: '', plugin: 'acme-helper-with-a-rather-long-plugin-name-for-wrapping' } })

/**
 * `heavy`, `persisted` and `keptOut` are the heavy ones: the context line names a field and a flag says so; says Claude saw
 * only a preview; says that and nothing else. The writes after them draw CHANGES: a Jira transition, a field edit with a
 * rich-text body, a Confluence page update with a storage body (pending, and settled with RESULT confirming it), a Slack post
 * with @channel, a delete, and a mutation the table does not map.
 */
const CALLS = {
  ReviewSample: () => reviewCall('ran'),
  GnarlyOverview: () => gnarlyCall('ran'),
  titles: titlesCall,
  trusted,
  asked,
  delegated,
  unnamed,
  heavy: heavyCall,
  persisted: persistedCall,
  keptOut: keptOutCall,
  transition: transitionCall,
  edit: editCall,
  page: () => pageCall(),
  pageRan: () => pageCall('ran'),
  post: postCall,
  delete: deleteCall,
  unmapped: unmappedCall,
  pluginMade,
  directory: directoryCall,
  relay: relayCall,
} as const

/** A sweep draws a pane at every width: seconds of work, which a busy machine stretches past the default 5 s. */
const SWEEP_MS = 60_000

/** RESULT's rows as drawn: from its label to the blank row that ends the block. */
function resultRows(text: string): number {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('┃ RESULT'))
  if (start < 0) return 0
  const end = lines.findIndex((line, index) => index > start && line === '')
  return (end < 0 ? lines.length : end) - start
}

/** Below this the form's value column leaves its values almost no room, and a name the pane cuts the text renderer wraps. */
const TOTAL_FROM = 32

for (const [name, make] of Object.entries(CALLS)) {
  test(`${name}: the plan counts RESULT's rows, and from ${TOTAL_FROM} columns the whole pane, as they are drawn, at every width to 100`, { timeoutMs: SWEEP_MS }, () => {
    for (let columns = 16; columns <= 100; columns++) {
      const call = make()
      const act = () => undefined
      const plan = planFor(stubKit(), call, columns, CLOSED, act, { surface: 'terminal', links: LINKS })
      const text = renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, CLOSED, act, { surface: 'terminal', links: LINKS }), columns)
      // Labelled by width, so a failure says where.
      // A pending call has no RESULT, and no gap above one.
      expect(`${columns}: ${plan.result.rows === 0 ? 0 : plan.result.rows - plan.gap}`).toBe(`${columns}: ${resultRows(text)}`)
      if (columns >= TOTAL_FROM) expect(`${columns}: ${plan.total}`).toBe(`${columns}: ${text.split('\n').length}`)
    }
  })
}

/**
 * Whether the drawn rows an anchor spans are its trigger's, by what the
 * trigger shows (the text renderer leaves the cards out): a name, the
 * meter, a block's bar, a link's arrow. A RESULT row's card is anchored by
 * its whole list: from a head line to the list's last row.
 */
function isTriggerAt(id: string, rows: readonly string[], at: { row: number; rows: number }, call: ReturnType<typeof reviewCall>): boolean {
  const first = rows[at.row] ?? ''
  // A name that breaks into rows reads whole down the rows it spans.
  const spanned = rows.slice(at.row, at.row + at.rows).join('').replace(/\s+/g, '')
  const [kind = '', key = ''] = [id.slice(0, 1), id.slice(2)]
  const field = walk(call.ir.roots).find(one => one.path === key)
  if (key.startsWith('preview:') || kind === 't') return /^(┃ RESULT| {2}\S)/.test(first) && !/^ {4}/.test(rows[at.row + at.rows] ?? '')
  if (kind === 'm') return /[▰✓]|\d+ allowed/.test(first)
  if (kind === 'g') return first.startsWith('⚑')
  if (kind === 'l') return first.startsWith('↗')
  if (kind === 'o') return /… \d+ fields?/.test(first)
  if (kind === 'a') return spanned.includes(key.slice(key.lastIndexOf('.') + 1))
  if (kind === 'b' || kind === 's') return /^ ?(READ|WRITE|WATCH) +\S/.test(first)
  if (kind === 'n') return spanned.includes(call.ir.opName ?? '')
  if (kind === 'w') return /✓ ran|ran ·|errors|failed|denied|\d+ of \d+/.test(first)
  if (kind === 'c') return first.startsWith('summary · Haiku')
  if (kind === 'u') return /^[✓·] /.test(first)
  if (kind === 'p') return /^↳ from (subagent|the\b)/.test(first)
  if (kind === 'h') return /^(┃ RESULT| {2}\S)/.test(first)
  // The context line: a size (and its tokens), or that the response was saved to a file.
  if (kind === 'k') return /\d\s(B|KB|MB)\b|saved to a file/.test(first)
  // A CHANGES block's label and target sit on its header row; a row on its sign (or, restated, its label two cells further in).
  if (kind === 'x' || kind === 'y') return /^┃ (CHANGES|NEW [A-Z ]+|CREATES)\b/.test(first)
  if (kind === 'z') return /^ {2}[+\-±] \S/.test(first) || /^ {4}\S/.test(first)
  // RESULT's confirmation line.
  if (kind === 'v') return /✓|came back|created/.test(first)
  if (kind === 'r' || call.ir.roots.some(root => root.path === key)) return first.startsWith('┃ ')
  return field !== undefined && spanned.includes(field.name)
}

/** A root's drawer, a tree name's, and a RESULT row opened out: what is under them moves down by the rows the plan counts for them. */
const DRAWERS = [CLOSED, { ...CLOSED, field: 'members' }, { ...CLOSED, field: 'open.issues' }, { ...CLOSED, row: rowKey(reviewCall().id, 'open:issues', 1) }, { ...CLOSED, row: rowKey(reviewCall().id, 'members:members', 0) }]

for (const [name, make] of Object.entries(CALLS)) {
  test(`${name}: each hover card is anchored on the rows its trigger is drawn on, drawers shut or open, at every width from ${TOTAL_FROM} to 100`, { timeoutMs: SWEEP_MS }, () => {
    for (const ui of DRAWERS) {
      for (let columns = TOTAL_FROM; columns <= 100; columns++) {
        const call = make()
        const act = () => undefined
        const plan = planFor(stubKit(), call, columns, ui, act, { surface: 'terminal', links: LINKS })
        const rows = renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, ui, act, { surface: 'terminal', links: LINKS }), columns).split('\n')
        const at = `${columns} ${ui.field ?? ui.row ?? 'shut'}`
        expect(`${at}: ${plan.total}`).toBe(`${at}: ${rows.length}`)
        expect(plan.anchors.size).toBeGreaterThan(0)
        for (const [id, place] of plan.anchors) expect(`${at} ${id}: ${isTriggerAt(id, rows, place, call)}`).toBe(`${at} ${id}: true`)
      }
    }
  })
}

test(`a past call stepped back to keeps its status and its whole operation name in the header, the plan counting the rows, at every width from ${TOTAL_FROM} to 100`, { timeoutMs: SWEEP_MS }, () => {
  const nav = { count: 12, position: 6, isLive: false, older: 4, newer: 6 }
  for (const make of [() => reviewCall('ran'), () => gnarlyCall('ran')]) {
    for (let columns = TOTAL_FROM; columns <= 100; columns++) {
      const call = make()
      const act = () => undefined
      const options = { surface: 'terminal' as const, nav, links: LINKS }
      const plan = planFor(stubKit(), call, columns, CLOSED, act, options)
      const rows = renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, CLOSED, act, options), columns).split('\n')
      expect(`${columns}: ${plan.total}`).toBe(`${columns}: ${rows.length}`)
      const header = rows.slice(0, plan.header).join('\n')
      expect(`${columns}: ${/✓ ran/.test(header)}`).toBe(`${columns}: true`)
      expect(`${columns}: ${header.replace(/\s+/g, '').includes(call.ir.opName ?? '')}`).toBe(`${columns}: true`)
    }
  }
})

/** Windows the pane sheds to fit: every call here has more rows than either. */
const BUDGETS = [12, 24]

test(`a pane that sheds to fit its window draws the rows the plan counts, root by root on a batch, at every width from ${TOTAL_FROM} to 100`, { timeoutMs: SWEEP_MS }, () => {
  for (const make of [() => gnarlyCall('ran'), () => reviewCall('pending'), () => pageCall('ran'), () => batchCall(12)]) {
    for (const bodyRows of BUDGETS) {
      for (let columns = TOTAL_FROM; columns <= 100; columns++) {
        const call = make()
        const act = () => undefined
        const options = { surface: 'terminal' as const, links: LINKS, bodyRows }
        const plan = planFor(stubKit(), call, columns, CLOSED, act, options)
        const rows = renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, CLOSED, act, options), columns).split('\n')
        const at = `${call.ir.opName} ${columns}/${bodyRows}`
        expect(`${at}: ${plan.shed.length > 0}`).toBe(`${at}: true`)
        expect(`${at}: ${plan.total}`).toBe(`${at}: ${rows.length}`)
      }
    }
  }
})

test(`an unparseable call: the plan counts the note, the operation and its variables as they are drawn, at every width from ${TOTAL_FROM} to 100`, { timeoutMs: SWEEP_MS }, () => {
  const operation = 'query Broken {\n  jira_searchIssues(jql: "project = DEV" {\n\tissues { key summary description assignee { name } }\n  }\n}'
  const variables = '{\n  "jql": "project = DEV AND statusCategory != Done ORDER BY updated DESC"\n}'
  for (const status of ['pending', 'ran'] as const) {
    for (const sent of [{ variables }, { variables: '' }]) {
      const call: InspectedCall = { id: 'toolu_broken', server: 'claude_ai_GraphOS_Agent_Services', operation, ...sent, status, arrivedAt: 0, ir: buildIR('toolu_broken', normalize(operation, {})) }
      for (let columns = TOTAL_FROM; columns <= 100; columns++) {
        const act = () => undefined
        const options = { surface: 'terminal' as const, links: LINKS }
        const plan = planFor(stubKit(), call, columns, CLOSED, act, options)
        const text = renderText(viewOf(stubKit(), { call, waiting: 0 }, columns, CLOSED, act, options), columns)
        const at = `${status} ${sent.variables === '' ? 'no variables' : 'variables'} ${columns}`
        expect(`${at}: ${plan.total}`).toBe(`${at}: ${text.split('\n').length}`)
      }
    }
  }
})

test('a closed row holds its text to three rows, cut with `…` so its ▸ says there is more; opened, it says all of it', () => {
  const call = reviewCall('ran')
  const draw = (ui: typeof CLOSED) => renderText(viewOf(stubKit(), { call, waiting: 0 }, 36, ui, () => undefined, { surface: 'terminal', links: LINKS }), 36)
  const closed = draw(CLOSED).split('\n')
  const at = closed.findIndex(row => row.includes('[DEV-467]'))
  expect(closed[at]).toMatch(/▸/)
  const own = closed.slice(at, closed.findIndex((row, index) => index > at && /\[DEV-|members/.test(row)))
  expect(own.length).toBeLessThanOrEqual(3)
  expect(own.join(' ')).toMatch(/…/)
  expect(own.join(' ')).not.toMatch(/vendors/)
  const opened = draw({ ...CLOSED, row: rowKey(call.id, 'open:issues', 1) })
  expect(opened.replace(/\s+/g, ' ')).toContain('with other storage vendors')
})

test('the title-only list is drawn as one: keys alone, bracketed, the long ones wrapping', () => {
  const text = renderText(viewOf(stubKit(), { call: titlesCall(), waiting: 0 }, 40, CLOSED, () => undefined, { surface: 'terminal', links: LINKS }), 40)
  expect(text).toMatch(/^ {4}\[DEV-634\]$/m)
  // A key too long for the row wraps under itself, never cut.
  const rows = text.split('\n')
  const at = rows.findIndex(row => row.startsWith('    [LONGPROJECTKEY'))
  expect(rows[at + 1]).toMatch(/^ {4}\S+\]$/)
  expect(text).not.toMatch(/…\]/)
})
