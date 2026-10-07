// Behaviour of the pane's drawing (viewOf), on both surfaces. Deliberately
// not layout: only that text appears, and that controls exist when they can
// be pressed and not while a permission dialog is up.

import type { CallStatus, InspectedCall } from '../types'
import { expect, test } from 'claude-code/testing'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import type { Summary, Validation } from '../src/ir.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf } from '../src/result.ts'
import { indexSdl } from '../src/schema.ts'
import { CLOSED, RawView, viewOf } from '../src/view.tsx'
import { GLYPH, TREE } from '../src/view/ui/theme.ts'
import type { PaneUi, ViewOptions } from '../src/view.tsx'
import { LINKS } from '../test/unit/link-fixture.ts'

const OPERATION = `query SearchQueryPlanPages($cql: String!, $limit: Int) {
  hits: confluence_search(cql: $cql, limit: $limit) {
    results { title excerpt url lastModified content { id type } }
    totalSize
  }
}`
const VARIABLES = { cql: 'type=page AND text ~ "query plan" ORDER BY lastmodified DESC', limit: 10 }

const SDL = [
  `type Query {
    "Search Confluence with CQL. Requires the search:confluence and read:confluence-content.summary scopes."
    confluence_search(cql: String!, limit: Int): Confluence_SearchResults
  }`,
  `type Confluence_SearchResults { results: [Confluence_SearchResultItem!]! totalSize: Int }`,
  `type Confluence_SearchResultItem {
    title: String
    "A short excerpt of the matching text.\\u001b[31m"
    excerpt: String
    url: String
    lastModified: String
    content: Confluence_Content
  }`,
  `type Confluence_Content { id: ID! type: String }`,
]

const SUMMARY: Summary = {
  headline: 'Searches Confluence for pages mentioning "query plan", newest first.',
}

type Options = { status?: CallStatus; summary?: Summary; validation?: Validation; operation?: string; isEnriched?: boolean }

function call(options: Options = {}): InspectedCall {
  const operation = options.operation ?? OPERATION
  let ir = buildIR('toolu_view', normalize(operation, VARIABLES))
  if (options.isEnriched !== false && ir.state !== 'unparseable') {
    const fields = new Map<string, FieldDecision>([['hits.results.excerpt', { decision: 'mask' }]])
    for (const path of ['hits', 'hits.results', 'hits.results.title', 'hits.results.url', 'hits.totalSize']) {
      fields.set(path, { decision: 'allow' })
    }
    ir = annotate(ir, {
      schema: indexSdl(SDL),
      access: { denyOperation: false, fields },
      validation: options.validation ?? { valid: true, diagnostics: [] },
      scope: 'confluence',
      isIncomplete: false,
    })
  }
  if (options.summary !== undefined) ir = { ...ir, summary: options.summary }
  return {
    id: 'toolu_view',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation,
    variables: JSON.stringify(VARIABLES, null, 2),
    status: options.status ?? 'pending',
    arrivedAt: Date.UTC(2026, 9, 5),
    ir,
  }
}

const PANE_PROPS = {
  title: 'GraphOS Inspector',
  isFocused: false,
  bodyColumns: 84,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

type Body = Parameters<Extract<Parameters<typeof test>[1], Function>>
type On = Body[1]

/** Draws `one` through viewOf with the surface's own elements, from a hook beneath the plugins. */
type Act = (change: Partial<PaneUi>) => void
type Drawing = ViewOptions & { /** Draw with a kit that has no Link element. */ noLink?: boolean; act?: Act }

type Drawn = { type?: string; props?: { display?: string; label?: unknown }; children?: unknown[] }
const shownText = (node: unknown): string => {
  if (typeof node === 'string') return node
  const one = node as Drawn
  if (node === null || typeof node !== 'object' || one.props?.display === 'none') return ''
  if (one.type === 'Button' && typeof one.props?.label === 'string') return one.props.label
  return (one.children ?? []).map(shownText).join('')
}
/** The text of everything drawn and not hidden: the hidden hover cards (tests/hover.test.ts) are left out. */
const visibleText = async (pane: { drawn: () => Promise<unknown> }) => shownText(await pane.drawn())

function draw(on: On, one: InspectedCall | null, ui: PaneUi = CLOSED, options: Drawing = {}) {
  on('ui.render', { component: 'Pane', requestId: 'view-test' }, async ($, e) => {
    const { Box, Text, Code, Button, Link } = $.ui.resolve(e)
    const waiting = one?.status === 'pending' ? 1 : 0
    const { noLink, act, ...rest } = options
    return viewOf({ Box, Text, Code, Button, ...(noLink !== true && { Link }) }, { call: one, waiting }, e.props.bodyColumns, ui, act ?? (() => undefined), { surface: e.surface, links: LINKS, ...rest })
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = async ($: Body[0], on: On, one: InspectedCall | null, ui: PaneUi = CLOSED, options: Drawing = {}) => {
    draw(on, one, ui, options)
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'view-test', props: PANE_PROPS })
  }

  test(`a pending call is readable without presses: no buttons, policy inline (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ summary: SUMMARY }))
    expect(await pane.find({ text: /awaiting|approval/ })).toBeUndefined()
    expect(await pane.find({ text: /^(ran|denied|failed)$/ })).toBeUndefined()
    expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
    // The flags line says it by path while pending; the notes strip says the field's own facts.
    expect(await pane.find({ text: /hits\.results\.excerpt masked/ })).toBeDefined()
    expect(await pane.find({ text: /1 field masked/ })).toBeUndefined()
    expect(await pane.find({ text: /search:confluence/ })).toBeDefined()
    expect(await pane.find({ text: /summary\s·\sHaiku/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test(`a settled call offers raw as a button, and draws no operation text inline (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ summary: SUMMARY, status: 'ran' }))
    expect(await pane.find({ text: /^ran$/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'raw' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'why' })).toBeUndefined()
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
  })

  test(`the raw pane shows the operation with its aliases and variables (${surface})`, async ($, on) => {
    on('ui.render', { component: 'Pane', requestId: 'raw-test' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return RawView({ kit: { Box, Text, Code, Button }, call: call({ summary: SUMMARY, status: 'ran' }), onClose: () => undefined })
    })
    const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'raw-test', props: PANE_PROPS })
    expect(await raw.find({ type: 'Code', text: /hits: confluence_search/ })).toBeDefined()
    expect(await raw.find({ text: /aliases: .*hits/ })).toBeDefined()
    expect(await raw.find({ type: 'Code', text: /query plan/ })).toBeDefined()
    expect(await raw.find({ type: 'Button', key: 'close' })).toBeDefined()
  })

  /** The smallest drawn Box whose text matches: the row a note sits in. */
  const rowOf = async (pane: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }, pattern: RegExp) =>
    (await pane.findAll({ type: 'Box' })).filter(box => pattern.test(box.text)).sort((a, b) => a.text.length - b.text.length)[0]

  for (const status of ['pending', 'ran'] as const) {
    test(`filter arguments carry no model note (${status}, ${surface})`, async ($, on) => {
      const pane = await mount($, on, call({ summary: SUMMARY, status }))
      expect(await rowOf(pane, /cql/)).toBeDefined()
      expect((await rowOf(pane, /cql/))?.text).not.toMatch(/—/)
    })
  }

  test(`the headline sits in a box with its credit; the box is where the call's first words are (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ summary: SUMMARY, status: 'ran' }))
    expect(await rowOf(pane, /Searches Confluence for pages/)).toBeDefined()
    // The credit is an eyebrow: its own dim row above the box, never inside it.
    expect(await pane.find({ text: /^summary · Haiku$/ })).toBeDefined()
    expect(await pane.find({ text: /^╭─+╮$/ })).toBeDefined()
  })

  test(`a masked field is marked with its reason, quietly (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ summary: SUMMARY }))
    // A masked field carries its policy mark in place of a marker, and its reason two cells after it.
    expect(await rowOf(pane, new RegExp(`${GLYPH.mask} excerpt {2}masked`))).toBeDefined()
    expect(await visibleText(pane)).not.toMatch(/—/)
    // Neither scopes nor the model's flags earn a mark.
    expect(await pane.find({ text: new RegExp(`[${GLYPH.attention}${GLYPH.mask}] search:confluence`) })).toBeUndefined()
  })

  test(`a personal-data field is marked, a plain count is not (${surface})`, async ($, on) => {
    const operation = 'query People($cql: String!) { confluence_search(cql: $cql) { results { displayName count } } }'
    const pane = await mount($, on, call({ operation, isEnriched: false }))
    // The one personal-data glyph the pane uses, the notes strip's too.
    expect(await rowOf(pane, new RegExp(`${GLYPH.personal} displayName {2}personal data`))).toBeDefined()
    expect(await pane.find({ text: /count/ })).toBeDefined()
    expect(await pane.find({ text: new RegExp(`[${GLYPH.personal}${GLYPH.attention}] count`) })).toBeUndefined()
    expect(await visibleText(pane)).not.toMatch(/count\s*personal data/)
  })

  test(`drawers stay shut while the call is pending, whatever the UI state says (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ summary: SUMMARY }), { ...CLOSED, field: 'hits.results.excerpt' })
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
    // The field drawer's own label; the description itself is in a hidden hover card (tests/hover.test.ts).
    expect(await pane.find({ text: /^policy$/ })).toBeUndefined()
  })

  test(`a field name opens its drawer once settled; schema text is escaped (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ status: 'ran' }), { ...CLOSED, field: 'hits.results.excerpt' })
    expect(await pane.find({ text: /A short excerpt/ })).toBeDefined()
    expect(await pane.find({ text: /\x1b/ })).toBeUndefined()
    expect(await pane.find({ text: /\\x1b/ })).toBeDefined()
  })

  test(`a root's alias leads its name so the reader can match it to the agent's words (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ status: 'ran' }))
    expect(await pane.find({ text: /hits: / })).toBeDefined()
    expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
  })

  test(`a destructive write with personal data and no limit gets notes (${surface})`, async ($, on) => {
    const operation = 'mutation Clean { jira_deleteIssues(jql: "project = DEV") { deleted { key emailAddress } } }'
    const one = call({ operation, isEnriched: false })
    const pane = await mount($, on, one)
    // A delete says what goes in its CHANGES block (not again as a flag); a personal field is a notes line of its own.
    expect(await pane.find({ text: /^-$/ })).toBeDefined()
    expect(await pane.find({ text: /personal data/ })).toBeDefined()
    expect(await pane.find({ text: /looks safe|nothing unusual/ })).toBeUndefined()
  })

  test(`a settled call shows RESULT: rows against the total, errors, denials and auth links (${surface})`, async ($, on) => {
    const outcome = {
      rows: [{ field: 'results', count: 10, total: 3766 }],
      errors: [
        { message: 'Upstream exploded \u001b[31m', code: 'INTERNAL', path: 'hits.totalSize' },
        { message: 'masked', path: 'hits.results.excerpt', isDenied: true },
      ],
      authLinks: [{ service: 'confluence', url: 'https://example.atlassian.net/link' }],
    }
    const pane = await mount($, on, { ...call({ status: 'ran' }), outcome })
    expect(await pane.find({ text: /^RESULT$/ })).toBeDefined()
    expect(await pane.find({ text: /10 of 3,766/ })).toBeDefined()
    expect(await pane.find({ text: /INTERNAL at totalSize/ })).toBeDefined()
    expect(await pane.find({ text: /excerpt denied/ })).toBeDefined()
    expect(await pane.find({ text: /\x1b/ })).toBeUndefined()
    // Settled, the auth link is a button that asks the host to open it.
    expect(await pane.find({ type: 'Button', text: /link confluence/ })).toBeDefined()
  })

  test(`a link that is not canonical https is drawn as text, never as a Link (${surface})`, async ($, on) => {
    const outcome = { rows: [], errors: [], authLinks: [{ service: 'jira', url: 'javascript:alert(1)' }] }
    const pane = await mount($, on, { ...call({ status: 'ran' }), outcome })
    expect(await pane.find({ text: /link jira/ })).toBeDefined()
    // The auth link is text; the only Link is the deep link, to a canonical https URL.
    for (const link of await pane.findAll({ type: 'Link' })) expect(JSON.stringify(link)).not.toMatch(/javascript:/)
  })

  test(`a call refused at the dialog shows no RESULT even with an outcome recorded (${surface})`, async ($, on) => {
    const outcome = { rows: [{ field: 'results', count: 10 }], errors: [], authLinks: [] }
    const pane = await mount($, on, { ...call({ status: 'denied' }), outcome })
    expect(await pane.find({ text: /^RESULT$/ })).toBeUndefined()
  })

  test(`a pending call has no RESULT and no buttons (${surface})`, async ($, on) => {
    const outcome = { rows: [{ field: 'results', count: 10 }], errors: [], authLinks: [] }
    const pane = await mount($, on, { ...call(), outcome })
    expect(await pane.find({ text: /^RESULT$/ })).toBeUndefined()
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test(`RETURNS draws each level of the selection as a level: totalSize beside results, not under it (${surface})`, async ($, on) => {
    const pane = await mount($, on, call())
    // Each RETURNS row starts with its tree guide; a level is the guide's depth.
    const guide = `[${Object.values(TREE).join('')}]`
    const guides = (await pane.findAll({ type: 'Text' })).map(text => text.text).filter(text => new RegExp(`^${guide}+$`).test(text) && /\S/.test(text))
    const rows = await pane.findAll({ type: 'Box' })
    const levelOf = (name: string) => {
      const row = rows.find(box => {
        const first = box.children[0] as { type?: string; children?: { text?: string; children?: unknown[] }[] } | undefined
        return first?.type === 'Box' && new RegExp(`^${guide}+${name}\\b`).test(box.text)
      })
      return row === undefined ? undefined : new RegExp(`^${guide}+`).exec(row.text)?.[0].length
    }
    expect(guides.length).toBeGreaterThan(0)
    const results = levelOf('results')
    const total = levelOf('totalSize')
    const title = levelOf('title')
    expect(results).toBeDefined()
    expect(total).toBe(results)
    expect(title).toBeGreaterThan(results ?? Infinity)
  })

  test(`with no call yet the pane says how to open it (${surface})`, async ($, on) => {
    const empty = await mount($, on, null, CLOSED, { bodyRows: 30 })
    expect(await empty.find({ text: /No GraphOS Agent Services call yet/ })).toBeDefined()
    expect(await empty.find({ text: /^\/gas$/ })).toBeDefined()
  })

  test(`analyzing shows the root right away and says policy is still being checked (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ isEnriched: false }))
    expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
    expect(await pane.find({ text: /checking policy/ })).toBeDefined()
  })

  test(`a call that will fail shows its diagnostics (${surface})`, async ($, on) => {
    const diagnostics = ['Error: Cannot query field "excrpt" on type "Confluence_SearchResultItem".\n  at line 3']
    const pane = await mount($, on, call({ validation: { valid: false, diagnostics } }))
    expect(await pane.find({ text: /will fail/ })).toBeDefined()
    expect(await pane.find({ text: /Cannot query field "excrpt"/ })).toBeDefined()
  })

  test(`an unparseable operation is shown as sent (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ operation: 'query { confluence_search(cql: "x" { title }' }))
    expect(await pane.find({ text: /Could not read this operation/ })).toBeDefined()
    expect(await pane.find({ type: 'Code', text: /confluence_search\(cql/ })).toBeDefined()
  })
}

// ---- The integration pass: type facts, links, preview, history, honest unknowns

/** The call with every field's policy unknown, as when dry_run never answered. */
function unchecked(one: InspectedCall, checks: NonNullable<InspectedCall['ir']['checks']>): InspectedCall {
  const clear = (field: InspectedCall['ir']['roots'][number]): InspectedCall['ir']['roots'][number] => ({ ...field, policy: 'unknown', children: field.children.map(clear) })
  return { ...one, ir: { ...one.ir, state: 'partial', checks, roots: one.ir.roots.map(clear) } }
}

/** The call with no scope anywhere in its schema. */
function withoutScopes(one: InspectedCall): InspectedCall {
  const strip = (field: InspectedCall['ir']['roots'][number]): InspectedCall['ir']['roots'][number] => ({
    ...field,
    ...(field.schema !== undefined && { schema: { ...field.schema, scopes: [] } }),
    children: field.children.map(strip),
  })
  return { ...one, ir: { ...one.ir, roots: one.ir.roots.map(strip) } }
}

const PREVIEW = {
  rows: [{ field: 'results', count: 5, total: 3766 }],
  preview: [
    {
      field: 'results',
      items: [
        { label: 'Query planning overview', extra: '2026-09-30' },
        { label: 'Plan caching \u001b[31mred', extra: 'Eng' },
      ],
      more: 3,
    },
  ],
  scalars: [
    { field: 'count', value: 1342 },
    { field: 'hasMoreResults', value: true },
  ],
  errors: [],
  authLinks: [],
}

const NAV = { count: 12, position: 3, isLive: false, older: 3, newer: 1 }

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = async ($: Body[0], on: On, one: InspectedCall | null, ui: PaneUi = CLOSED, options: Drawing = {}) => {
    draw(on, one, ui, options)
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'view-test', props: PANE_PROPS })
  }

  for (const status of ['pending'] as const) {
    test(`a deep link is drawn as a Link to an https URL while pending (${status}, ${surface})`, async ($, on) => {
      const pane = await mount($, on, call({ status }))
      // Said as what it opens and where, not a bare `Open in`.
      const link = await pane.find({ type: 'Link', text: /this search in Confluence/ })
      expect(link).toBeDefined()
      expect(JSON.stringify(link)).toMatch(/"href":"https:\/\/[^"]+\/wiki\/search\?cql=/)
    })
  }

  test(`once settled a deep link is a button, not a Link; pending it stays a Link (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ status: 'ran' }))
    expect(await pane.find({ type: 'Link', text: /this search in Confluence/ })).toBeUndefined()
    expect(await pane.find({ type: 'Button', text: /this search in Confluence/ })).toBeDefined()
  })

  test(`without a Link element the URL is dim text (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ status: 'pending' }), CLOSED, { noLink: true })
    expect(await pane.find({ type: 'Link' })).toBeUndefined()
    // The label as links are written, the URL beside it as text to copy.
    expect(await pane.find({ text: /\[[^\]]*in Confluence\]/ })).toBeDefined()
    expect(await pane.find({ text: /^ https:\/\// })).toBeDefined()
  })

  test(`a settled call previews what came back, escaped, and its scalars (${surface})`, async ($, on) => {
    const pane = await mount($, on, { ...call({ status: 'ran' }), outcome: PREVIEW })
    expect(await pane.find({ text: /Query planning overview/ })).toBeDefined()
    expect(await pane.find({ text: /2026-09-30/ })).toBeDefined()
    expect(await pane.find({ text: /… 3 more/ })).toBeDefined()
    expect(await pane.find({ text: /\x1b/ })).toBeUndefined()
    expect(await pane.find({ text: /Plan caching \\x1b\[31mred/ })).toBeDefined()
    expect(await pane.find({ text: /count\s+1,342/ })).toBeDefined()
    expect(await pane.find({ text: /more (results )?available/ })).toBeDefined()
  })

  test(`a settled Jira search makes each linked preview item a button; one with no link is plain text (${surface})`, async ($, on) => {
    const jira = buildIR('t', normalize('query { issues: jira_searchIssues(jql: "project = DEV") { issues { key summary } } }', {}))
    const outcome = outcomeOf(
      jira,
      JSON.stringify({ data: { issues: { issues: [{ key: 'DEV-1', summary: 'First' }, { key: 'DEV-2', summary: 'Second' }, { summary: 'No key' }] } } }),
      LINKS,
    )
    const settled = { ...call({ status: 'ran' }), outcome }
    const pane = await mount($, on, settled)
    // The key is the link; the summary follows it as text.
    expect(await pane.find({ type: 'Button', text: /DEV-1/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /DEV-2/ })).toBeDefined()
    expect(await pane.find({ text: /First/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /No key/ })).toBeUndefined()
    expect(await pane.find({ text: /No key/ })).toBeDefined()
  })

  test(`a linked preview item is plain text when the kit has no Link element (${surface})`, async ($, on) => {
    const jira = buildIR('t', normalize('query { issues: jira_searchIssues(jql: "project = DEV") { issues { key summary } } }', {}))
    const outcome = outcomeOf(jira, JSON.stringify({ data: { issues: { issues: [{ key: 'DEV-1', summary: 'First' }] } } }), LINKS)
    const pane = await mount($, on, { ...call({ status: 'ran' }), outcome }, CLOSED, { noLink: true })
    expect(await pane.find({ type: 'Link' })).toBeUndefined()
    expect(await pane.find({ text: /First/ })).toBeDefined()
  })

  test(`a pending call shows no preview (${surface})`, async ($, on) => {
    const pane = await mount($, on, { ...call(), outcome: PREVIEW })
    expect(await pane.find({ text: /Query planning overview/ })).toBeUndefined()
  })

  test(`the history sits in the header for a settled call with a history, and no footer keys remain (${surface})`, async ($, on) => {
    const settled = await mount($, on, call({ status: 'ran' }), CLOSED, { nav: NAV })
    for (const key of ['older', 'newer']) expect(await settled.find({ type: 'Button', key })).toBeDefined()
    expect(await settled.find({ type: 'Button', key: 'live' })).toBeUndefined()
    expect(await settled.find({ text: /\d+\/12|[◦◉]{3}/ })).toBeDefined()
    // The keys row of the old footer is gone: no `r: raw ▸`, no `older` words.
    expect(await settled.find({ text: /raw ▸|‹ older|newer ›/ })).toBeUndefined()
  })

  test(`pending: the history is passive, never a button (${surface})`, async ($, on) => {
    const pending = await mount($, on, call(), CLOSED, { nav: { ...NAV, position: 12, isLive: true } })
    expect(await pending.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await pending.find({ text: /12\/12|◉/ })).toBeDefined()
  })

  test(`no history controls with a single call, raw stays (${surface})`, async ($, on) => {
    const alone = await mount($, on, call({ status: 'ran' }))
    for (const key of ['older', 'newer', 'live']) expect(await alone.find({ type: 'Button', key })).toBeUndefined()
    expect(await alone.find({ type: 'Button', key: 'raw' })).toBeDefined()
  })

  test(`a past call says so and steps newer, with no separate live button (${surface})`, async ($, on) => {
    const past = await mount($, on, call({ status: 'ran' }), CLOSED, { nav: NAV })
    expect(await past.find({ text: /earlier call/ })).toBeDefined()
    expect(await past.find({ type: 'Button', key: 'newer' })).toBeDefined()
    expect(await past.find({ type: 'Button', key: 'live' })).toBeUndefined()
  })

  test(`the live call does not say earlier, and has no live button (${surface})`, async ($, on) => {
    const live = await mount($, on, call({ status: 'ran' }), CLOSED, { nav: { count: 12, position: 12, isLive: true, older: 1 } })
    expect(await live.find({ text: /earlier call/ })).toBeUndefined()
    expect(await live.find({ type: 'Button', key: 'live' })).toBeUndefined()
    expect(await live.find({ type: 'Button', key: 'older' })).toBeDefined()
  })

  test(`with no scope anywhere the policy card says so, and the pane itself does not (${surface})`, async ($, on) => {
    const pane = await mount($, on, withoutScopes(call()))
    expect(await pane.find({ text: /no scopes required by the schema/ })).toBeDefined()
    expect(await visibleText(pane)).not.toMatch(/no scopes/)
  })

  test(`an unavailable policy says why, escaped and short (${surface})`, async ($, on) => {
    const error = `Agent Services dry_run: 503 \u001b[31m ${'x'.repeat(200)}`
    const pane = await mount($, on, unchecked(call(), { policy: 'failed', validation: 'ok', schema: 'ok', error }))
    expect(await pane.find({ text: /policy (and schema )?not checked/ })).toBeDefined()
    expect(await pane.find({ text: /503 \\x1b\[31m/ })).toBeDefined()
    expect(await visibleText(pane)).not.toMatch(/x{80}/)
    expect(await pane.find({ text: /\x1b/ })).toBeUndefined()
    // No meter and no counts when no policy is known.
    expect(await pane.find({ text: /▰/ })).toBeUndefined()
  })

  test(`access not checked, when dry_run was not allowed, says how to check (${surface})`, async ($, on) => {
    const pane = await mount($, on, unchecked(call(), { policy: 'not-allowed', validation: 'ok', schema: 'ok' }))
    expect(await pane.find({ text: /access not checked/ })).toBeDefined()
    expect(await pane.find({ text: /allow Agent Services dry_run to check/ })).toBeDefined()
  })

  test(`access not checked, when no service claims the roots, says so (${surface})`, async ($, on) => {
    const pane = await mount($, on, unchecked(call(), { policy: 'skipped', validation: 'ok', schema: 'ok' }))
    expect(await pane.find({ text: /no service in Agent Services claims it/ })).toBeDefined()
    expect(await pane.find({ text: /span services/ })).toBeUndefined()
  })

  test(`the header says it in words, with a meter, and never uses 'degraded' (${surface})`, async ($, on) => {
    const summary = SUMMARY
    const pane = await mount($, on, call({ status: 'pending', summary }))
    // Terse: the allowed count and the masked count by glyph; DENIED is the one loud word.
    expect(await pane.find({ text: /^✓ 3$/ })).toBeDefined()
    expect(await pane.find({ text: /^◐ 1$/ })).toBeDefined()
    expect(await pane.find({ text: /▰{3,}/ })).toBeDefined()
    expect(await pane.find({ text: /degraded/i })).toBeUndefined()
  })

  test(`a settled pane never says 'degraded' either (${surface})`, async ($, on) => {
    const pane = await mount($, on, call({ status: 'ran', summary: SUMMARY }))
    expect(await pane.find({ text: /degraded/i })).toBeUndefined()
  })

  test(`objects read as objects, and names carry no type jargon (${surface})`, async ($, on) => {
    const pane = await mount($, on, call())
    expect(await pane.find({ text: /^ \{ $/ })).toBeDefined()
    expect(await pane.find({ text: /^ \}$/ })).toBeDefined()
    expect(await pane.find({ text: /content: id/ })).toBeUndefined()
    // No `!` after a never-null name, no `(each present)` on a list of them.
    const text = await visibleText(pane)
    expect(text).not.toMatch(/\w!/)
    expect(text).not.toMatch(/each present/)
  })

  test(`a headline still being written shimmers where it will land (${surface})`, async ($, on) => {
    const reading = call()
    const pane = await mount($, on, { ...reading, ir: { ...reading.ir, isSummarizing: true } })
    expect(await pane.find({ text: /^✻$/ })).toBeDefined()
  })

  test(`the fallback headline stays still once the summary has failed (${surface})`, async ($, on) => {
    const pane = await mount($, on, call())
    expect(await pane.find({ text: /^✻$/ })).toBeUndefined()
  })

  test(`a pending call with no summary and no list limit still draws a shimmering headline row (${surface})`, async ($, on) => {
    const bare = call({ operation: '{ confluence_search(cql: "x") { totalSize } }', isEnriched: false })
    const pane = await mount($, on, { ...bare, ir: { ...bare.ir, isSummarizing: true } })
    expect(await pane.find({ text: /^✻$/ })).toBeDefined()
    expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
  })

  test(`after a summary failure the headline row stays, still and dim (${surface})`, async ($, on) => {
    const bare = call({ operation: '{ confluence_search(cql: "x") { totalSize } }', isEnriched: false })
    const pane = await mount($, on, bare)
    expect(await pane.find({ text: /^confluence_search$/ })).toBeDefined()
  })

  test(`a queue says 'N of M' while pending, and nothing else about status (${surface})`, async ($, on) => {
    on('ui.render', { component: 'Pane', requestId: 'view-test' }, async ($$, e) => {
      const { Box, Text, Code } = $$.ui.resolve(e)
      return viewOf({ Box, Text, Code }, { call: call(), waiting: 3 }, e.props.bodyColumns)
    })
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'view-test', props: PANE_PROPS })
    expect(await pane.find({ text: /1 of 3/ })).toBeDefined()
    expect(await pane.find({ text: /awaiting|approval/ })).toBeUndefined()
  })

  test(`counts cover visible data fields only; all-allowed says so (${surface})`, async ($, on) => {
    const one = call()
    const allow = (fields: typeof one.ir.roots): typeof one.ir.roots => fields.map(f => ({ ...f, policy: 'allow' as const, children: allow(f.children) }))
    const pane = await mount($, on, { ...one, ir: { ...one.ir, roots: allow(one.ir.roots) } })
    // title, excerpt, url, lastModified, content.id, content.type, totalSize
    expect(await pane.find({ text: /✓ all 7 allowed/ })).toBeDefined()
    expect(await pane.find({ text: /MASKED/ })).toBeUndefined()
  })

  test(`paging names the argument and field that continue the list (${surface})`, async ($, on) => {
    const one = call()
    const [root] = one.ir.roots
    const paged = { ...one, ir: { ...one.ir, roots: [{ ...root!, paging: { kind: 'cursor' as const, via: ['cursor'], isFirstPage: true, moreField: 'next' } }] } }
    const pane = await mount($, on, paged)
    expect(await pane.find({ text: /first page · next page: cursor ← next/ })).toBeDefined()
    expect(await pane.find({ text: /more via/ })).toBeUndefined()
  })

  test(`constraint hints live in the hover card only; value ranges stay inline (${surface})`, async ($, on) => {
    const one = call()
    const [root] = one.ir.roots
    const hinted = { ...one, ir: { ...one.ir, roots: [{ ...root!, schema: { ...root!.schema!, hints: ['requires a bounded query', 'max 100'] } }] } }
    const pane = await mount($, on, hinted)
    expect(await pane.find({ text: /needs a filter/ })).toBeUndefined()
    expect(await pane.find({ text: /max 100/ })).toBeDefined()
    // The hover card (in the tree, shown on hover) keeps the schema's own words.
    expect(await pane.find({ text: /requires a bounded query/ })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mountOf = async ($: Body[0], on: On, one: InspectedCall) => {
    draw(on, one)
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'view-test', props: PANE_PROPS })
  }

  test(`a response with errors and no data reads as errors, not ran (${surface})`, async ($, on) => {
    const outcome = {
      rows: [],
      errors: [{ message: 'Glean request failed', code: 'CONNECTOR_FETCH', path: 'hits' }],
      authLinks: [],
      hasData: false,
    }
    const pane = await mountOf($, on, { ...call({ status: 'ran' }), outcome })
    expect(await pane.find({ text: /^errors$/ })).toBeDefined()
    expect(await pane.find({ text: /^ran$/ })).toBeUndefined()
  })

  test(`a response with data and one error reads ran with the error count (${surface})`, async ($, on) => {
    const outcome = { rows: [{ field: 'results', count: 2 }], errors: [{ message: 'one field failed', path: 'hits.totalSize' }], authLinks: [], hasData: true }
    const pane = await mountOf($, on, { ...call({ status: 'ran' }), outcome })
    expect(await pane.find({ text: /^ran · 1 error$/ })).toBeDefined()
  })

  test(`a response with data and no errors still reads ran (${surface})`, async ($, on) => {
    const outcome = { rows: [{ field: 'results', count: 2 }], errors: [], authLinks: [], hasData: true }
    const pane = await mountOf($, on, { ...call({ status: 'ran' }), outcome })
    expect(await pane.find({ text: /^ran$/ })).toBeDefined()
  })

  test(`a result that is not a GraphQL response reads as errors and says what came back (${surface})`, async ($, on) => {
    const one = call({ status: 'ran' })
    const pane = await mountOf($, on, { ...one, outcome: outcomeOf(one.ir, 'upstream confluence timed out after 30s') })
    expect(await pane.find({ text: /^errors$/ })).toBeDefined()
    expect(await pane.find({ text: /^ran$/ })).toBeUndefined()
    expect(await visibleText(pane)).toMatch(/timed out after 30s/)
  })

  test(`a response that is only a sign-in to finish says it needs one, not ran (${surface})`, async ($, on) => {
    const one = call({ status: 'ran' })
    const auth = { data: null, errors: [{ message: 'Authorization required', path: [], extensions: { code: 'UPSTREAM_AUTH_REQUIRED', sources: [{ name: 'confluence', authorizationUrl: 'https://auth.example/link/confluence' }] } }] }
    const pane = await mountOf($, on, { ...one, outcome: outcomeOf(one.ir, JSON.stringify(auth)) })
    expect(await pane.find({ text: /needs sign-in/ })).toBeDefined()
    expect(await pane.find({ text: /^ran$/ })).toBeUndefined()
  })

  test(`a response kept out of Claude's context still reads ran (${surface})`, async ($, on) => {
    const one = call({ status: 'ran' })
    const stand = '<persisted-output>\nOutput too large (58.2KB). Full output saved to: /Users/x/.claude/projects/-p/abc/tool-results/t.json\n\nPreview (first 2KB):\n...\n</persisted-output>'
    const pane = await mountOf($, on, { ...one, outcome: outcomeOf(one.ir, stand) })
    expect(await pane.find({ text: /^ran$/ })).toBeDefined()
  })

  test(`object and list arguments draw as rows, not raw JSON (${surface})`, async ($, on) => {
    const operation = `{ hits: confluence_search(cql: "a", filters: [{fieldName: "type", values: [{value: "page"}, {value: "document"}]}]) { totalSize } }`
    const pane = await mountOf($, on, call({ operation, status: 'ran' }))
    expect(await pane.find({ text: /fieldName/ })).toBeDefined()
    expect(await pane.find({ text: /page · document/ })).toBeDefined()
    expect(await visibleText(pane)).not.toMatch(/\{"fieldName"/)
  })
}
