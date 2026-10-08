// Field names: plain Buttons that open the field's drawer once presses can
// arrive, styled Text while a prompt is up. Real names only.

import type { RenderNode } from 'claude-code'

import type { FieldIR } from '../ir.ts'
import type { Ctx } from './kit.ts'
import { esc, policyColor, policyMark } from './kit.ts'
import type { FieldTag } from './kit.ts'
import { classTag } from './personal.ts'
import { noteText } from './annotations.ts'
import type { Pinned } from './annotations.ts'
import { attentionMarker, continuationOf, isAttentionShown } from './plan.ts'
import { COLOR, GLYPH, STRUCT, struct } from './ui/index.tsx'
import { foldHover, nameHover } from './ui/hover.tsx'

/**
 * Marker for an annotation from src/attention.ts when there is no policy
 * marker: gray `◆` for personal data, warning `▴` for a write root.
 */
export function Attention({ ctx, pinned }: { ctx: Ctx; pinned: Pinned }) {
  return <ctx.kit.Text {...struct(pinned.isPersonal ? STRUCT.personal : COLOR.mask, ctx.isSettled)}>{`${attentionMarker(pinned)} `}</ctx.kit.Text>
}

/**
 * The policy glyph before a restricted name (`✕ email`, `◐ excerpt`), bold in
 * its policy color for every call status. Settled names use Buttons, which
 * cannot carry the policy color, so the glyph is a separate element.
 */
export function PolicyMark({ ctx, field }: { ctx: Ctx; field: FieldIR }) {
  const mark = policyMark(field)
  const color = policyColor(field)
  if (mark === undefined || color === undefined) return null
  return <ctx.kit.Text color={color} bold>{`${mark} `}</ctx.kit.Text>
}

/** A note after its node (`denied · pii.contact`): plain dim, whatever its emphasis. Italic is for schema types only. */
export function PinNote({ ctx, pinned }: { ctx: Ctx; pinned: Pinned }) {
  if (noteText(pinned) === '') return null
  return (
    <ctx.kit.Text dimColor>
      {noteText(pinned)}
    </ctx.kit.Text>
  )
}

/** Toggles `field`'s drawer. */
export function openField(ctx: Ctx, path: string) {
  ctx.act?.({ field: ctx.ui.field === path ? null : path })
}

/**
 * One field name; `where` keeps keys unique when a field is drawn twice. A
 * name is content, so it draws in default text: as Text (a prompt is up) a
 * restricted one takes its policy color, bold when denied; a settled Button
 * stays default, its policy mark beside it carrying the color. Never cut: a
 * name wider than its row comes as `rows` (the plan's nameRows, `▾` and all),
 * drawn one under the other, each lighting the same card; `tail` follows the
 * last of them (a root's rule).
 */
export function FieldName({ ctx, field, where, bold, rows, tail }: { ctx: Ctx; field: FieldIR; where: string; bold?: boolean; rows?: readonly string[]; tail?: RenderNode }) {
  const { Box, Text, Button } = ctx.kit
  const isButton = ctx.act !== undefined && Button !== undefined
  const label = esc(field.name, 120)
  const one = (text: string, index: number) => {
    if (isButton) return <Button key={`${where}:${field.path}${index === 0 ? '' : `:${index}`}`} plain label={text} hover={nameHover(field.path)} onPress={() => openField(ctx, field.path)} />
    const policy = policyColor(field)
    return (
      <Text {...(policy === undefined ? {} : { color: policy })} bold={bold === true || field.policy === 'deny'} hover={nameHover(field.path)}>
        {text}
      </Text>
    )
  }
  if (rows === undefined || rows.length < 2) return one(rows?.[0] ?? (isButton && ctx.ui.field === field.path ? `${label} ${GLYPH.open}` : label), 0)
  return (
    <Box flexDirection="column">
      {rows.map((row, index) =>
        index === rows.length - 1 && tail !== undefined ? (
          <Box flexDirection="row">
            {one(row, index)}
            {tail}
          </Box>
        ) : (
          one(row, index)
        ),
      )}
    </Box>
  )
}

/** The tree guide, one row per drawn row, in the faintest gray: it shows the shape and stays out of the way. */
function Guide({ ctx, rows }: { ctx: Ctx; rows: string[] }) {
  const { Box, Text } = ctx.kit
  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Text {...struct(STRUCT.guide)}>{row}</Text>
      ))}
    </Box>
  )
}

/**
 * One line of the form: a tree guide (`│ ├ `) in a fixed-width column, then an optional lead, an optional `on Type`
 * fragment, an optional head field (`content` in `content { id · type }`),
 * names joined by ` · `, a dim note. Names are direct children of a wrapping
 * row, so each one heats its hover group, and wrapped names stay under
 * their own indent, not the guide.
 */
export function NameLine({
  ctx,
  where,
  prefix = '',
  lead,
  onType,
  head,
  fields = [],
  note,
  fold,
  annotation,
  tags,
  rows = 1,
  breaks,
}: {
  ctx: Ctx
  where: string
  prefix?: string
  lead?: RenderNode
  onType?: string
  head?: FieldIR
  fields?: readonly FieldIR[]
  note?: string
  /** `… N fields` after the note: a hover trigger for the fold card listing them (needs `head`). */
  fold?: string
  /** A note pinned to the row's node, drawn dim after it (already escaped); it carries the node's classification. */
  annotation?: Pinned
  /** Dim tags after names by field path (`untyped JSON`, `· only with include=…`); escaped. */
  tags?: Record<string, FieldTag[]>
  /** Rows the line wraps to: the guide column repeats its continuation down all of them. */
  rows?: number
  /** Names wider than the line, broken into rows (the plan's), by field path. */
  breaks?: Record<string, string[]>
}) {
  const { Box, Text } = ctx.kit
  const guide = [prefix, ...Array<string>(Math.max(0, rows - 1)).fill(continuationOf(prefix))]
  const names: RenderNode[] = []
  const tagNodes = (list: readonly FieldTag[] | undefined): RenderNode[] =>
    (list ?? []).map(tag => (
      <Text {...(tag.isWarn ? struct(COLOR.mask, true) : struct(STRUCT.type, true, { italic: true }))}>
        {tag.text}
      </Text>
    ))
  const node = head ?? (fields.length === 1 ? fields[0] : undefined)
  // The schema's own classification, dim after the name, unless the note pinned to it says it.
  const classOf = (field: FieldIR) => (annotation !== undefined && field === node ? '' : classTag(field))
  fields.forEach((field, index) => {
    if (index > 0) names.push(<Text dimColor>{GLYPH.separator}</Text>)
    names.push(<PolicyMark ctx={ctx} field={field} />)
    names.push(<FieldName ctx={ctx} field={field} where={where} {...(breaks?.[field.path] !== undefined && { rows: breaks[field.path] })} />)
    if (classOf(field) !== '') names.push(<Text {...struct(STRUCT.type, true)}>{classOf(field)}</Text>)
    names.push(...tagNodes(tags?.[field.path]))
  })
  const parts = [
    lead,
    annotation !== undefined && isAttentionShown(annotation, node) && <Attention ctx={ctx} pinned={annotation} />,
    onType !== undefined && <Text {...struct(STRUCT.type, true, { italic: true })}>{`on ${esc(onType, 120)} `}</Text>,
    head !== undefined && <PolicyMark ctx={ctx} field={head} />,
    head !== undefined && <FieldName ctx={ctx} field={head} where={`${where}h`} {...(breaks?.[head.path] !== undefined && { rows: breaks[head.path] })} />,
    head !== undefined && classOf(head) !== '' && <Text {...struct(STRUCT.type, true)}>{classOf(head)}</Text>,
    ...(head === undefined ? [] : tagNodes(tags?.[head.path])),
    // An object reads as an object: `content { id · type }`.
    head !== undefined && fields.length > 0 && <Text {...struct(STRUCT.guide)}>{' { '}</Text>,
    ...names,
    head !== undefined && fields.length > 0 && <Text {...struct(STRUCT.guide)}>{' }'}</Text>,
    note !== undefined && <Text dimColor>{`${head !== undefined || fields.length > 0 ? '  ' : ''}${note}`}</Text>,
    // A direct child of the wrapping row, so it heats the fold card's group.
    fold !== undefined && (
      <Text dimColor {...(head !== undefined && { hover: foldHover(head.path) })}>
        {`${note !== undefined ? GLYPH.separator : head !== undefined || fields.length > 0 ? '  ' : ''}${fold}`}
      </Text>
    ),
    annotation !== undefined && <PinNote ctx={ctx} pinned={annotation} />,
  ]
  return (
    <Box flexDirection="row">
      {prefix !== '' && (
        <Box width={prefix.length} flexShrink={0}>
          <Guide ctx={ctx} rows={guide} />
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1}>
        {parts}
      </Box>
    </Box>
  )
}
