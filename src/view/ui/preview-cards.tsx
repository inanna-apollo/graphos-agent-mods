// Hover cards for RESULT: a preview row's (the record by its key and place in
// the list, its summary, every field the row kept, the URL it opens and what
// its `▸` opens), and a rows or value line's (what each part of it means).
// Same machinery as the field cards in hover.tsx: each card is hidden until
// its row's hover group is lit, and pops up beside its list (Frame). The row is the
// trigger, but the card is placed by the row's whole list (Plan.anchors):
// under its last row, or over its head line when there is more room above,
// never over a sibling, so the pointer moving down the list lights each row
// in turn. A row with a record link also shows, over its own summary, the
// URL a click opens (RowTip).
//
// Response content: escaped, quoted nowhere, dimmed where it is a detail.

import type { TextHoverProps } from 'claude-code'

import { MAX_URL } from '../../links.ts'
import type { RenderNode } from 'claude-code'

import type { Ctx } from '../kit.ts'
import { esc } from '../kit.ts'
import type { Plan } from '../plan.ts'
import { cardId, cellRows, cellWidth, closedItem, listKey, openedFields, previewLayout, rowKey, rowsLineText, ROW_INDENT } from '../plan.ts'
import type { CallIR, CallOutcome } from '../../ir.ts'
import { placeOf as fieldPlace, rowsFacts, scalarOf } from '../card-facts.ts'
import { pagingRole } from '../paging.ts'
import { cardOf, receiptOf } from '../receipt.ts'
import { Described, Fact, Frame, Para, TypeFacts, hoverScope } from './hover.tsx'
import { COLOR, GLYPH, PANEL } from './theme.ts'

/** The hover group of a preview row (its card and its tip), by its list (listKey) and place in it. */
export const previewScope = (list: string, index: number) => hoverScope(cardId.row(list, index))

/** What a preview row carries to light its card: inverse, at full strength. */
export function previewHover(list: string, index: number): TextHoverProps {
  return { scope: previewScope(list, index), inverse: true, dimColor: false }
}

/**
 * Markdown for one link whose label is inline code: the surface draws a
 * link in the palette's blue, which a terminal theme may draw gray, and
 * inline code in a fixed blue, which holds inside the link. A backtick in
 * the label would end the code, so it is drawn as a quote.
 */
export const markdownLink = (label: string, url: string) => `[\`${label.replace(/`/g, "'")}\`](<${url}>)`

/**
 * The URL a record row opens, drawn over the row itself while the row is
 * hovered: from the row's text column (`left`) to its right edge, from row
 * `top` of the row down to its last, so it covers the row's own text and no
 * other row. A box over the next row would keep this row lit while the
 * pointer rests on it (a revealed box is part of its group), so moving down
 * would never reach the next key. Pressable as the key is (Markdown,
 * `openUrl`) where the surface has it. Absolute and the row's last child:
 * painted over the row's own text, moving nothing. Pinned to the row's
 * bottom edge rather than sized, so it is the row's height whatever it
 * wraps to; `rows` is the room the URL is fitted to.
 */
export function RowTip({ ctx, scope, url, left, top = 0, rows }: { ctx: Ctx; scope: string; url: string; left: number; top?: number; rows: number }) {
  const { Box, Text, Markdown } = ctx.kit
  const act = ctx.act
  const shown = esc(url, MAX_URL)
  const width = Math.max(1, ctx.columns - left)
  const room = width * Math.max(1, rows)
  // Whole where it fits the row's cells, broken across its rows; else without the scheme; a URL longer than that is cut, the last resort (a taller tip would cover the next row).
  const scheme = shown.startsWith('https://') && cellWidth(`${GLYPH.link} ${shown}`) <= room ? 'https://' : ''
  const rest = shown.startsWith('https://') ? shown.slice('https://'.length) : shown
  const all = cellRows(`${GLYPH.link} ${scheme}${rest}`, width)
  const kept = Math.max(1, rows)
  // Past the row's rows, the rest rides on its last row, cut there by the surface.
  const lines = all.length <= kept ? all : [...all.slice(0, kept - 1), all.slice(kept - 1).join('')]
  // Each row in its own colors: the arrow and the host's path in the link blue, the scheme dim.
  const lead = GLYPH.link.length + 1
  let at = 0
  const colored = lines.map(line => {
    const from = at
    at += line.length
    const parts = [
      { text: line.slice(0, Math.max(0, lead - from)), color: COLOR.link },
      { text: line.slice(Math.max(0, lead - from), Math.max(0, lead + scheme.length - from)), dim: true },
      { text: line.slice(Math.max(0, lead + scheme.length - from)), color: COLOR.link },
    ]
    return parts.filter(part => part.text !== '')
  })
  return (
    <Box key={`tip:${scope}`} position="absolute" top={top} bottom={0} left={left} right={0} display="none" hover={{ scope, display: 'flex' }} backgroundColor={PANEL} flexDirection="column">
      {Markdown !== undefined && act !== undefined ? (
        <Markdown key={`open:tip:${scope}`} text={markdownLink(`${GLYPH.link} ${scheme}${rest}`, url)} onLinkPress={() => act({ openUrl: url })} pressableLinks={[url]} />
      ) : (
        colored.map((parts, index) => (
          <Text wrap={index === kept - 1 && all.length > kept ? 'truncate-end' : 'wrap'}>
            {parts.map(part => (part.dim === true ? <Text dimColor>{part.text}</Text> : <Text color={part.color}>{part.text}</Text>))}
          </Text>
        ))
      )}
    </Box>
  )
}

/** A field's value says again what `text` says: the same, or (kept shorter, `…`-cut) its start. */
const repeats = (value: string, text: string | undefined) => text !== undefined && (value === text || (value.endsWith('…') && text.startsWith(value.slice(0, -1))))

/**
 * The cards of RESULT rows' `▸` (view.tsx RowToggle), each lit by its own
 * toggle alone and placed by the row's whole list (Plan.anchors), so it
 * covers no sibling row: what a press opens under the row (its full text,
 * where a closed row cuts it, and each field it kept but does not say), or,
 * opened, that `▾` folds them back.
 */
export function toggleCards(ctx: Ctx, plan: Plan['result']): RenderNode[] {
  const { Text } = ctx.kit
  const rowWidth = Math.max(1, ctx.columns - ROW_INDENT)
  return plan.lines.flatMap(line => {
    if (line.kind !== 'preview') return []
    const list = listKey(line)
    const layout = previewLayout(line.items, rowWidth, ctx.column)
    return line.items.map((item, index) => {
      const fields = openedFields(item)
      const isCut = closedItem(item, rowWidth, layout).isCut
      const isOpen = ctx.callId !== undefined && ctx.ui.row === rowKey(ctx.callId, list, index)
      const opens = [isCut ? 'its full text' : '', fields.length > 0 ? `${fields.length} field${fields.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
      return (
        <Frame ctx={ctx} id={cardId.toggle(list, index)} title={`${isOpen ? GLYPH.open : GLYPH.closed} ${item.label}`}>
          <Para ctx={ctx} text={isOpen ? 'shows every field of this row: a press folds them back' : `shows every field of this row: a press opens ${opens} under it`} />
          {fields.length > 0 && <Para ctx={ctx} dim text={fields.map(one => one.name).join(' · ')} />}
        </Frame>
      )
    })
  })
}

/**
 * The cards of RESULT's rows and value lines, as a list for the pane's root
 * (Frame), each lit by its line (`cardId.line`, by its place among RESULT's
 * lines). A rows line (`5 issues · first page · more available`) says the
 * list it counts, how many came back against the total and the limit, what
 * each part of its note means, and how the list goes on past this page. A
 * value line (`total  412`) says which field it is, its type and what it is
 * for. Computed from the call and the outcome (src/view/card-facts.ts).
 */
export function resultCards(ctx: Ctx, plan: Plan['result'], ir: CallIR, outcome: CallOutcome | undefined): RenderNode[] {
  const { Box, Text } = ctx.kit
  return plan.lines.flatMap((line, index) => {
    // The context line's card: what the response cost, and each heavy field's size, share, per-row cost, schema description and what the result would be without it.
    if (line.kind === 'weight') {
      const receipt = receiptOf(outcome, ir)
      if (receipt === undefined) return []
      const card = cardOf(receipt)
      return [
        <Frame ctx={ctx} id={cardId.weight()} title={card.title}>
          {card.paragraphs.map((text, at) => (
            <Para ctx={ctx} text={text} dim={at > 0} />
          ))}
          {card.fields.map(one => (
            <Box flexDirection="column" marginTop={1}>
              <Text bold wrap="wrap">
                {one.label}
              </Text>
              <Fact ctx={ctx} label="takes" text={one.takes} />
              <Para ctx={ctx} text={one.without} />
              {one.home.kind === 'selected' ? (
                <Described ctx={ctx} text={one.home.field.schema?.description?.trim()} isRead={one.home.field.schema !== undefined} max={Infinity} />
              ) : (
                <Para ctx={ctx} dim text={one.home.kind === 'json' ? 'inside untyped JSON: the schema does not describe it' : 'part of the GraphQL response beside the data, not a field the call selected'} />
              )}
            </Box>
          ))}
        </Frame>,
      ]
    }
    if (line.kind === 'rows') {
      return [
        <Frame ctx={ctx} id={cardId.line(index)} title={rowsLineText(line).trim()}>
          {rowsFacts(line, plan.lines[index + 1], ir, outcome).map(fact => (
            <Fact ctx={ctx} label={fact.label} text={fact.text} />
          ))}
        </Frame>,
      ]
    }
    if (line.kind !== 'scalar') return []
    const { field, value } = scalarOf(line, ir, outcome)
    const place = field === undefined ? undefined : fieldPlace(ir.roots, field)
    const role = field === undefined || place?.root === undefined ? undefined : pagingRole(field, place.root, place.parent)
    return [
      <Frame ctx={ctx} id={cardId.line(index)} title={rowsLineText(line).trim()}>
        {field !== undefined && <Fact ctx={ctx} label="field" text={esc(field.coordinate, 200)} />}
        {field !== undefined && <Described ctx={ctx} text={field.schema?.description?.trim()} isRead={field.schema !== undefined} max={Infinity} />}
        {field?.schema !== undefined && <TypeFacts ctx={ctx} label="type" sdl={field.schema.type} scope={place?.root?.service} isOpaque={field.schema.isOpaque === true} />}
        {value !== undefined && <Fact ctx={ctx} label="value" text={`${value}: what the response sent`} />}
        {role !== undefined && <Fact ctx={ctx} label="paging" text={role} />}
        {field === undefined && <Para ctx={ctx} dim text={`${line.text}: what the response sent`} />}
      </Frame>,
    ]
  })
}
