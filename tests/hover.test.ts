// Hover cards on field names, on both surfaces. Behaviour only: the card's
// text is in the drawn tree, hidden until its name's hover group is lit; the
// name carries that group (pending and settled alike); the cards draw in one
// absolute layer, each popping up beside what lit it, toward the room in
// view; schema text is escaped.

import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { CallStatus, InspectedCall } from '../types'
import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import { normalize } from '../src/normalize.ts'
import { indexSdl } from '../src/schema.ts'
import { renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, planFor, viewOf } from '../src/view.tsx'
import { cardId } from '../src/view/plan.ts'
import { hoverScope } from '../src/view/ui/hover.tsx'
import { gnarlyCall, heavyCall, keptOutCall, persistedCall, reviewCall, titlesCall } from './review-fixtures.ts'
import { LINKS, SITE } from '../test/unit/link-fixture.ts'

const OPERATION = `query Search($cql: String!) {
  hits: confluence_search(cql: $cql, limit: 10) {
    results { title excerpt url secret }
    totalSize
  }
}`
const VARIABLES = { cql: 'type=page' }

const SDL = [
  `type Query {
    "Search Confluence with CQL. Requires the search:confluence scope."
    confluence_search(
      "Query in CQL.\\u001b[31m Requires a bounded query."
      cql: String!
      "Page size, max 50."
      limit: Int = 25
      sort: Confluence_Sort
      start: Int = 0
    ): Confluence_SearchResults
  }`,
  `enum Confluence_Sort { RELEVANCE CREATED }`,
  `type Confluence_SearchResults { results: [Confluence_SearchResultItem!]! totalSize: Int }`,
  `type Confluence_SearchResultItem {
    title: String
    "A short excerpt.\\u001b[31m Now red."
    excerpt: String
    url: String @deprecated(reason: "Use links.webui")
    secret: String
  }`,
]

function call(status: CallStatus): InspectedCall {
  const fields = new Map<string, FieldDecision>([
    ['hits.results.excerpt', { decision: 'mask' }],
    ['hits.results.secret', { decision: 'deny' }],
  ])
  for (const path of ['hits', 'hits.results', 'hits.results.title', 'hits.results.url', 'hits.totalSize']) fields.set(path, { decision: 'allow' })
  const ir = annotate(buildIR('toolu_hover', normalize(OPERATION, VARIABLES)), {
    schema: indexSdl(SDL),
    access: { denyOperation: false, fields },
    validation: { valid: true, diagnostics: [] },
    scope: 'confluence',
    isIncomplete: false,
    checks: { policy: 'ok', validation: 'ok', schema: 'ok' },
  })
  return {
    id: 'toolu_hover',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation: OPERATION,
    variables: JSON.stringify(VARIABLES),
    status,
    arrivedAt: Date.UTC(2026, 9, 5),
    ir,
    ...(status === 'ran' && {
      outcome: {
        rows: [{ field: 'results', count: 7, total: 120 }],
        scalars: [{ field: 'totalSize', value: 120 }],
        errors: [{ message: 'denied', isDenied: true, field: 'secret', count: 7, of: 7, classification: 'pii-high', isRequestable: true }],
        authLinks: [],
      },
    }),
  }
}

const PANE_PROPS = {
  title: 'GraphOS Inspector',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

type Body = Parameters<Extract<Parameters<typeof test>[1], Function>>

/** Every element of a drawn tree, depth first. */
function elements(node: unknown): RenderElement[] {
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const element = node as RenderElement
  const children = 'children' in element && Array.isArray(element.children) ? element.children : []
  return [element, ...children.flatMap(elements)]
}

/** The text an element shows, its descendants' included; a card's line break (and the indent after it) reads as a space. */
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

/** The hover card whose text matches, and the name (Text or Button) lighting its group. */
function cardFor(tree: RenderElement, text: RegExp) {
  const all = elements(tree)
  const card = all.find(element => isCard(element) && text.test(textOf(element)))
  const scope = card === undefined ? undefined : hoverOf(card)?.scope
  const trigger = all.find(element => !isCard(element) && element.type !== 'Box' && scope !== undefined && hoverOf(element)?.scope === scope)
  return { card, trigger, scope }
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = async ($: Body[0], on: Body[1], one: InspectedCall) => {
    on('ui.render', { component: 'Pane', requestId: 'hover-test' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code, Button }, { call: one, waiting: 1 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, links: LINKS })
    })
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'hover-test', props: PANE_PROPS })
  }

  test(`while pending, a field name carries a hidden hover card with its details (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('pending'))
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
    const { card, trigger, scope } = cardFor(await pane.drawn(), /\.excerpt · String/)
    expect(card).toBeDefined()
    if (card === undefined) return
    expect(textOf(card)).toMatch(/A short excerpt/)
    expect(textOf(card)).toMatch(/ MASKED /)
    // Hidden until hovered: drawn `display: none`, revealed by its group.
    expect(propsOf(card).display).toBe('none')
    expect(hoverOf(card)?.display).toBe('flex')
    // The name itself lights the group: a Text, no press involved.
    expect(trigger?.type).toBe('Text')
    expect(textOf(trigger)).toBe('excerpt')
    expect(hoverOf(trigger as RenderElement)).toMatchObject({ scope, inverse: true })
  })

  test(`the card's description is escaped, quoted and dimmed (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('pending'))
    const tree = await pane.drawn()
    const { card } = cardFor(tree, /\.excerpt · String/)
    const shown = textOf(card)
    expect(shown).toMatch(/\\x1b\[31m/)
    expect(shown).not.toMatch(/\x1b/)
    expect(shown).toMatch(/“A short excerpt/)
    expect(elements(card).some(element => element.type === 'Text' && propsOf(element).dimColor === true && /A short excerpt|\\x1b/.test(textOf(element)))).toBe(true)
    expect(elements(tree).some(element => /\x1b/.test(textOf(element)))).toBe(false)
  })

  test(`cards say denied, deprecated, and the root's scopes and type (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('pending'))
    const tree = await pane.drawn()
    expect(textOf(cardFor(tree, /\.secret · String/).card)).toMatch(/ DENIED /)
    expect(textOf(cardFor(tree, /\.url · String/).card)).toMatch(/deprecated\s+Use links\.webui/)
    const root = cardFor(tree, /confluence_search · Confluence_SearchResults/)
    expect(textOf(root.card)).toMatch(/search:confluence/)
    expect(textOf(root.trigger)).toBe('confluence_search')
    // A plain field still gets a card.
    expect(cardFor(tree, /\.title · String/).card).toBeDefined()
  })

  test(`once settled, the name is a Button that lights the same card (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('ran'))
    const { card, trigger, scope } = cardFor(await pane.drawn(), /\.excerpt · String/)
    expect(card).toBeDefined()
    expect(propsOf(card as RenderElement).display).toBe('none')
    expect(trigger?.type).toBe('Button')
    expect(hoverOf(trigger as RenderElement)).toMatchObject({ scope, inverse: true })
  })

  test(`a record row lights a tip with the URL it opens, on its own panel; a row with no link has none (${surface})`, async ($, on) => {
    on('ui.render', { component: 'Pane', requestId: 'hover-tip' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code, Button }, { call: reviewCall('ran'), waiting: 0 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, links: LINKS, bodyRows: e.props.scroll.bodyRows, scrollOffset: e.props.scroll.offset })
    })
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'hover-tip', props: { ...PANE_PROPS, bodyColumns: 84 } })
    const all = elements(await pane.drawn())
    const rows = all.filter(element => element.type === 'Button' && /^\[DEV-\d+\]$/.test(textOf(element)))
    expect(rows).toHaveLength(5)
    const tips = all.filter(element => element.type === 'Box' && propsOf(element).display === 'none' && /^↗ https:\/\//.test(textOf(element)))
    expect(tips).toHaveLength(5)
    for (const row of rows) {
      const scope = hoverOf(row)?.scope
      const tip = tips.filter(one => hoverOf(one)?.scope === scope)
      // One tip per row, lit with the row, saying exactly where its press goes, opaque over the rows beneath.
      expect(tip).toHaveLength(1)
      expect(textOf(tip[0])).toBe(`↗ ${SITE}/browse/${textOf(row).slice(1, -1)}`)
      expect(propsOf(tip[0]).position).toBe('absolute')
      expect(typeof propsOf(tip[0]).backgroundColor).toBe('string')
    }
    // The members have no record link: no tip names them.
    expect(all.some(element => element.type === 'Box' && /^↗ .*mem_/.test(textOf(element)))).toBe(false)
  })

  test(`with Markdown, a record key is a link a plain click presses, and its tip covers only its own row (${surface})`, async ($, on) => {
    on('ui.render', { component: 'Pane', requestId: 'hover-markdown' }, async ($, e) => {
      const elements = $.ui.resolve(e)
      const { Box, Text, Code, Button } = elements
      const Markdown = 'Markdown' in elements ? elements.Markdown : undefined
      return viewOf({ Box, Text, Code, Button, ...(Markdown !== undefined && { Markdown }) }, { call: reviewCall('ran'), waiting: 0 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, links: LINKS })
    })
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'hover-markdown', props: { ...PANE_PROPS, bodyColumns: 84 } })
    const all = elements(await pane.drawn())
    // Each key is bracketed inline code inside the link, so it draws in a fixed blue, not the palette's.
    const keys = all.filter(element => element.type === 'Markdown' && /^\[`\[DEV-\d+\]`\]/.test(String(propsOf(element).text)))
    expect(keys).toHaveLength(5)
    for (const key of keys) {
      const { text, pressableLinks } = propsOf(key) as { text: string; pressableLinks: string[] }
      const url = /\(<(https:[^>]+)>\)$/.exec(text)?.[1]
      expect(url).toMatch(/^https:\/\/example\.atlassian\.net\/browse\/DEV-\d+$/)
      // Only this record's link answers the press.
      expect(pressableLinks).toEqual([url])
    }
    // Each tip sits on its own row's first line, so it covers that row and no other, and a click on it opens the same record.
    const tips = all.filter(element => element.type === 'Box' && String(propsOf(element).key ?? '').startsWith('tip:'))
    expect(tips).toHaveLength(5)
    for (const tip of tips) {
      expect(propsOf(tip).top).toBe(0)
      const link = elements(tip).find(element => element.type === 'Markdown')
      expect(String(propsOf(link).text)).toMatch(/^\[`↗ https:\/\/example\.atlassian\.net\/browse\/DEV-\d+`\]/)
      expect((propsOf(link).pressableLinks as string[])[0]).toMatch(/\/browse\/DEV-\d+$/)
    }
  })

  test(`nothing masked or denied: no meter, and a quiet \`✓ all N allowed\` lights the policy card (${surface})`, async ($, on) => {
    // A call the response denied nothing of: with the denials Agent Services sent, "all" would overclaim (below).
    const { outcome, ...base } = reviewCall('ran')
    const allow = (fields: typeof base.ir.roots): typeof base.ir.roots => fields.map(field => ({ ...field, policy: 'allow' as const, children: allow(field.children) }))
    const pane = await mount($, on, { ...base, ir: { ...base.ir, roots: allow(base.ir.roots) } })
    const tree = await pane.drawn()
    expect(await pane.find({ text: /[▰▱]/ })).toBeUndefined()
    const { card, trigger } = cardFor(tree, /^policy · \d+ fields/)
    expect(textOf(trigger)).toMatch(/^✓ all \d+ allowed$/)
    expect(textOf(card)).toContain('no scopes required by the schema')
  })

  test(`policy allowed every field but the response denied one: the row counts them and does not say all (${surface})`, async ($, on) => {
    const base = reviewCall('ran')
    const allow = (fields: typeof base.ir.roots): typeof base.ir.roots => fields.map(field => ({ ...field, policy: 'allow' as const, children: allow(field.children) }))
    const pane = await mount($, on, { ...base, ir: { ...base.ir, roots: allow(base.ir.roots) } })
    const { trigger } = cardFor(await pane.drawn(), /^policy · \d+ fields/)
    expect(textOf(trigger)).toMatch(/^\d+ allowed$/)
    expect(textOf(trigger)).not.toMatch(/\ball\b|✓/)
  })

  test(`a record row with nothing after its key gets its tip after the key, on the key's last row (${surface})`, async ($, on) => {
    const pane = await mount($, on, titlesCall())
    const all = elements(await pane.drawn())
    const tips = all.filter(element => element.type === 'Box' && String(propsOf(element).key ?? '').startsWith('tip:'))
    // The two short keys leave room beside them; the two long ones wrap across the row and leave none at 50 columns.
    expect(tips.length).toBeGreaterThan(0)
    for (const tip of tips) {
      expect(textOf(tip)).toMatch(/^↗ (https:\/\/)?example\.atlassian\.net\/browse\//)
      expect(propsOf(tip).bottom).toBe(0)
      expect(Number(propsOf(tip).left)).toBeGreaterThan(4)
    }
  })

  test(`cards are out of the flow, each on an opaque panel, with no wrapper; unlit, nothing out of the flow takes a row (${surface})`, async ($, on) => {
    // Settled, with record rows: their URL tips are out of the flow too.
    const pane = await mount($, on, reviewCall('ran'))
    const all = elements(await pane.drawn())
    const cards = all.filter(isCard)
    expect(cards.length).toBeGreaterThan(0)
    // Out of the flow, so showing one moves no row; and inside no other absolute Box, which the engine clips to its own (empty) bounds.
    const absolute = all.filter(element => element.type === 'Box' && propsOf(element).position === 'absolute')
    for (const card of cards) expect(propsOf(card).position).toBe('absolute')
    for (const box of absolute) expect(elements(box).slice(1).some(isCard)).toBe(false)
    // The pointer on an absolute Box counts as on its parent: one spanning rows while nothing is lit would take it off every trigger beneath.
    for (const box of absolute) expect(propsOf(box).display === 'none' || propsOf(box).height === 0).toBe(true)
    // Each card paints its own background, so the rows beneath do not show through.
    for (const card of cards) expect(elements(card).some(element => element.type === 'Box' && typeof propsOf(element).backgroundColor === 'string')).toBe(true)
  })

  test(`a folded object's \`… N fields\` lights a card listing every field with its type and policy (${surface})`, async ($, on) => {
    on('ui.render', { component: 'Pane', requestId: 'hover-fold' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      // Short enough that RETURNS collapses; too narrow for the fields to fit inline.
      return viewOf({ Box, Text, Code, Button }, { call: call('pending'), waiting: 1 }, 40, CLOSED, () => undefined, { surface: e.surface, links: LINKS, bodyRows: 14 })
    })
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'hover-fold', props: PANE_PROPS })
    const all = elements(await pane.drawn())
    const fold = all.find(element => element.type === 'Text' && /… \d+ fields/.test(textOf(element)) && hoverOf(element)?.scope !== undefined)
    expect(fold).toBeDefined()
    const scope = hoverOf(fold as RenderElement)?.scope
    const card = all.find(element => isCard(element) && hoverOf(element)?.scope === scope)
    expect(card).toBeDefined()
    expect(propsOf(card).display).toBe('none')
    const text = textOf(card)
    for (const name of ['title', 'excerpt', 'url', 'secret']) expect(text).toMatch(new RegExp(name))
    expect(text).toMatch(/secret\s+String\s+denied/)
    expect(text).toMatch(/excerpt\s+String\s+masked/)
  })

}

/** The element carrying a hover scope that is not a card: an arg name, the verb, the meter. */
function triggerFor(tree: RenderElement, scope: unknown) {
  return elements(tree).find(element => !isCard(element) && element.type !== 'Box' && scope !== undefined && hoverOf(element)?.scope === scope)
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = async ($: Body[0], on: Body[1], one: InspectedCall) => {
    on('ui.render', { component: 'Pane', requestId: 'hover-test' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code, Button }, { call: one, waiting: 1 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, links: LINKS })
    })
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'hover-test', props: PANE_PROPS })
  }

  test(`an argument name carries a hidden card: description, default, hints, values (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('pending'))
    const tree = await pane.drawn()
    const { card, scope } = cardFor(tree, /^cql: String!/)
    expect(card).toBeDefined()
    if (card === undefined) return
    // The constraint the form keeps off its row is in the card; the escape is escaped.
    expect(textOf(card)).toMatch(/Query in CQL/)
    expect(textOf(card)).toMatch(/requires a bounded query/i)
    expect(textOf(card)).not.toMatch(/\x1b/)
    expect(propsOf(card).display).toBe('none')
    const trigger = triggerFor(tree, scope)
    expect(textOf(trigger)).toMatch(/^cql/)
    expect(hoverOf(trigger as RenderElement)).toMatchObject({ scope, inverse: true })
    expect(String(scope).length).toBeLessThanOrEqual(64)
  })

  test(`an argument card shows its default (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('ran'))
    const tree = await pane.drawn()
    const { card } = cardFor(tree, /^limit: Int/)
    expect(textOf(card)).toMatch(/default\s+25/)
    expect(textOf(card)).toMatch(/set\s+by the call/)
    expect(textOf(card)).toMatch(/value\s+10/)
    expect(textOf(card)).toMatch(/Page size/)
  })

  test(`the root's verb carries a card with the arguments left unset (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('pending'))
    const tree = await pane.drawn()
    // The verb's card, not the name's: found from the verb's own scope.
    const verb = elements(tree).find(element => element.type === 'Text' && textOf(element) === 'SEARCH')
    const scope = hoverOf(verb as RenderElement)?.scope
    const card = elements(tree).find(element => isCard(element) && hoverOf(element)?.scope === scope)
    expect(card).toBeDefined()
    expect(textOf(card)).toMatch(/Search Confluence with CQL/)
    expect(textOf(card)).toMatch(/unset\s+sort: Confluence_Sort/)
  })

  test(`the policy meter carries a card naming the denied and masked fields (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('pending'))
    const tree = await pane.drawn()
    const { card, scope } = cardFor(tree, /policy · \d+ fields/)
    expect(card).toBeDefined()
    expect(propsOf(card as RenderElement).display).toBe('none')
    expect(textOf(card)).toMatch(/denied\s+confluence_search\.results\.secret/)
    expect(textOf(card)).toMatch(/masked\s+confluence_search\.results\.excerpt/)
    const trigger = triggerFor(tree, scope)
    expect(textOf(trigger)).toMatch(/^[▰▱]+$/)
    expect(hoverOf(trigger as RenderElement)).toMatchObject({ scope, inverse: true })
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = async ($: Body[0], on: Body[1], one: InspectedCall) => {
    on('ui.render', { component: 'Pane', requestId: 'hover-test' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code, Button }, { call: one, waiting: 1 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, links: LINKS })
    })
    return $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'hover-test', props: PANE_PROPS })
  }

  test(`a field card spells out type, policy, arguments and what came back (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('ran'))
    const tree = await pane.drawn()
    const results = textOf(cardFor(tree, /\.results · \[Confluence_SearchResultItem!\]!/).card)
    // The type in words, and what its marks mean.
    expect(results).toMatch(/a list, never null, of search result items that are never null/)
    expect(results).toMatch(/\[ \] is a list/)
    expect(results).toMatch(/7 rows/)
    const secret = textOf(cardFor(tree, /\.secret · String/).card)
    expect(secret).toMatch(/denied/)
    expect(secret).toMatch(/pii-high/)
    expect(secret).toMatch(/requestable/)
    expect(secret).toMatch(/denied in 7 of 7 items/)
    const excerpt = textOf(cardFor(tree, /\.excerpt · String/).card)
    expect(excerpt).toMatch(/masked/)
    expect(excerpt).toMatch(/a string, may be null/)
    expect(textOf(cardFor(tree, /\.totalSize · Int/).card)).toMatch(/value\s+120/)
    expect(excerpt).not.toMatch(/\x1b/)
  })

  test(`the root card lists every argument, the return type and the check results (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('ran'))
    const tree = await pane.drawn()
    const verb = elements(tree).find(element => element.type === 'Text' && textOf(element) === 'SEARCH')
    const scope = hoverOf(verb as RenderElement)?.scope
    const root = textOf(elements(tree).find(element => isCard(element) && hoverOf(element)?.scope === scope))
    expect(root).toMatch(/cql: String! = .*from a variable/)
    expect(root).toMatch(/limit: Int = 10.*default 25/)
    expect(root).toMatch(/sort: Confluence_Sort \(unset, optional\)/)
    expect(root).toMatch(/returns\s+Confluence_SearchResults: .*may be null/)
    expect(root).toMatch(/validate ✓ · dry_run ✓ \d+ allowed, 1 masked, 1 denied/)
  })

  test(`the meter card tags each masked and denied path with its classification (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('ran'))
    const { card } = cardFor(await pane.drawn(), /policy · \d+ fields/)
    expect(textOf(card)).toMatch(/denied\s+confluence_search\.results\.secret · classified pii-high · requestable/)
    expect(textOf(card)).toMatch(/\d+ allowed · 1 masked · 1 denied/)
  })

  test(`an argument card gives the value in full and its type in words (${surface})`, async ($, on) => {
    const pane = await mount($, on, call('ran'))
    const card = textOf(cardFor(await pane.drawn(), /^cql: String!/).card)
    expect(card).toMatch(/a string, never null/)
    expect(card).toMatch(/type=page/)
    expect(card).toMatch(/from a variable/)
  })
}

// ---- Where a lit card lands, drawn with the text renderer's kit. The text
// renderer leaves out hidden and absolute Boxes, so a card's place is read
// from its anchors and held to the drawn rows of what lit it.

type Drawn = { type: string; props: Record<string, any>; children: unknown[] }

/** Every element the stub kit drew, hidden and absolute ones too (its `children` leave those out), with the row its absolute ancestors put it down at. */
function laidOut(node: unknown, top = 0): { element: Drawn; top: number }[] {
  if (Array.isArray(node)) return node.flatMap(one => laidOut(one, top))
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const element = node as Drawn
  const inner = element.props.position === 'absolute' ? top + Number(element.props.top ?? 0) : top
  return [{ element, top }, ...laidOut(element.props.children, inner)]
}

/** A stub element's text, its descendants' included. */
function stubText(node: unknown): string {
  if (typeof node === 'string') return node.replace(/\n */g, ' ')
  if (node === null || typeof node !== 'object') return ''
  const element = node as Drawn
  return element.type === 'Button' ? String(element.props.label) : (element.children ?? []).map(stubText).join('')
}

const isStubCard = (element: Drawn) => String(element.props.key ?? '').startsWith('card:')

/** Where the lit card of `scope` lands in a pane of `total` rows: under its trigger (its first row), or over it (its last row, counted up from the pane's last). */
function landing(tree: unknown, scope: unknown, total: number) {
  const found = laidOut(tree).find(({ element }) => element.props.key === `card:${scope}`)
  if (found === undefined) return undefined
  const { element, top } = found
  return element.props.top !== undefined ? { side: 'below', row: top + Number(element.props.top) } : { side: 'above', row: total - 1 - Number(element.props.bottom ?? 0) }
}

/** The scope the drawn trigger whose text matches lights. */
const scopeLitBy = (tree: unknown, text: RegExp) => laidOut(tree).find(({ element }) => element.type !== 'Box' && element.props.hover?.scope !== undefined && text.test(stubText(element)))?.element.props.hover.scope

function draw(one: InspectedCall, options: { bodyRows?: number; scrollOffset?: number } = {}, columns = 64) {
  const tree = viewOf(stubKit(), { call: one, waiting: 0 }, columns, CLOSED, () => undefined, { surface: 'terminal', links: LINKS, ...options })
  return { tree, rows: renderText(tree, columns).split('\n') }
}

test('a lit card pops up beside what lit it: under a trigger near the top of the view, over one near the bottom', () => {
  const { tree, rows } = draw(reviewCall('ran'))
  const meter = rows.findIndex(row => row.includes('▰'))
  expect(landing(tree, scopeLitBy(tree, /▰/), rows.length)).toEqual({ side: 'below', row: meter + 1 })
  const link = rows.findIndex(row => row.includes('this search in Jira'))
  expect(link).toBeGreaterThan(rows.length / 2)
  expect(landing(tree, scopeLitBy(tree, /this search in Jira/), rows.length)).toEqual({ side: 'above', row: link - 1 })
})

test('a card opens toward the room in view: over a root low on a pane that fills its window, under it with blank rows below', () => {
  const one = reviewCall('ran')
  const snug = draw(one)
  const at = snug.rows.findIndex(row => row.startsWith('┃ LIST'))
  const scope = scopeLitBy(snug.tree, /^LIST$/)
  expect(landing(snug.tree, scope, snug.rows.length)).toEqual({ side: 'above', row: at - 1 })
  // The same pane in a window twice as tall: the room is under it now, under the root's header row (or rows, where its name wraps).
  const tall = draw(one, { bodyRows: snug.rows.length * 2 })
  const below = landing(tall.tree, scope, tall.rows.length)
  expect(below?.side).toBe('below')
  expect(below?.row).toBeGreaterThan(at)
  expect(below?.row).toBeLessThanOrEqual(tall.rows.findIndex(row => row.includes('orgId')))
})

test('every name, row and link that lights has a card to show', () => {
  for (const one of [reviewCall('ran'), reviewCall('pending'), gnarlyCall('ran'), titlesCall(), heavyCall(), persistedCall(), keptOutCall()]) {
    for (const columns of [40, 64]) {
      for (const options of [{}, { bodyRows: 24 }]) {
        const all = laidOut(draw(one, options, columns).tree).map(({ element }) => element)
        const cards = new Set(all.filter(isStubCard).map(card => card.props.hover.scope))
        // A RESULT row lights its own URL tip (or just itself); its fields open on ▸, not in a card that would cover the next link.
        const rows = new Set(all.filter(element => element.type === 'Box' && String(element.props.key ?? '').startsWith('row:')).map(row => row.props.hover?.scope))
        for (const trigger of all.filter(element => element.type !== 'Box' && element.props.hover?.scope !== undefined && !rows.has(element.props.hover.scope))) {
          expect(`${stubText(trigger)}: ${cards.has(trigger.props.hover.scope)}`).toBe(`${stubText(trigger)}: true`)
        }
      }
    }
  }
})

// ---- Everything the pane names teaches: each name lights a card, and the card says what it is.

/** The text of the card the scope lights. */
const cardText = (all: readonly Drawn[], scope: unknown) => stubText(all.find(element => isStubCard(element) && element.props.hover?.scope === scope))
/** The drawn trigger (not a card) carrying the scope. */
const triggerOf = (all: readonly Drawn[], scope: unknown) => all.find(element => !isStubCard(element) && element.type !== 'Box' && element.props.hover?.scope === scope)
const drawnOf = (one: InspectedCall, columns = 64) => laidOut(draw(one, {}, columns).tree).map(({ element }) => element)

test('every name drawn in a return tree lights a card with its coordinate, its type in words and its policy, pending and settled', () => {
  for (const one of [reviewCall('ran'), reviewCall('pending'), gnarlyCall('ran'), gnarlyCall('pending')]) {
    for (const columns of [40, 64, 84]) {
      const plan = planFor(stubKit(), one, columns, CLOSED, () => undefined, { surface: 'terminal', links: LINKS })
      const all = drawnOf(one, columns)
      // Leaves drawn inline in a group (`id · name · role`, `isLast · nextPageToken`) as much as heads.
      const names = plan.roots.flatMap(root => root.returns.lines.flatMap(line => [...(line.head === undefined ? [] : [line.head]), ...line.fields]))
      expect(names.length).toBeGreaterThan(3)
      for (const field of names) {
        const scope = hoverScope(cardId.field(field.path))
        const text = cardText(all, scope)
        expect(`${columns} ${field.path}: ${triggerOf(all, scope) !== undefined}`).toBe(`${columns} ${field.path}: true`)
        expect(`${columns} ${field.path}: ${text.includes(field.coordinate) && /type\s+\S/.test(text) && /policy\s+\S/.test(text)}`).toBe(`${columns} ${field.path}: true`)
      }
    }
  }
})

test('the nextPageToken card says how the list pages, and isLast what it means', () => {
  const all = drawnOf(reviewCall('ran'))
  expect(cardText(all, hoverScope(cardId.field('open.nextPageToken')))).toMatch(/next page's token: pass it back as nextPageToken to get the next page/)
  expect(cardText(all, hoverScope(cardId.field('open.isLast')))).toMatch(/true on the last page/)
})

test('a field with no schema description still has a card, which says so, with its type taught and what came back', () => {
  const key = cardText(drawnOf(reviewCall('ran')), hoverScope(cardId.field('open.issues.key')))
  expect(key).toContain('no description in the schema')
  expect(key).toMatch(/a string, may be null/)
  expect(key).toMatch(/no ! after it may be null/)
  expect(key).toMatch(/DEV-634/)
})

test('the header teaches: the badge, the services, the operation name, the status and the summary eyebrow each light a card', () => {
  const all = drawnOf(reviewCall('ran'))
  const of = (id: string) => ({ trigger: stubText(triggerOf(all, hoverScope(id))), text: cardText(all, hoverScope(id)) })
  expect(of(cardId.badge()).trigger).toMatch(/READ/)
  expect(of(cardId.badge()).text).toMatch(/a query/)
  expect(of(cardId.services()).text).toMatch(/Jira.*jira_searchAndReconsileIssuesUsingJql/)
  expect(of(cardId.op()).trigger).toMatch(/ReviewSample/)
  expect(of(cardId.op()).text).toMatch(/the agent wrote/)
  expect(of(cardId.status()).text).toMatch(/Agent Services ran the call/)
  expect(of(cardId.credit()).trigger).toMatch(/summary · Haiku/)
  expect(of(cardId.credit()).text).toMatch(/headline Haiku wrote from the operation and the schema/)
  // A plain fact, not reassurance.
  expect(of(cardId.credit()).text).not.toMatch(/never/)
})

test('a RESULT rows line says what each part of it means and how the list goes on; a value line says which field it is', () => {
  const review = draw(reviewCall('ran'))
  const head = cardText(laidOut(review.tree).map(({ element }) => element), scopeLitBy(review.tree, /5 issues · first page/))
  expect(head).toMatch(/first page: /)
  expect(head).toMatch(/more available: /)
  expect(head).toMatch(/call again with nextPageToken/)
  const gnarly = draw(gnarlyCall('ran'))
  expect(cardText(laidOut(gnarly.tree).map(({ element }) => element), scopeLitBy(gnarly.tree, /^total {2}412$/))).toMatch(/Jira_Count\.count/)
})

test('the context line lights a card: what the response cost in context, each heavy field with its size and share, and what the result would be without it', () => {
  const heavy = draw(heavyCall())
  // The line is drawn under RESULT, and a flag says the one field is most of it (the line does not say it again).
  expect(heavy.rows.join('\n')).toMatch(/\d+\sKB\s·\sabout\s[\d.]+k\stokens/)
  expect(heavy.rows.join('\n')).toMatch(/⚑ issues\.fields\.description is \d+% of a \d+\sKB result/)
  const all = laidOut(heavy.tree).map(({ element }) => element)
  const scope = hoverScope(cardId.weight())
  expect(triggerOf(all, scope)).toBeDefined()
  const card = cardText(all, scope)
  expect(card).toMatch(/Claude read this whole response/)
  expect(card).toMatch(/issues\.fields\.description/)
  expect(card).toMatch(/\d+% of the response/)
  expect(card).toMatch(/40 rows, about/)
  expect(card).toMatch(/Without issues\.fields\.description this result would be about/)
  // It is an estimate, and says so.
  expect(card).toMatch(/not a count/)
  // Kept out of the context, it says that instead, with and without the file read back.
  expect(cardText(drawnOf(persistedCall()), scope)).toMatch(/kept this response out of Claude's context/)
  expect(cardText(drawnOf(keptOutCall()), scope)).toMatch(/did not read the file/)
  expect(draw(keptOutCall()).rows.join('\n').replace(/\s+/g, ' ')).toMatch(/saved to a file · Claude saw only a short preview and its path/)
})

test("a RESULT row's ▸ lights a card saying it shows every field of the row, and which", () => {
  const all = drawnOf(reviewCall('ran'))
  const toggles = all.filter(element => element.type === 'Button' && element.props.label === '▸' && element.props.hover?.scope !== undefined)
  expect(toggles.length).toBeGreaterThan(0)
  for (const toggle of toggles) expect(cardText(all, toggle.props.hover.scope)).toMatch(/shows every field of this row/)
  expect(cardText(all, toggles[0]?.props.hover.scope)).toMatch(/fields\.status\.name/)
})

test('every argument name lights a card, one left to its default too: what kind of value it takes, its type in words', () => {
  const all = drawnOf(call('pending'))
  expect(cardText(all, hoverScope(cardId.arg('hits', 'cql')))).toMatch(/a CQL query/)
  const start = cardText(all, hoverScope(cardId.arg('hits', 'start')))
  expect(start).toMatch(/server uses its default/)
  expect(start).toMatch(/an offset/)
  expect(triggerOf(all, hoverScope(cardId.arg('hits', 'start')))).toBeDefined()
})
