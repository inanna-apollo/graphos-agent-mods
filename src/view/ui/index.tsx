// The pane's components, on the engine's flexbox Box and Text: modelled on
// the /diff mod's sections. Layout is the engine's: fixed-width gutters,
// flexGrow spacers and Text wrap modes, no padding by hand. Every string
// handed in is already escaped.

import type { RenderChildren, RenderNode, TextHoverProps } from 'claude-code'

import type { CallOutcome, CallStatus } from '../../../types'
import type { OpType } from '../../ir.ts'
import type { Kit } from '../kit.ts'
import { allowedShown, meterOf, writeAllowedShown } from '../meter.ts'

export { allowedShown, allowedText, countsCells, isMeterShown } from '../meter.ts'
import { failureCount } from '../outcome.ts'
import { BADGE, BADGE_HUE, BULLET, CHIP_WORD, COLOR, DRAWER_GUTTER, DRAWER_INDENT, GLYPH, GUTTER, MARK, NOTE_GLYPH, ROW_GAP, STRUCT, pill, struct } from './theme.ts'

export * from './theme.ts'

/**
 * Left content, a spacer, right content: the /diff mod's legend and list
 * rows. The side that `shrink`s (left by default) cuts with `truncate-end`;
 * the other keeps its width, and the spacer never closes below ROW_GAP. `leftBlock` takes a Box (Buttons cannot sit in
 * Text) in place of inline `left`.
 */
export function Row({ kit, left, leftBlock, right, rightBlock, shrink = 'left' }: {
  kit: Kit
  left?: RenderChildren
  leftBlock?: RenderNode
  right?: RenderChildren
  /** A Box in place of inline `right`, for Buttons (they cannot sit in Text). */
  rightBlock?: RenderNode
  shrink?: 'left' | 'right'
}) {
  const { Box, Text } = kit
  const isLeftShrinking = shrink === 'left'
  return (
    <Box flexDirection="row">
      {leftBlock !== undefined ? (
        <Box flexShrink={isLeftShrinking ? 1 : 0}>{leftBlock}</Box>
      ) : (
        left !== undefined && (
          <Box flexShrink={isLeftShrinking ? 1 : 0}>
            <Text wrap="truncate-end">{left}</Text>
          </Box>
        )
      )}
      <Box flexGrow={1} minWidth={left === undefined && leftBlock === undefined ? 0 : ROW_GAP} />
      {rightBlock !== undefined ? (
        <Box flexShrink={isLeftShrinking ? 0 : 1}>{rightBlock}</Box>
      ) : (
        right !== undefined && (
          <Box flexShrink={isLeftShrinking ? 0 : 1}>
            <Text wrap="truncate-end">{right}</Text>
          </Box>
        )
      )}
    </Box>
  )
}

/**
 * The rule under the header: one unbroken rule from edge to edge, faint for
 * a read, in `hue` (the badge's) for a write or a watch. The hue is the
 * signal; nothing in the rule reads as a bar filling up.
 */
export function Rule({ kit, cells, hue }: { kit: Kit; cells: number; hue?: string }) {
  const { Text } = kit
  return (
    <Text wrap="truncate-end" {...struct(hue ?? STRUCT.guide)}>
      {GLYPH.rule.repeat(Math.max(1, cells))}
    </Text>
  )
}

/**
 * A label in a fixed gutter beside a value that wraps: continuation lines
 * align because the value is its own Box. `mark` is a small right-aligned
 * column ahead of the label (the `$` of a variable), which indents it; `labelColor` makes the label loud.
 */
export function Field({ kit, label, isSection = false, mark, markColor, labelColor, isLabelBold, labelHover, labelWidth = GUTTER, marginTop = 0, children }: {
  kit: Kit
  label: string
  /** A block's label: the `┃` bar before it, in the structure hue. */
  isSection?: boolean
  mark?: string
  /** Colors the mark (the attention marker); a plain mark is dim. */
  markColor?: string
  labelColor?: string
  /** Bold; defaults to bold exactly when the label is colored. */
  isLabelBold?: boolean
  /** Lights a hover card's group while the pointer is over the label. */
  labelHover?: TextHoverProps
  labelWidth?: number
  marginTop?: number
  children?: RenderChildren
}) {
  const { Box, Text } = kit
  return (
    <Box flexDirection="row" marginTop={marginTop}>
      <Box width={labelWidth} flexShrink={0} flexDirection="row">
        {mark !== undefined && (
          <Box width={MARK} flexShrink={0} flexDirection="row" justifyContent="flex-end">
            <Text color={markColor} dimColor={markColor === undefined}>
              {mark}
            </Text>
          </Box>
        )}
        {/* A block's bar takes the structure hue; its word stays default text. */}
        {isSection && <Text color={STRUCT.bar}>{`${GLYPH.section} `}</Text>}
        <Text color={labelColor} dimColor={labelColor === undefined} bold={isLabelBold ?? labelColor !== undefined} wrap="truncate-end" {...(labelHover !== undefined && { hover: labelHover })}>
          {label}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  )
}

/** The badge's hue for an operation type (BADGE_HUE); the header rule carries it on. */
export const badgeHue = (opType: OpType | undefined): string => BADGE_HUE[opType ?? 'unknown']

/**
 * The verb badge, inline: a painted pill while pending (READ blue, WRITE
 * red, WATCH teal); settled, the word bold in its hue with the pill's
 * spacing, so it keeps its place and shape but stops shouting.
 */
export function Badge({ kit, opType, isSettled, hover }: { kit: Kit; opType: OpType | undefined; isSettled: boolean; hover?: TextHoverProps }) {
  const { Text } = kit
  const word = opType === undefined ? '?' : BADGE[opType]
  const hue = badgeHue(opType)
  const lit = hover === undefined ? {} : { hover }
  if (isSettled) return <Text {...struct(hue, true, { bold: true })} {...lit}>{` ${word} `}</Text>
  return <Text {...pill(hue)} {...lit}>{` ${word} `}</Text>
}

/**
 * A policy state as a chip that says it in words as well as color
 * (`MASKED 1`): a pill painted in the policy's color; settled, the words in
 * that color, dim, with the pill's spacing.
 */
export function PolicyChip({ kit, kind, count, isDim }: { kit: Kit; kind: 'mask' | 'deny'; count?: number; isDim?: boolean }) {
  const word = count === undefined ? CHIP_WORD[kind] : `${CHIP_WORD[kind]} ${count}`
  return <kit.Text {...(isDim === true ? struct(COLOR[kind], true, { bold: true }) : pill(COLOR[kind]))}>{` ${word} `}</kit.Text>
}

/**
 * A tiny meter of the policy: ten cells, allowed first (`▰▰▰▰▰▰▰▰▱▱`). Each
 * state is one color, unknown is a dim empty cell. Left out when nothing is
 * known. Settled, the cells keep their hue and go dim.
 */
export function PolicyMeter({ kit, counts, isDim, hover }: { kit: Kit; counts: { allow: number; mask: number; deny: number; unknown: number }; isDim: boolean; hover?: TextHoverProps }) {
  const { Text } = kit
  const cells = meterOf(counts)
  if (cells === undefined) return null
  const run = (count: number, glyph: string, color: string | undefined) =>
    count > 0 && (
      <Text color={color} dimColor={color === undefined}>
        {glyph.repeat(count)}
      </Text>
    )
  return (
    <Text {...(hover !== undefined && { hover })}>
      {run(cells.allow, GLYPH.meterOn, COLOR.allow)}
      {run(cells.mask, GLYPH.meterOn, COLOR.mask)}
      {run(cells.deny, GLYPH.meterOn, COLOR.deny)}
      {run(cells.unknown, GLYPH.meterOff, undefined)}
    </Text>
  )
}

/**
 * Beside the meter, over data-bearing fields, terse: `✓ 7`, `◐ 1` and the one
 * loud word, `DENIED 1`. The meter and these show only when something is
 * masked or denied; otherwise the row says AllAllowed.
 */
export function Counts({ kit, counts, isDim }: { kit: Kit; counts: { allow: number; mask: number; deny: number; unknown?: number }; isDim: boolean }) {
  const { Text } = kit
  const parts = [
    counts.allow > 0 && <Text {...struct(COLOR.allow, isDim)}>{`${GLYPH.allow} ${counts.allow}`}</Text>,
    counts.mask > 0 && <Text {...struct(COLOR.mask, isDim)}>{`${GLYPH.mask} ${counts.mask}`}</Text>,
    counts.deny > 0 && <PolicyChip kit={kit} kind="deny" count={counts.deny} isDim={isDim} />,
  ].filter(part => part !== false)
  return <Text>{parts.flatMap((part, index) => (index === 0 ? [part] : [' ', part]))}</Text>
}

/**
 * The policy row when nothing is masked or denied: `✓ all 9 allowed`, the
 * glyph green and the words dim, in place of the meter. When "all" would
 * overclaim (`isAll` false) it is the count, dim, with no check mark. Where
 * row two has no room for the words (`isLong` false) it says `✓ 9`, never cut
 * (src/view/meter.ts allowedShown). It carries the meter's `hover`, so the
 * policy card still lights.
 */
export function AllAllowed({ kit, counts, isAll = true, isLong = true, isWrite = false, hover }: { kit: Kit; counts: { allow: number; unknown?: number }; isAll?: boolean; isLong?: boolean; isWrite?: boolean; hover?: TextHoverProps }) {
  const { Text } = kit
  // A write Agent Services allows says the decision on the write (`✓ write allowed`), not a count of what it returns.
  const isChecked = isWrite || (isAll && (counts.unknown ?? 0) === 0)
  const shown = isWrite ? writeAllowedShown(isLong) : allowedShown(counts, isAll, isLong)
  return (
    <Text {...(hover !== undefined && { hover })}>
      {isChecked && <Text color={COLOR.allow}>{GLYPH.allow}</Text>}
      <Text dimColor>{isChecked ? shown.slice(GLYPH.allow.length) : shown}</Text>
    </Text>
  )
}

const SETTLED: Record<Exclude<CallStatus, 'pending'>, { glyph: string; word: string }> = {
  ran: { glyph: GLYPH.ran, word: 'ran' },
  errored: { glyph: GLYPH.failed, word: 'failed' },
  denied: { glyph: GLYPH.denied, word: 'denied' },
  interrupted: { glyph: GLYPH.failed, word: 'interrupted' },
}

/** The status word for a call whose response is only a sign-in to finish (UPSTREAM_AUTH_REQUIRED, no data). */
export const NEEDS_SIGN_IN = 'needs sign-in'

/**
 * Pending: no status word, only `1 of N` when queued. Settled: the outcome
 * glyph keeps its color (✓ success, ✕ / ! error) and the word goes dim.
 */
export function Status({ kit, status, waiting, outcome, hover }: { kit: Kit; status: CallStatus; waiting: number; outcome?: CallOutcome | undefined; hover?: TextHoverProps }) {
  const { Text } = kit
  const shown = statusOf(status, waiting, outcome)
  if (shown === undefined) return null
  const lit = hover === undefined ? {} : { hover }
  if (shown.glyph === '') return <Text color={COLOR.pending} {...lit}>{shown.word}</Text>
  return (
    <Text {...lit}>
      <Text color={shown.color}>{`${shown.glyph} `}</Text>
      {/* The word alone in its Text, so a reader (and a test) finds exactly `ran`. */}
      <Text dimColor>{shown.word}</Text>
    </Text>
  )
}

/**
 * What Status draws: pending, only `1 of N` when queued (no glyph); settled,
 * the outcome glyph and word. A policy denial is Agent Services doing its job: the
 * counts and the flags say it, never the status. Only failures count. A call
 * that ran is never `✓ ran` when nothing usable came back: a result that is not
 * a GraphQL response says `errors`, and one that is only a sign-in to finish
 * says `needs sign-in`.
 */
export function statusOf(status: CallStatus, waiting: number, outcome?: CallOutcome): { glyph: string; word: string; color: string } | undefined {
  // Pending says nothing: the permission dialog is the question, and a status word reads as the mod's verdict.
  if (status === 'pending') return waiting > 1 ? { glyph: '', word: `1 of ${waiting}`, color: COLOR.pending } : undefined
  const settled = SETTLED[status]
  const shown = { glyph: settled.glyph, word: settled.word, color: status === 'ran' ? COLOR.allow : COLOR.fail as string }
  const errors = outcome?.errors ?? []
  const errorCount = failureCount(outcome)
  // Denials tagged on a preview row are not errors lines any more, but still count here.
  const tagged = (outcome?.preview ?? []).flatMap(list => list.items.flatMap(item => item.denied ?? []))
  const allCount = errors.reduce((sum, error) => sum + (error.count ?? 1), 0) + tagged.length
  // A result that is not a GraphQL response gave nothing to read: its text is RESULT's error line. One Claude Code kept out of the context (too large) did run.
  if (status === 'ran' && outcome?.isUnreadable === true && outcome.isTooLarge !== true) return { glyph: GLYPH.failed, word: 'errors', color: COLOR.fail }
  // Nothing came back because a service needs the person's account linked: RESULT holds the link.
  if (status === 'ran' && outcome?.hasData === false && outcome.authLinks.length > 0) return { glyph: GLYPH.failed, word: NEEDS_SIGN_IN, color: COLOR.mask }
  // The tool call ran, but the response may say otherwise: a GraphQL failure is not a clean run.
  if (status === 'ran' && allCount > 0) {
    if (outcome?.hasData === false) return { glyph: GLYPH.failed, word: 'errors', color: COLOR.fail }
    if (outcome?.hasData === true && errorCount > 0) return { glyph: shown.glyph, word: `ran · ${errorCount} error${errorCount === 1 ? '' : 's'}`, color: COLOR.mask }
  }
  return shown
}

/** A glyph, then text that wraps with a hanging indent under the text, not the glyph. */
export function Note({ kit, glyph, color, isDim, children }: {
  kit: Kit
  glyph: string
  color?: string
  isDim?: boolean
  children?: RenderChildren
}) {
  const { Box, Text } = kit
  return (
    <Box flexDirection="row">
      <Box width={NOTE_GLYPH} flexShrink={0}>
        <Text color={color} bold={color !== undefined && isDim !== true} dimColor={isDim}>
          {glyph}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap" dimColor={isDim}>
          {children}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * An opened section: a dim title (`▾ excerpt`) and the body indented under
 * it. No painted border: the pane is already the container (mod-builder
 * design.md); the /diff mod sets sections apart with dim text and indent.
 */
export function Drawer({ kit, title, marginTop = 0, children }: { kit: Kit; title?: RenderChildren; marginTop?: number; children?: RenderChildren }) {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {title !== undefined && (
        <Text dimColor wrap="wrap">
          {GLYPH.open} {title}
        </Text>
      )}
      <Box flexDirection="column" paddingLeft={DRAWER_INDENT}>
        {children}
      </Box>
    </Box>
  )
}

/** A bulleted item: the bullet in its own column, the content hanging after it. */
export function Bullet({ kit, glyph = GLYPH.bullet, color, children }: { kit: Kit; glyph?: string; color?: string; children?: RenderChildren }) {
  const { Box, Text } = kit
  return (
    <Box flexDirection="row">
      <Box width={BULLET} flexShrink={0}>
        <Text color={color} dimColor={color === undefined}>{glyph}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  )
}

/** A label/value row inside a drawer, on the drawer's wider gutter. */
export function DrawerField({ kit, label, children }: { kit: Kit; label: string; children?: RenderChildren }) {
  return (
    <Field kit={kit} label={label} labelWidth={DRAWER_GUTTER}>
      {children}
    </Field>
  )
}

/** A dim plain Button naming a field a summary cites: `→ excerpt`. */
export function Chip({ kit, id, label, onPress }: { kit: Kit; id: string; label: string; onPress: () => void }) {
  const { Button } = kit
  if (Button === undefined) return null
  return <Button key={id} plain dimColor label={`${GLYPH.chip} ${label}`} onPress={onPress} />
}
