// The header (facts from the IR only), the rule under it, and the summary
// prose beneath.

import type { InspectedCall } from '../../types'
import { leafPolicyCounts } from '../annotate.ts'
import type { CallIR } from '../ir.ts'
import type { ResolvedNav as Nav } from '../queue.ts'
import { isDestructiveName } from '../risk.ts'
import type { Ctx } from './kit.ts'
import { esc, refParts } from './kit.ts'
import { Shimmer } from './live/index.tsx'
import { OP_INDENT, SUMMARY_INDENT, cardId, creditOf, positionText, wrapRanges } from './plan.ts'
import type { HeaderPlan, Plan } from './plan.ts'
import { isAllAllowed, isWriteAllowed } from './outcome.ts'
import { idHover, meterHover } from './ui/hover.tsx'
import { badgeOf, callStatusOf, profileOf, subjectOf } from './kinds.ts'
import { STRUCT, DATA, ACCENT, AllAllowed, COLOR, Counts, GLYPH, PolicyMeter, QUIET, Status, TEXT, isMeterShown } from './ui/index.tsx'

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
    <Text color={QUIET}>
      {[...position].map(char => (char === GLYPH.dotOn ? <Text color={ACCENT} bold>{char}</Text> : <Text color={QUIET}>{char}</Text>))}
    </Text>
  )
  if (act === undefined || Button === undefined) return nav.position > 0 && dots !== false ? dots : null
  return (
    <Box flexDirection="row" columnGap={1}>
      {head.hasEarlier && <Text color={QUIET}>earlier call</Text>}
      {nav.older !== undefined && <Button key="older" plain hotkey="p" label={GLYPH.older} onPress={() => act({ selection: nav.older ?? { kind: 'live' } })} />}
      {dots}
      {nav.newer !== undefined && <Button key="newer" plain hotkey="n" label={GLYPH.newer} onPress={() => act({ selection: nav.newer ?? { kind: 'live' } })} />}
    </Box>
  )
}

/**
 * Row one: the badge, `!`, the services and the operation name (default
 * text) on the left, the status word on the right, never shed; an operation
 * name with no room beside the services takes rows of its own under it,
 * broken rather than cut. Row two: the policy on the left (the meter and
 * terse counts when something is masked or denied, else a quiet `✓ all N
 * allowed`), the history and Checks grouped on the right. Absent row two
 * while there is nothing for it. The plan fits both (src/view/plan.ts
 * headerPlan) and counts the rows.
 */
export function Header({ ctx, call, waiting, nav, head }: { ctx: Ctx; call: InspectedCall; waiting: number; nav?: Nav | undefined; head: HeaderPlan }) {
  const { kit } = ctx
  const { Box, Text, Button } = kit
  const { ir } = call
  const isDestructive = ir.roots.some(root => isDestructiveName(root.name))
  const showPolicy = !ctx.isSettled || call.tool === 'dry_run'
  const counts = showPolicy ? leafPolicyCounts(ir.roots) : { allow: 0, mask: 0, deny: 0, unknown: 0 }
  const hasCounts = counts.allow + counts.mask + counts.deny > 0
  // Once the call ran, what the response denied counts against saying every field was allowed.
  const isAll = isAllAllowed(ir, call.status === 'ran' ? call.outcome : undefined)
  // A write Agent Services allows says the decision on the write, not a count of the fields it returns.
  const isWrite = showPolicy && isWriteAllowed(ir, call.status === 'ran' ? call.outcome : undefined)
  const status = callStatusOf(call, waiting)
  const badge = badgeOf(call)
  // A lookup is named by what it asked; validate and dry_run by their operation's name, as an execute is.
  const subject = subjectOf(call) ?? (ir.opName === undefined ? undefined : esc(ir.opName, 200))
  const isDestructiveShown = isDestructive && profileOf(call).flags
  const hasMeter = hasCounts && !isWrite && isMeterShown(counts)
  const checks = head.hasChecks && (ctx.act !== undefined && Button !== undefined
    ? <Button key="checks" plain label="Checks" hover={idHover(cardId.checks())} onPress={() => ctx.act?.({ detail: ctx.ui.detail?.callId === call.id && ctx.ui.detail.detailId === 'checks' ? null : { callId: call.id, detailId: 'checks' } })}><Text color={QUIET}>Checks</Text></Button>
    : <Text color={QUIET} hover={idHover(cardId.checks())}>Checks</Text>)
  const controls = (
    <Box flexDirection="row" flexShrink={0} columnGap={2}>
      {checks}
      <NavControls ctx={ctx} nav={nav} head={head} />
    </Box>
  )
  const separator = (
    <Box flexGrow={1} minWidth={1} paddingRight={1} justifyContent="flex-end">
      <Text color={STRUCT.guide}>{GLYPH.rule.repeat(head.separatorCells)}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={call.tool === undefined && ir.opType === 'mutation' ? COLOR.write : ACCENT} bold hover={idHover(cardId.badge())}>{` ${badge.word} `}</Text>
        </Box>
        {/* A narrow sign (⚠ can draw two cells wide); the flags line says which root. */}
        {isDestructiveShown && (
          <Box flexShrink={0}>
            <Text color={COLOR.destructive} bold>{` ${GLYPH.destructiveNarrow}`}</Text>
          </Box>
        )}
        {/* Each a direct child of its Box, so each heats its own card's group. */}
        {head.services !== '' && (
          <Box flexShrink={0} marginLeft={2}>
            <Text color={DATA} hover={idHover(cardId.services())}>
              {head.services}
            </Text>
          </Box>
        )}
        {subject !== undefined && head.opRows === undefined && (
          <Box flexShrink={0} marginLeft={2}>
            <Text color={TEXT} bold hover={idHover(cardId.op())}>{subject}</Text>
          </Box>
        )}
        <Box flexGrow={1} minWidth={status !== undefined ? 2 : 0} />
        {status !== undefined && (
          <Box flexShrink={0}>
            <Status kit={kit} status={call.status} waiting={waiting} outcome={call.outcome} hover={idHover(cardId.status())} shown={status} />
          </Box>
        )}
      </Box>
      {head.opRows !== undefined && (
        <Box paddingLeft={OP_INDENT}>
          <Text color={TEXT} bold hover={idHover(cardId.op())}>{head.opRows.join('\n')}</Text>
        </Box>
      )}
      {head.hasRowTwo && (
        <Box flexDirection="row">
          {/* The meter, or the words in its place, is a direct child of the row, so it heats the policy card's hover group. */}
          {hasMeter && <PolicyMeter kit={kit} counts={counts} isDim={false} hover={meterHover()} />}
          {(hasCounts || isWrite) && !hasMeter && <AllAllowed kit={kit} counts={counts} isAll={isAll} isLong={head.isAllowedLong} isWrite={isWrite} hover={meterHover()} />}
          {head.hasCounts && (
            <Box flexShrink={0}>
              <Text color={TEXT}>
                {'  '}
                <Counts kit={kit} counts={counts} isDim={false} />
              </Text>
            </Box>
          )}
          {head.isControlsBelow ? <Box flexGrow={1} minWidth={1} /> : separator}
          {!head.isControlsBelow && controls}
        </Box>
      )}
      {head.isControlsBelow && (
        <Box flexDirection="row">
          {separator}
          {controls}
        </Box>
      )}
    </Box>
  )
}

/**
 * The headline in a frame with an inset category and bottom-edge model credit.
 * Very narrow panes retain indented prose. While the summary is
 * pending, the fallback line shimmers; after a failure, it stays dim and
 * has no model credit.
 */
export function SummaryLine({ ctx, ir, plan }: { ctx: Ctx; ir: CallIR; plan: Plan['summary'] }) {
  const { kit } = ctx
  const { Box, Text } = kit
  const { summary } = ir
  if (plan.rows === 0) return null
  const inside = Math.max(1, ctx.columns - (plan.isFramed ? 4 : SUMMARY_INDENT))
  // Haiku is still reading and the call has not settled: the scale shimmers where the headline will land.
  const isShimmering = summary === undefined && ir.isSummarizing === true && !ctx.isSettled
  const row = (content: unknown) => plan.isFramed ? (
    <Box flexDirection="row">
      <Text color={STRUCT.box}>{`${GLYPH.boxSide} `}</Text>
      <Box width={inside} flexShrink={0}>{content as never}</Box>
      <Text color={STRUCT.box}>{` ${GLYPH.boxSide}`}</Text>
    </Box>
  ) : (
    <Box paddingLeft={SUMMARY_INDENT}>
      <Box width={inside} flexShrink={0}>{content as never}</Box>
    </Box>
  )
  // Bold where the headline cites a field; the text is split into the lines the plan counted.
  // The factual fallback until Haiku's headline lands: the plan's text, as it counted it.
  const parts = summary === undefined ? [{ text: plan.text, isBold: false }] : refParts(summary.headline).map(part => ({ text: part.text.replace(/\s+/g, ' '), isBold: 'ref' in part && part.ref !== undefined }))
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
      {plan.isFramed && (
        <Text color={STRUCT.box}>
          {`${GLYPH.boxTop}─ `}<Text color={ACCENT}>SUMMARY</Text>{` ${GLYPH.rule.repeat(Math.max(0, ctx.columns - 12))}${GLYPH.boxTopEnd}`}
        </Text>
      )}
      {!plan.isFramed && plan.hasCredit && (
        <Text color={QUIET} hover={idHover(cardId.credit())}>
          {creditOf()}
        </Text>
      )}
      {isShimmering
        ? row(<Shimmer kit={kit} id="headline" text={plain} />)
        : lines.map(([start, end]) =>
            row(
              // The hero line: full strength in the theme's text color, never dim; the fallback is dim.
              <Text color={summary === undefined ? QUIET : TEXT} wrap="truncate-end">
                {runs(start, end).map(run => (run.isBold ? <Text bold>{run.text}</Text> : run.text))}
              </Text>,
            ),
          )}
      {plan.isFramed && (
        <Box flexDirection="row">
          <Text color={STRUCT.box}>{`${GLYPH.boxBottom}${GLYPH.rule.repeat(Math.max(0, ctx.columns - (plan.hasCredit ? 9 : 2)))}${plan.hasCredit ? ' ' : ''}`}</Text>
          {plan.hasCredit && <Text color={QUIET} hover={idHover(cardId.credit())}>{creditOf()}</Text>}
          <Text color={STRUCT.box}>{`${plan.hasCredit ? ' ' : ''}${GLYPH.boxBottomEnd}`}</Text>
        </Box>
      )}
    </Box>
  )
}
