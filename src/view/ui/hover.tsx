// Hover cards for fields, arguments, root verbs, policy counts and header labels.
// Content comes from the operation, schema and outcome. The surface applies
// hover styles without invoking hooks, including while a call is pending.
//
// Plan.anchors supplies trigger rows. Place the card above or below its
// trigger according to available viewport space (`scroll.offset` and
// `scroll.bodyRows`). Cards are the pane's last direct children so they
// paint over subsequent rows. A wrapper would introduce engine clipping:
// absolute Boxes are clipped to their parent's bounds, and their pointer
// region counts toward the parent, which can block triggers underneath.
//
// Cards use `display: none` until their hover group is active, absolute
// positioning to preserve layout, and an opaque PANEL background. The card
// shares the trigger's group so it stays visible under the pointer.
//
// Triggers are Text while pending and plain Buttons once settled, directly
// inside a Box. Terminal Text nested in Text can follow a hover group but
// cannot activate it. Repeated names share a card anchored to the first.
// Schema descriptions are escaped, quoted and dimmed.

import type { RenderChildren, RenderNode, TextHoverProps } from 'claude-code'

import type { InspectedCall } from '../../../types'
import type { ArgIR, CallIR, CallOutcome, FieldIR, OmittedArg } from '../../ir.ts'
import { isPolicyUnit, leafPolicyCounts } from '../../annotate.ts'
import type { Ctx } from '../kit.ts'
import {
  CREDIT_FACTS,
  NO_DESCRIPTION,
  NO_SCHEMA,
  argKind,
  argLine,
  badgeFacts,
  cameBack,
  checkLine,
  classificationNote,
  flat,
  opFacts,
  personalNote,
  placeOf as fieldPlace,
  policyLine,
  scopesNote,
  serviceFacts,
  statusFacts,
  typeLesson,
  typeSaid,
  unsetLines,
  valueText,
  valuesBack,
} from '../card-facts.ts'
import { esc, policyColor, policyMark, walk } from '../kit.ts'
import { pagingNote, pagingRole } from '../paging.ts'
import { cardId, cellWidth, cellsOf } from '../plan.ts'
import { PolicyChip, statusOf } from './index.tsx'
import { isWriteAllowed } from '../outcome.ts'
import { COLOR, PANEL, RIGHT_PAD, STRUCT, struct } from './theme.ts'

/** A card says a description whole: the card is where it lives (escaped and laid flat at 4000 characters). */
const DESCRIPTION_LINES = Infinity
const ARG_DESCRIPTION_LINES = Infinity
const ROOT_DESCRIPTION_LINES = Infinity

/** FNV-1a, so any field path makes a short scope with no control characters. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * The hover group of one card, by its id (plan.ts cardId: a kind letter and
 * a key). Each kind hashes under its own prefix, so no two collide. At most
 * 64 characters, as a scope must be.
 */
export function hoverScope(id: string): string {
  return `gas-${id.slice(0, id.indexOf(':'))}-${hash(id)}`
}

const litBy = (scope: string): TextHoverProps => ({ scope, inverse: true, dimColor: false })

/** An argument name lights its card; the key is the root's path and the argument's name. */
export function argHover(rootPath: string, name: string): TextHoverProps {
  return litBy(hoverScope(cardId.arg(rootPath, name)))
}

/** The root's verb lights the root card. */
export function rootHover(rootPath: string): TextHoverProps {
  return litBy(hoverScope(cardId.root(rootPath)))
}

/** The policy meter lights the policy card. */
export function meterHover(): TextHoverProps {
  return litBy(hoverScope(cardId.meter()))
}

/** The flags line lights the card that says each flag in full. */
export function flagsHover(): TextHoverProps {
  return litBy(hoverScope(cardId.flags()))
}

/** The trust line lights the card that says which rule each root fit, or why the call asked. */
export function trustHover(): TextHoverProps {
  return litBy(hoverScope(cardId.trust()))
}

/** The subagent line lights the card that says who made the call and what it was asked to do. */
export function agentHover(): TextHoverProps {
  return litBy(hoverScope(cardId.agent()))
}

/** A deep link lights its card (what it opens, its query, its host); by its place in the list. */
export const linkScope = (index: number) => hoverScope(cardId.link(index))
export function linkHover(index: number): TextHoverProps {
  return litBy(linkScope(index))
}

/** A folded object's `… N fields` lights the card listing them; the key is the object's path. */
export function foldHover(path: string): TextHoverProps {
  return litBy(hoverScope(cardId.fold(path)))
}

/** What a field name carries to light its group: inverse, at full strength. */
export function nameHover(path: string): TextHoverProps {
  return litBy(hoverScope(cardId.field(path)))
}

/** What any other trigger carries to light the card `id` (plan.ts cardId): the badge, the services, a RESULT line. */
export function idHover(id: string): TextHoverProps {
  return litBy(hoverScope(id))
}

// ---- Cells (terminal): as the planner counts them

const widthOf = cellWidth

/** Word-wraps `text` to `width` cells; a word wider than a line is split. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  const push = () => {
    lines.push(line)
    line = ''
  }
  for (const word of text.split(' ')) {
    if (word === '') continue
    const room = width - widthOf(line) - (line === '' ? 0 : 1)
    if (widthOf(word) <= room) {
      line = line === '' ? word : `${line} ${word}`
      continue
    }
    if (line !== '') push()
    let rest = word
    while (widthOf(rest) > width) {
      let cut = ''
      for (const char of rest) {
        if (widthOf(cut) + cellsOf(char) > width) break
        cut += char
      }
      lines.push(cut)
      rest = rest.slice(cut.length)
    }
    line = rest
  }
  if (line !== '') push()
  return lines.length === 0 ? [''] : lines
}

/**
 * `text` word-wrapped to the full `width`, as a plain wrap fills it, except
 * that a paragraph does not end on a single word (`your data.` alone on a
 * row): the line before gives its last word to the last line, while that
 * still fits (CSS's `text-wrap: pretty`). Never more lines than a plain wrap.
 */
export function pretty(text: string, width: number): string[] {
  const lines = wrap(text, width)
  if (lines.length < 2) return lines
  const last = lines[lines.length - 1] ?? ''
  const before = lines[lines.length - 2] ?? ''
  if (last.includes(' ') || !before.includes(' ')) return lines
  const cut = before.lastIndexOf(' ')
  const moved = `${before.slice(cut + 1)} ${last}`
  if (widthOf(moved) > width) return lines
  return [...lines.slice(0, -2), before.slice(0, cut), moved]
}

/** The cells a card's text has: the pane less the card's inset, outline and padding. */
export const cardWidth = (ctx: Ctx) => Math.max(10, ctx.columns - CARD_INSET)

/** A card paragraph, wrapped to the full width with no lone last word (pretty), each line starting `indent` cells in. */
export function Para({ ctx, text, dim = false, indent = 0 }: { ctx: Ctx; text: string; dim?: boolean; indent?: number }) {
  const { Text } = ctx.kit
  const pad = ''.padEnd(indent)
  // One Text, its lines already broken (each fits): the words stay one run of text, as a reader copies it.
  const lines = text.split('\n').flatMap(part => pretty(part, Math.max(1, cardWidth(ctx) - indent)))
  return <Text dimColor={dim}>{lines.map(line => `${pad}${line}`).join('\n')}</Text>
}

/** `lines`, cut to `max` with the last one ending in `…`. */
function cap(lines: string[], max: number, width: number): string[] {
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  let last = kept[max - 1] ?? ''
  while (last !== '' && widthOf(last) + 1 > width) last = [...last].slice(0, -1).join('')
  kept[max - 1] = `${last}…`
  return kept
}

// ---- The card layer

/** Cells left of a card: none, so nothing it covers (the summary box's edge, a glyph) peeks out beside it. */
export const CARD_LEFT = 0
/** Cells a card's inset, outline and inner padding take from the pane's width. */
export const CARD_INSET = CARD_LEFT + 4

/** Where a card pops up: on its trigger's rows, below them or above. */
export type Place = { row: number; rows: number; isBelow: boolean }

/**
 * Where the card `id` goes (plan.ts cardId): beside its trigger's rows
 * (Plan.anchors), below them when there is at least as much room under them
 * as above in the rows in view, else above, so it opens toward the larger
 * side (a card taller than that side is clipped). Undefined when the trigger
 * is not drawn: the card would never light.
 */
export function placeOf(ctx: Ctx, id: string): Place | undefined {
  const cards = ctx.cards
  const anchor = cards?.anchors.get(id)
  if (cards === undefined || anchor === undefined) return undefined
  const above = anchor.row - cards.top
  const below = cards.top + cards.rows - (anchor.row + anchor.rows)
  return { ...anchor, isBelow: below >= above }
}

/**
 * A card's frame: hidden until its group is lit, then a box outlined in the
 * structure hue on an opaque panel, its title on the first row, popped up
 * beside its trigger (placeOf): under the trigger's last row, or with its
 * bottom edge on the trigger's first. A direct child of the pane, placed
 * against it: the engine clips an absolute Box to a parent no rows tall
 * (tried), and a parent spanning rows takes the pointer off every trigger
 * under it, so cards have no layer around them. Nothing when the trigger is
 * not drawn.
 */
export function Frame({ ctx, id, title, children }: { ctx: Ctx; id: string; title: string; children: RenderChildren }) {
  const { Box, Text } = ctx.kit
  const place = placeOf(ctx, id)
  if (place === undefined) return null
  const scope = hoverScope(id)
  // Above, the card's bottom edge sits on the trigger's first row: `bottom` counts from the pane's last row.
  const side = place.isBelow ? { top: place.row + place.rows } : { bottom: Math.max(0, (ctx.cards?.total ?? 0) - place.row) }
  return (
    <Box key={`card:${scope}`} position="absolute" left={CARD_LEFT} right={RIGHT_PAD} {...side} flexDirection="column" display="none" hover={{ scope, display: 'flex' }}>
      <Box flexDirection="column" borderStyle="round" borderColor={STRUCT.card} backgroundColor={PANEL} paddingX={1}>
        <Text bold color={STRUCT.card} wrap="wrap">
          {title}
        </Text>
        {children}
      </Box>
    </Box>
  )
}

/** The label column of a card's fact rows: the longest label (`personal`) and a space. */
const LABEL_CELLS = 9

/** A dim label column, then the text wrapped evenly beside it, its later lines under its first (a hanging indent). */
export function Fact({ ctx, label, text }: { ctx: Ctx; label: string; text: string }) {
  const { Box, Text } = ctx.kit
  // A label wider than the column (`deprecated`) widens it for this fact, so a space always follows it.
  const column = Math.max(LABEL_CELLS, widthOf(label) + 1)
  const lines = text.split('\n').flatMap(part => pretty(part, Math.max(1, cardWidth(ctx) - column)))
  return (
    <Text>
      <Text {...struct(STRUCT.cardLabel)}>{label.padEnd(column)}</Text>
      {lines.join(`\n${''.padEnd(column)}`)}
    </Text>
  )
}

/** Quoted dim italic description lines, cut to `max`. */
function Quoted({ ctx, text, max }: { ctx: Ctx; text: string | undefined; max: number }) {
  const { Box, Text } = ctx.kit
  const width = Math.max(10, ctx.columns - CARD_INSET)
  const laid = text === undefined ? '' : flat(text, 4000)
  if (laid === '') return null
  return (
    <Box flexDirection="column">
      {cap(wrap(`“${laid}”`, width), max, width).map(line => (
        <Text dimColor>
          {line}
        </Text>
      ))}
    </Box>
  )
}

/** Most enum values a card lists before `… N more`; paths on the meter card. */
const LISTED = 40
const LISTED_PATHS = 12
/** Most lines a wrapped value keeps. */
const VALUE_LINES = 12

/** A dim line under a fact, at its text's column: what the fact's notation means. */
function Hint({ ctx, text }: { ctx: Ctx; text: string }) {
  return <Para ctx={ctx} text={text} dim indent={LABEL_CELLS} />
}

/** The description, quoted and dim, whole; or that the schema gives none (or has not been read), so a card never just says nothing. */
export function Described({ ctx, text, isRead, max }: { ctx: Ctx; text: string | undefined; isRead: boolean; max: number }) {
  const { Text } = ctx.kit
  if (text !== undefined && flat(text, 4000) !== '') return <Quoted ctx={ctx} text={text} max={max} />
  return <Text dimColor>{isRead ? NO_DESCRIPTION : NO_SCHEMA}</Text>
}

/** A type as GraphQL writes it and in words (`[Issue!]!: a list, never null, of issues that are never null`), then a line on what its marks mean. */
export function TypeFacts({ ctx, label, sdl, scope, isOpaque = false }: { ctx: Ctx; label: string; sdl: string; scope?: string | undefined; isOpaque?: boolean }) {
  return (
    <>
      <Fact ctx={ctx} label={label} text={`${esc(sdl, 200)}: ${typeSaid(sdl, scope, isOpaque)}`} />
      <Hint ctx={ctx} text={typeLesson(sdl)} />
    </>
  )
}

/** Fact rows from a list: the label on the first, blanks after. */
function Facts({ ctx, label, lines }: { ctx: Ctx; label: string; lines: string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <Fact ctx={ctx} label={index === 0 ? label : ''} text={line} />
      ))}
    </>
  )
}

/** A long value wrapped under its label and cut to `VALUE_LINES`. */
function Block({ ctx, label, text }: { ctx: Ctx; label: string; text: string }) {
  const { Text } = ctx.kit
  const width = Math.max(10, ctx.columns - CARD_INSET - LABEL_CELLS)
  const lines = cap(wrap(text, width), VALUE_LINES, width)
  return (
    <>
      {lines.map((line, index) => (
        <Text wrap="wrap">
          <Text {...struct(STRUCT.cardLabel)}>{(index === 0 ? label : '').padEnd(LABEL_CELLS)}</Text>
          {line}
        </Text>
      ))}
    </>
  )
}

const typeTitle = (field: FieldIR) => `${esc(field.coordinate, 200)} · ${field.schema === undefined ? '?' : esc(field.schema.type, 200)}`

/**
 * The fact rows a field and a root share: its description (or that there is
 * none), its type in words with a line on the notation, the policy, and what
 * the schema says of it: hints, arguments, paging, scopes (or that it names
 * none), and once settled what came back. `role` is what the field does in
 * its list's paging; `back` what its rows held.
 */
function FieldFacts({ ctx, field, outcome, isRoot, role, back, policy }: { ctx: Ctx; field: FieldIR; outcome: CallOutcome | undefined; isRoot: boolean; role?: string | undefined; back?: string | undefined; policy?: RenderNode[] }) {
  const { Text } = ctx.kit
  const { schema } = field
  const need = schema?.requiresInclude
  const { Box } = ctx.kit
  return (
    <Box flexDirection="column">
      <Described ctx={ctx} text={schema?.description?.trim()} isRead={schema !== undefined} max={isRoot ? ROOT_DESCRIPTION_LINES : DESCRIPTION_LINES} />
      {schema !== undefined && <TypeFacts ctx={ctx} label={isRoot ? 'returns' : 'type'} sdl={schema.type} scope={field.service} isOpaque={schema.isOpaque === true} />}
      {role !== undefined && <Fact ctx={ctx} label="paging" text={role} />}
      {policy}
      {schema?.isOpaque === true && <Text dimColor>untyped JSON: any shape, which the schema does not describe, so it takes no sub-selection</Text>}
      {schema?.deprecated !== undefined && (
        <Fact ctx={ctx} label="deprecated" text={flat(schema.deprecated, 600)} />
      )}
      {need !== undefined && <Fact ctx={ctx} label="include" text={`${need.mode === 'only' ? 'returned only' : 'returned in full'} when include has ${esc(need.value, 60)}`} />}
      {(schema?.hints ?? []).length > 0 && <Fact ctx={ctx} label="hints" text={(schema?.hints ?? []).map(hint => esc(hint, 80)).join(' · ')} />}
      <Facts ctx={ctx} label="args" lines={field.args.map(argLine)} />
      <Facts ctx={ctx} label="unset" lines={unsetLines(field)} />
      {field.paging !== undefined && <Fact ctx={ctx} label="paging" text={pagingNote(field.paging)} />}
      <Facts ctx={ctx} label="needs" lines={(schema?.scopes ?? []).map(one => esc(one, 200))} />
      {schema !== undefined && schema.scopes.length === 0 && <Fact ctx={ctx} label="needs" text="no scopes listed in the schema" />}
      <Facts ctx={ctx} label="back" lines={[...cameBack(field, outcome), ...(back === undefined ? [] : [back])]} />
    </Box>
  )
}

/** One field's card, hidden until its group is lit. */
function Card({ ctx, ir, field, outcome }: { ctx: Ctx; ir: CallIR; field: FieldIR; outcome: CallOutcome | undefined }) {
  const { Box } = ctx.kit
  const chip = field.policy === 'mask' || field.policy === 'deny' ? field.policy : undefined
  const personal = personalNote(field)
  const { root, parent } = fieldPlace(ir.roots, field)
  const role = root === undefined ? undefined : pagingRole(field, root, parent)
  return (
    <Frame ctx={ctx} id={cardId.field(field.path)} title={typeTitle(field)}>
      {chip !== undefined && (
        <Box flexDirection="row">
          <PolicyChip kit={ctx.kit} kind={chip} isDim={ctx.isSettled} />
        </Box>
      )}
      <FieldFacts
        ctx={ctx}
        field={field}
        outcome={outcome}
        isRoot={false}
        role={role}
        back={valuesBack(field, parent, outcome)}
        policy={[<Fact ctx={ctx} label="policy" text={policyLine(field, outcome)} />, ...(personal === undefined ? [] : [<Fact ctx={ctx} label="personal" text={personal} />])]}
      />
    </Frame>
  )
}

/** An argument's card: `name: Type`, then everything the form leaves off. */
function ArgCard({ ctx, root, arg }: { ctx: Ctx; root: FieldIR; arg: ArgIR }) {
  const values = arg.enumValues ?? []
  const hints = arg.hints ?? []
  const keys = typeof arg.value === 'object' && arg.value !== null && !Array.isArray(arg.value) ? Object.keys(arg.value) : []
  return (
    <Frame ctx={ctx} id={cardId.arg(root.path, arg.name)} title={`${esc(arg.name, 100)}: ${arg.type === undefined ? '?' : esc(arg.type, 200)}`}>
      <Described ctx={ctx} text={arg.description?.trim()} isRead={arg.type !== undefined} max={ARG_DESCRIPTION_LINES} />
      {argKind(arg, root) !== undefined && <Fact ctx={ctx} label="kind" text={argKind(arg, root) ?? ''} />}
      {arg.type !== undefined && <TypeFacts ctx={ctx} label="type" sdl={arg.type} scope={root.service} />}
      <Fact ctx={ctx} label="set" text={arg.fromVariable ? 'by the call, from a variable' : 'by the call'} />
      <Block ctx={ctx} label="value" text={valueText(arg.value)} />
      {keys.length > 0 && <Fact ctx={ctx} label="fields" text={keys.slice(0, LISTED).map(key => esc(key, 60)).join(' · ')} />}
      <Fact ctx={ctx} label="default" text={arg.defaultValue !== undefined ? `${esc(arg.defaultValue, 300)} (used when the call leaves it out)` : 'none'} />
      {hints.length > 0 && <Fact ctx={ctx} label="limits" text={hints.map(hint => esc(hint, 80)).join(' · ')} />}
      {values.length > 0 && (
        <Fact
          ctx={ctx}
          label="one of"
          text={`${values.slice(0, LISTED).map(value => esc(value, 60)).join(' · ')}${values.length > LISTED ? ` … ${values.length - LISTED} more` : ''}`}
        />
      )}
    </Frame>
  )
}

/** An argument the call left out, drawn with its default under the set ones: what it is, and that the server uses its default. */
function OmittedArgCard({ ctx, root, arg }: { ctx: Ctx; root: FieldIR; arg: OmittedArg }) {
  const kind = argKind(arg, root)
  return (
    <Frame ctx={ctx} id={cardId.arg(root.path, arg.name)} title={`${esc(arg.name, 100)}: ${esc(arg.type, 200)}`}>
      <Described ctx={ctx} text={arg.description?.trim()} isRead max={ARG_DESCRIPTION_LINES} />
      {kind !== undefined && <Fact ctx={ctx} label="kind" text={kind} />}
      <TypeFacts ctx={ctx} label="type" sdl={arg.type} scope={root.service} />
      <Fact ctx={ctx} label="set" text="not by the call: the server uses its default" />
      <Fact ctx={ctx} label="default" text={esc(arg.default ?? '', 300)} />
    </Frame>
  )
}

/**
 * A folded object's card: every field under it, one row each, by its path
 * below the object (`assignee.displayName`), with its type in words and its
 * policy (the glyph and word in the policy's color only when restricted),
 * then what the schema classifies it as. Indented under nested objects.
 */
function FoldCard({ ctx, field, outcome }: { ctx: Ctx; field: FieldIR; outcome: CallOutcome | undefined }) {
  const { Box, Text } = ctx.kit
  const rows = (list: readonly FieldIR[], depth: number): { field: FieldIR; depth: number }[] => list.flatMap(one => [{ field: one, depth }, ...rows(one.children, depth + 1)])
  const all = rows(field.children, 0)
  const leaves = all.filter(one => one.field.children.length === 0).length
  return (
    <Frame ctx={ctx} id={cardId.fold(field.path)} title={`${typeTitle(field)} · ${leaves} field${leaves === 1 ? '' : 's'}`}>
      {all.slice(0, LISTED).map(({ field: one, depth }) => {
        const mark = policyMark(one)
        const color = policyColor(one)
        const note = one.children.length > 0 ? '' : classificationNote(one, outcome)
        const type = one.schema === undefined ? '?' : esc(one.schema.type, 120)
        return (
          <Box flexDirection="column">
            <Text wrap="wrap">
              {'  '.repeat(depth)}
              {mark !== undefined && color !== undefined && <Text color={color} bold>{`${mark} `}</Text>}
              <Text bold={one.children.length > 0}>{esc(one.name, 120)}</Text>
              <Text {...struct(STRUCT.cardLabel)}>{`  ${type}`}</Text>
              {one.children.length === 0 && (color === undefined ? <Text dimColor>{`  ${one.policy === 'unknown' ? 'not checked' : 'allowed'}`}</Text> : <Text color={color}>{`  ${one.policy === 'deny' ? 'denied' : 'masked'}`}</Text>)}
            </Text>
            {note !== '' && (
              <Para ctx={ctx} dim indent={2 * (depth + 1)} text={note} />
            )}
          </Box>
        )
      })}
      {all.length > LISTED && <Text dimColor>{`… ${all.length - LISTED} more`}</Text>}
    </Frame>
  )
}

/** The root's card: description, return type, every argument, paging, scopes, the checks. */
function RootCard({ ctx, ir, root, outcome }: { ctx: Ctx; ir: CallIR; root: FieldIR; outcome: CallOutcome | undefined }) {
  const checks = checkLine(ir, leafPolicyCounts(ir.roots))
  const diagnostics = ir.validation?.valid === false ? ir.validation.diagnostics.slice(0, 3).map(one => flat(one, 200)) : []
  return (
    <Frame ctx={ctx} id={cardId.root(root.path)} title={typeTitle(root)}>
      <FieldFacts ctx={ctx} field={root} outcome={outcome} isRoot />
      {checks !== undefined && <Fact ctx={ctx} label="checks" text={checks} />}
      <Facts ctx={ctx} label="invalid" lines={diagnostics} />
      {ir.checks?.error !== undefined && <Fact ctx={ctx} label="error" text={flat(ir.checks.error, 200)} />}
    </Frame>
  )
}

/**
 * The policy meter's card (lit by the meter, or by `✓ all N allowed` in its
 * place): counts per policy, every masked, denied and unchecked field by
 * path, and that the schema asks for no scope when it asks for none.
 */
function PolicyCard({ ctx, ir, outcome }: { ctx: Ctx; ir: CallIR; outcome: CallOutcome | undefined }) {
  const { Text } = ctx.kit
  const roots = ir.roots
  const counts = leafPolicyCounts(roots)
  const scopes = scopesNote(ir)
  // By real names (`confluence_search.results.secret`), never the aliases a path is keyed by.
  const leaves = (list: readonly FieldIR[], trail: string): { name: string; field: FieldIR }[] =>
    list.flatMap(field => {
      const name = trail === '' ? field.name : `${trail}.${field.name}`
      return isPolicyUnit(field) ? [{ name, field }] : leaves(field.children, name)
    })
  const all = leaves(roots, '')
  const listed = (policy: FieldIR['policy']) => {
    const paths = all
      .filter(leaf => leaf.field.policy === policy)
      .map(leaf => {
        const note = policy === 'unknown' ? '' : classificationNote(leaf.field, outcome)
        return `${flat(leaf.name, 200)}${note === '' ? '' : ` · ${note}`}`
      })
    const shown = paths.slice(0, LISTED_PATHS)
    return paths.length > shown.length ? [...shown, `… ${paths.length - shown.length} more`] : shown
  }
  const words = [`${counts.allow} allowed`, `${counts.mask} masked`, `${counts.deny} denied`, counts.unknown > 0 ? `${counts.unknown} not checked` : ''].filter(Boolean).join(' · ')
  const total = counts.allow + counts.mask + counts.deny + counts.unknown
  return (
    <Frame ctx={ctx} id={cardId.meter()} title={`policy · ${total} field${total === 1 ? '' : 's'}`}>
      {isWriteAllowed(ir, outcome) && <Para ctx={ctx} text="write allowed: Agent Services' policy lets this change through for you. The fields below are what it returns." />}
      <Fact ctx={ctx} label="fields" text={words} />
      <Facts ctx={ctx} label="denied" lines={listed('deny')} />
      <Facts ctx={ctx} label="masked" lines={listed('mask')} />
      <Facts ctx={ctx} label="unknown" lines={listed('unknown')} />
      {scopes !== undefined && <Para ctx={ctx} dim text={scopes} />}
    </Frame>
  )
}

/**
 * Every card, hidden (one per hover scope: fields, arguments, roots, the
 * meter), as a list for the pane's root to hold directly (Frame): the
 * hovered name's card pops up beside it. Takes no rows in the flow; a card
 * whose trigger is not drawn is left out.
 * `outcome` is the settled call's, when it ran.
 */
export function detailCards(ctx: Ctx, ir: CallIR, outcome?: CallOutcome): RenderNode[] {
  const roots = ir.roots
  const seen = new Set<string>()
  const fields = walk(roots).filter(field => !seen.has(field.path) && (seen.add(field.path), true))
  return [
    ...fields.map(field => <Card ctx={ctx} ir={ir} field={field} outcome={outcome} />),
    // A card for every object a RETURNS row may fold (the plan says which do, and where).
    ...fields.filter(field => field.children.length > 0 && !roots.includes(field)).map(field => <FoldCard ctx={ctx} field={field} outcome={outcome} />),
    ...roots.flatMap(root => [
      <RootCard ctx={ctx} ir={ir} root={root} outcome={outcome} />,
      ...root.args.map(arg => <ArgCard ctx={ctx} root={root} arg={arg} />),
      // The arguments drawn with their defaults (the plan anchors those it draws).
      ...(root.omittedArgs ?? []).filter(arg => arg.default !== undefined).map(arg => <OmittedArgCard ctx={ctx} root={root} arg={arg} />),
    ]),
    <PolicyCard ctx={ctx} ir={ir} outcome={outcome} />,
  ]
}

/** A card of plain lines under its title: the header's cards. */
function Lines({ ctx, id, title, lines }: { ctx: Ctx; id: string; title: string; lines: readonly string[] }) {
  // The lead says what it is; the rest, dim, say how it works.
  return (
    <Frame ctx={ctx} id={id} title={title}>
      {lines.map((line, index) => (
        <Para ctx={ctx} text={line} dim={index > 0} />
      ))}
    </Frame>
  )
}

/**
 * The header's cards, as a list for the pane's root (Frame): the badge (what
 * the operation type is and what approving does), the services and the
 * roots each serves, the operation name (the agent's own label), the status
 * word, and the `summary · Haiku` credit (model and input sources).
 */
export function headerCards(ctx: Ctx, call: InspectedCall, waiting: number): RenderNode[] {
  const { Text } = ctx.kit
  const { ir } = call
  const badge = badgeFacts(ir)
  const services = serviceFacts(ir)
  const status = statusOf(call.status, waiting, call.outcome)
  const word = status === undefined ? '' : `${status.glyph === '' ? '' : `${status.glyph} `}${status.word}`
  return [
    <Lines ctx={ctx} id={cardId.badge()} title={badge.title} lines={badge.lines} />,
    <Frame ctx={ctx} id={cardId.services()} title={services.length === 1 ? `${services[0]?.service ?? 'a service'} · the service` : `${services.length} services`}>
      {services.map(one => (
        <Text wrap="wrap">
          <Text bold>{one.service}</Text>
          <Text dimColor>{`  ${one.roots.join(' · ')}`}</Text>
        </Text>
      ))}
      <Para ctx={ctx} dim text="Agent Services runs each root field against its own service, under that service's policy." />
    </Frame>,
    <Lines ctx={ctx} id={cardId.op()} title={`${esc(ir.opName ?? '', 200)} · operation name`} lines={opFacts(ir)} />,
    <Lines ctx={ctx} id={cardId.status()} title={word} lines={statusFacts(status?.word ?? '', call.status === 'ran' ? call.outcome : undefined)} />,
    <Lines ctx={ctx} id={cardId.credit()} title="summary · Haiku" lines={CREDIT_FACTS} />,
  ]
}
