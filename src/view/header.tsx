// The header (facts from the IR only), the rule under it, and the summary
// box beneath.

import type { InspectedCall } from '../../types'
import { leafPolicyCounts } from '../annotate.ts'
import type { CallIR } from '../ir.ts'
import type { Nav } from '../queue.ts'
import { isDestructiveName } from '../risk.ts'
import type { Ctx } from './kit.ts'
import { esc, fallbackLine, refParts } from './kit.ts'
import { Shimmer } from './live/index.tsx'
import { OP_INDENT, cardId, creditOf, positionText, wrapRanges } from './plan.ts'
import type { HeaderPlan, Plan } from './plan.ts'
import { isAllAllowed, isWriteAllowed } from './outcome.ts'
import { idHover, meterHover } from './ui/hover.tsx'
import { ACCENT, AllAllowed, Badge, COLOR, Counts, GLYPH, PolicyMeter, Rule, STRUCT, Status, badgeHue, isMeterShown, statusOf, struct } from './ui/index.tsx'

/**
 * The history: `p: ◂ 20/20 n: ▸`, with `earlier call` before it on a past
 * call, each kept while row two has room (HeaderPlan). Settled calls only
 * have presses; a pending one shows the position as plain dim text. Absent
 * with no history.
 */
function NavControls({ ctx, nav, head }: { ctx: Ctx; nav: Nav | undefined; head: HeaderPlan }) {
  const { kit, act } = ctx
  const { Box, Button, Text } = kit
  if (nav === undefined) return null
  const position = positionText(nav, ctx.columns)
  // The shown call's dot in the accent, the others dim.
  const dots = head.hasPosition && (
    <Text>
      {[...position].map(char => (char === GLYPH.dotOn ? <Text color={ACCENT} bold>{char}</Text> : <Text dimColor>{char}</Text>))}
    </Text>
  )
  if (act === undefined || Button === undefined) return nav.position > 0 && dots !== false ? dots : null
  return (
    <Box flexDirection="row" columnGap={1}>
      {head.hasEarlier && <Text dimColor>earlier call</Text>}
      {nav.older !== undefined && <Button key="older" plain hotkey="p" label={GLYPH.older} onPress={() => act({ cursor: nav.older ?? null })} />}
      {dots}
      {nav.newer !== undefined && <Button key="newer" plain hotkey="n" label={GLYPH.newer} onPress={() => act({ cursor: nav.newer ?? null })} />}
    </Box>
  )
}

/** `r: raw ↗`: opens the raw operation in its own pane. Settled calls only; nothing while pending. */
function RawButton({ ctx }: { ctx: Ctx }) {
  const { act, kit } = ctx
  const { Button } = kit
  if (act === undefined || Button === undefined) return null
  return <Button key="raw" plain hotkey="r" label={`raw ${GLYPH.link}`} onPress={() => act({ toggleRaw: true })} />
}

/**
 * Row one: the badge, `!`, the services and the operation name (default
 * text) on the left, the status word on the right, never shed; an operation
 * name with no room beside the services takes rows of its own under it,
 * broken rather than cut. Row two: the policy on the left (the meter and
 * terse counts when something is masked or denied, else a quiet `✓ all N
 * allowed`), the history and `r: raw ↗` grouped on the right. Absent row two
 * while there is nothing for it. The plan fits both (src/view/plan.ts
 * headerPlan) and counts the rows.
 */
export function Header({ ctx, call, waiting, nav, head }: { ctx: Ctx; call: InspectedCall; waiting: number; nav?: Nav | undefined; head: HeaderPlan }) {
  const { kit } = ctx
  const { Box, Text } = kit
  const { ir } = call
  const isSettled = call.status !== 'pending'
  const isDestructive = ir.roots.some(root => isDestructiveName(root.name))
  const counts = leafPolicyCounts(ir.roots)
  const hasCounts = counts.allow + counts.mask + counts.deny > 0
  // Once the call ran, what the response denied counts against saying every field was allowed.
  const isAll = isAllAllowed(ir, call.status === 'ran' ? call.outcome : undefined)
  // A write Agent Services allows says the decision on the write, not a count of the fields it returns.
  const isWrite = isWriteAllowed(ir, call.status === 'ran' ? call.outcome : undefined)
  const status = statusOf(call.status, waiting, call.outcome)
  const hasMeter = hasCounts && !isWrite && isMeterShown(counts)
  const controls = (
    <Box flexDirection="row" flexShrink={0} columnGap={2}>
      <NavControls ctx={ctx} nav={nav} head={head} />
      <RawButton ctx={ctx} />
    </Box>
  )
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Badge kit={kit} opType={ir.opType} isSettled={isSettled} hover={idHover(cardId.badge())} />
        </Box>
        {/* A narrow sign (⚠ can draw two cells wide); the flags line says which root. */}
        {isDestructive && (
          <Box flexShrink={0}>
            <Text color={COLOR.destructive} bold>{` ${GLYPH.destructiveNarrow}`}</Text>
          </Box>
        )}
        {/* Each a direct child of its Box, so each heats its own card's group. */}
        {head.services !== '' && (
          <Box flexShrink={0} marginLeft={2}>
            <Text dimColor={isSettled} hover={idHover(cardId.services())}>
              {head.services}
            </Text>
          </Box>
        )}
        {ir.opName !== undefined && head.opRows === undefined && (
          <Box flexShrink={0} marginLeft={2}>
            <Text hover={idHover(cardId.op())}>{esc(ir.opName, 200)}</Text>
          </Box>
        )}
        <Box flexGrow={1} minWidth={status !== undefined ? 2 : 0} />
        {status !== undefined && (
          <Box flexShrink={0}>
            <Status kit={kit} status={call.status} waiting={waiting} outcome={call.outcome} hover={idHover(cardId.status())} />
          </Box>
        )}
      </Box>
      {head.opRows !== undefined && (
        <Box paddingLeft={OP_INDENT}>
          <Text hover={idHover(cardId.op())}>{head.opRows.join('\n')}</Text>
        </Box>
      )}
      {head.hasRowTwo && (
        <Box flexDirection="row">
          {/* The meter, or the words in its place, is a direct child of the row, so it heats the policy card's hover group. */}
          {hasMeter && <PolicyMeter kit={kit} counts={counts} isDim={isSettled} hover={meterHover()} />}
          {(hasCounts || isWrite) && !hasMeter && <AllAllowed kit={kit} counts={counts} isAll={isAll} isLong={head.isAllowedLong} isWrite={isWrite} hover={meterHover()} />}
          {head.hasCounts && (
            <Box flexShrink={0}>
              <Text>
                {'  '}
                <Counts kit={kit} counts={counts} isDim={isSettled} />
              </Text>
            </Box>
          )}
          <Box flexGrow={1} minWidth={1} />
          {!head.isControlsBelow && controls}
        </Box>
      )}
      {head.isControlsBelow && (
        <Box flexDirection="row">
          <Box flexGrow={1} minWidth={1} />
          {controls}
        </Box>
      )}
    </Box>
  )
}

/**
 * The rule under the header, one plain rule from edge to edge: faint for a
 * read, in the badge's hue for a write or a watch.
 */
export function HeaderRule({ ctx, opType }: { ctx: Ctx; opType?: CallIR['opType'] }) {
  return <Rule kit={ctx.kit} cells={Math.max(1, ctx.columns)} {...(opType !== 'query' && { hue: badgeHue(opType) })} />
}

/**
 * The headline, boxed so the eye lands on it: a rounded border in the
 * structure hue (its one saturated use), drawn by hand, with the dim
 * `summary · Haiku` eyebrow on the row above it at its left edge, so the box
 * holds only Haiku's words. They are at full strength, wrapped here to the
 * lines the plan counted, never cut. While Haiku is reading the scale
 * shimmers in the same box; if it failed, the scale shows dim and there is
 * no eyebrow.
 */
export function SummaryLine({ ctx, ir, plan }: { ctx: Ctx; ir: CallIR; plan: Plan['summary'] }) {
  const { kit } = ctx
  const { Box, Text } = kit
  const { summary } = ir
  if (plan.rows === 0) return null
  const width = Math.max(4, ctx.columns)
  const inside = width - 4
  // Haiku is still reading and the call has not settled: the scale shimmers where the headline will land.
  const isShimmering = summary === undefined && ir.isSummarizing === true && !ctx.isSettled
  const border = struct(STRUCT.box)
  const side = <Text {...border}>{GLYPH.boxSide}</Text>
  const top = `${GLYPH.boxTop}${GLYPH.rule.repeat(width - 2)}${GLYPH.boxTopEnd}`
  const row = (content: unknown) => (
    <Box flexDirection="row">
      {side}
      <Text>{' '}</Text>
      <Box width={inside} flexShrink={0}>
        {content as never}
      </Box>
      <Text>{' '}</Text>
      {side}
    </Box>
  )
  // Bold where the headline cites a field; the text is split into the lines the plan counted.
  const parts = summary === undefined ? [{ text: fallbackLine(ir).replace(/\s+/g, ' ').trim(), isBold: false }] : refParts(summary.headline).map(part => ({ text: part.text.replace(/\s+/g, ' '), isBold: 'ref' in part && part.ref !== undefined }))
  const text = parts.map(part => part.text).join('')
  const lead = text.length - text.trimStart().length
  const plain = text.trim()
  const boldAt: boolean[] = []
  for (const part of parts) for (let i = 0; i < part.text.length; i++) boldAt.push(part.isBold)
  const lines = isShimmering ? [] : wrapRanges(plain, inside)
  const runs = (start: number, end: number) => {
    const out: { text: string; isBold: boolean }[] = []
    for (let i = start; i < end; i++) {
      const isBold = boldAt[i + lead] === true
      const last = out[out.length - 1]
      if (last !== undefined && last.isBold === isBold) last.text += plain[i]
      else out.push({ text: plain[i] ?? '', isBold })
    }
    return out
  }
  return (
    <Box flexDirection="column">
      {/* The trust signal, an eyebrow over the box rather than inside it. */}
      {plan.hasCredit && (
        <Text dimColor hover={idHover(cardId.credit())}>
          {creditOf()}
        </Text>
      )}
      <Text {...border}>{top}</Text>
      {isShimmering
        ? row(<Shimmer kit={kit} id="headline" text={plain} />)
        : lines.map(([start, end]) =>
            row(
              // The hero line: full strength in the theme's text color, never dim; the fallback is dim.
              <Text {...(summary === undefined ? { dimColor: true } : { color: 'text' })} wrap="truncate-end">
                {runs(start, end).map(run => (run.isBold ? <Text bold>{run.text}</Text> : run.text))}
              </Text>,
            ),
          )}
      <Text {...border}>{`${GLYPH.boxBottom}${GLYPH.rule.repeat(width - 2)}${GLYPH.boxBottomEnd}`}</Text>
    </Box>
  )
}
