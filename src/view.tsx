// The pane's drawing. Pure apart from the element table handed in.
//
// Reads first as a sentence, then as a short form: the header, the summary,
// a strip of notes on anything unusual, then the root field and its
// arguments, what comes back, and access. Facts in the header and notes come
// from the IR only; the summary never sets the badge, counts or colors.
// Every string from the call, schema or summary is escaped before it is
// drawn, and names are always real names (aliases only in the raw view).
//
// Built from the components in ./view/ui (modelled on the /diff mod's
// sections): the engine's flexbox does the layout.
//
// Presses do not arrive while a permission dialog is open, so a pending call
// draws everything that matters inline and no Buttons. The header's history
// and raw controls and the field drawers come once the call has settled; the
// raw operation has its own pane (src/view/raw.tsx).

import type { RenderNode, RenderSurface, TextHoverProps } from 'claude-code'

import type { InspectedCall } from '../types'
import { configOf, linksOf, openableUrl } from './links.ts'
import type { LinkConfig } from './links.ts'
import type { Nav, Shown } from './queue.ts'
import { annotationIndex } from './view/annotations.ts'
import { RootForm } from './view/form.tsx'
import { Header, HeaderRule, SummaryLine } from './view/header.tsx'
import type { Act, Ctx, Kit, PaneUi } from './view/kit.ts'
import { CLOSED, esc } from './view/kit.ts'
import { listNames } from './view/notes.ts'
import { OPENED_INDENT, REQUEST_LABEL, ROW_INDENT, RESULT_INDENT, cardId, cellWidth, closedItem, fieldNameColumn, fieldValueText, hostOf, isHostBeside, openedFields, isResultInline, linkFacts, linkLabel, listKey, nameRows, planOf, moreKey, moreLabel, previewItemRows, previewLayout, previewLead, requestRows, rowKey, shownLabel, wrapLines } from './view/plan.ts'
import type { Plan, RootPlan } from './view/plan.ts'
import type { ResultLine } from './view/outcome.ts'
import { ACCENT, COLOR, NOTE_GLYPH, Note, RIGHT_PAD, STRUCT, statusOf, struct } from './view/ui/index.tsx'
import { GLYPH } from './view/ui/theme.ts'
import { REQUEST_TEXT, requestDraftFor } from './view/flags.ts'
import { Shimmer } from './view/live/index.tsx'
import { Fact, Frame, Para, agentHover, detailCards, flagsHover, headerCards, idHover, linkHover, linkScope, trustHover } from './view/ui/hover.tsx'
import { TRUST_FILE } from './view/trust.ts'
import { RowTip, markdownLink, previewHover, previewScope, resultCards, toggleCards } from './view/ui/preview-cards.tsx'
import { Changes, ConfirmCard, ConfirmLine, changeCards } from './view/diff.tsx'

export type { Act, Kit, PaneChange, PaneUi } from './view/kit.ts'
export { RawView } from './view/raw.tsx'
export { CLOSED } from './view/kit.ts'

function Unparseable({ ctx, call }: { ctx: Ctx; call: InspectedCall }) {
  const { Box, Text, Code } = ctx.kit
  return (
    <Box flexDirection="column">
      <Text color={COLOR.fail} wrap="wrap">
        {`Could not read this operation (${esc(call.ir.failure ?? call.inputError ?? 'unknown reason', 300)}). Showing it as sent:`}
      </Text>
      <Code source={esc(call.operation)} language="graphql" wrap="wrap" />
      {call.variables !== '' && <Code source={esc(call.variables)} language="json" wrap="wrap" />}
    </Box>
  )
}

/** Where and how the pane is shown; all optional. */
export type ViewOptions = {
  /** `e.props.isFocused`. Accepted, unused: the buttons say their own keys. */
  isFocused?: boolean
  /** `e.surface`: off the terminal, sections get a row more air. */
  surface?: RenderSurface
  /** `e.props.scroll.bodyRows`: the plan's row budget, and the rows in view a hover card opens into (below its trigger or above, toward the larger side). */
  bodyRows?: number
  /** `e.props.scroll.offset`: the first row in view, so a hover card opens toward the room in view on a pane that scrolls. */
  scrollOffset?: number
  /** Where the pane stands in its history (src/queue.ts navOf); absent with one call or none. */
  nav?: Nav
  /** Deep-link bases and extra templates (src/links.ts configOf of the plugin's options). */
  links?: LinkConfig
  /** Calls waiting at their prompts (`1 of N` in the header); viewOf passes its own. */
  waiting?: number
}

/**
 * The notes strip: one Note per unusual fact with no other home on the pane
 * (a field drawn with its mark in a return tree is not one). Absent when
 * there is none. Settled, all dim.
 */
function Notes({ ctx, plan, gap }: { ctx: Ctx; plan: Plan['notes']; gap: number }) {
  const { kit } = ctx
  const { Box, Text } = kit
  const notes = plan.all
  if (plan.shown.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={gap}>
      {plan.shown.map(shown => {
        const note = notes[shown.index]
        if (note === undefined) return null
        // Live while enrichment runs; settled calls never shimmer.
        if (note.glyph === GLYPH.checking && !ctx.isSettled) return <Shimmer kit={kit} text={note.text} />
        // A field's line keeps its name at full strength: the name is content, its policy word the dim detail.
        const isDim = (ctx.isSettled && note.detail === undefined) || note.isDim === true
        const color = isDim || note.detail !== undefined ? undefined : note.color
        // The glyph keeps its hue, dim once settled: a policy note's color, else its structural hue (◆ personal, ↯ limit).
        const glyphColor = note.isDim === true ? undefined : (note.color ?? NOTE_HUE[note.glyph])
        return (
          <Note kit={kit} glyph={note.glyph} {...(glyphColor !== undefined && { color: glyphColor })} {...(isDim && { isDim: true })}>
            <Text color={color}>{note.text}</Text>
            {note.names !== undefined && ` ${listNames(note.names, shown.names)}`}
            {note.detail !== undefined && <Text dimColor>{`  ${note.detail}`}</Text>}
            {shown.hasHint && note.hint !== undefined && <Text dimColor>{` · ${note.hint}`}</Text>}
            {shown.more !== undefined && <Text dimColor>{` +${shown.more} more`}</Text>}
          </Note>
        )
      })}
    </Box>
  )
}

/** A note glyph's structural hue, when the note has no policy color of its own. */
const NOTE_HUE: Record<string, string> = { [GLYPH.personal]: STRUCT.personal, [GLYPH.limit]: STRUCT.limit }

/**
 * What the call did, once it settled: errors and links to fix first, then
 * how many rows came back, each list a group under its bold head with its
 * rows nested beneath. Response data takes the pane's width: the lines sit
 * under the label (one list or value rides on the label row), the rows
 * under their head, each key in one column and what follows it wrapping
 * beside it, never cut. A record key is a link, in the link blue. Response
 * content, escaped (src/view/outcome.ts).
 */
function Result({ ctx, plan, gap }: { ctx: Ctx; plan: Plan['result']; gap: number }) {
  const { kit } = ctx
  const { Box, Text } = kit
  if (plan.lines.length === 0) return null
  const isInline = isResultInline(plan.lines)
  const [first] = plan.lines
  return (
    <Box flexDirection="column" marginTop={gap}>
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text>
            <Text color={STRUCT.bar}>{`${GLYPH.section} `}</Text>
            <Text bold color={STRUCT.result}>
              RESULT
            </Text>
            {isInline && '  '}
          </Text>
        </Box>
        {isInline && first !== undefined && (
          <Box flexGrow={1} flexShrink={1}>
            <ResultLineView ctx={ctx} line={first} index={0} />
          </Box>
        )}
      </Box>
      {plan.lines.map((line, index) =>
        isInline && index === 0 ? null : line.kind === 'preview' ? (
          <PreviewRows ctx={ctx} line={line} />
        ) : (
          <Box paddingLeft={RESULT_INDENT}>
            <ResultLineView ctx={ctx} line={line} index={index} />
          </Box>
        ),
      )}
    </Box>
  )
}

/** One RESULT line that is not a list's rows: a rows or value line (which lights the card saying what it means, by its `index` among RESULT's lines), an error, an auth link. */
function ResultLineView({ ctx, line, index }: { ctx: Ctx; line: ResultLine; index: number }) {
  const { kit } = ctx
  const { Box, Text, Link } = kit
  if (line.kind === 'rows' || line.kind === 'scalar') {
    const isHead = line.kind === 'rows' && line.isHead === true
    const numberTone = line.kind === 'rows' && line.isWarn === true ? { color: COLOR.mask, bold: true } : struct(STRUCT.number, false, { bold: true })
    return (
      <Text wrap="wrap" hover={idHover(cardId.line(index))}>
        <Text bold={isHead}>{line.field}</Text>
        {line.field !== '' && <Text dimColor>{'  '}</Text>}
        {line.kind === 'scalar' && line.isDim === true ? <Text dimColor>{line.text}</Text> : <Text {...numberTone}>{line.text}</Text>}
        {line.kind === 'rows' && line.note !== undefined && <Text dimColor>{`${GLYPH.separator}${line.note}`}</Text>}
      </Text>
    )
  }
  if (line.kind === 'confirm') {
    // What the response said back of a write's new values.
    return <ConfirmLine ctx={ctx} line={line} />
  }
  if (line.kind === 'weight') {
    // How much of Claude's context the response used: dim, and a trigger for the card that lists the heavy fields.
    return (
      <Text wrap="wrap" dimColor hover={idHover(cardId.weight())}>
        {line.text}
      </Text>
    )
  }
  if (line.kind === 'error') {
    // A requestable denial, settled and pressable: its words, then its classification and a press that drafts the request for this field.
    const { Box, Text, Button } = kit
    const act = ctx.act
    if (line.request !== undefined && ctx.isSettled && act !== undefined && Button !== undefined) {
      const draft = requestDraftFor([line.request], ctx.opName) ?? ''
      const width = Math.max(1, ctx.columns - RESULT_INDENT - NOTE_GLYPH)
      const facts = line.facts ?? ''
      const press = <Button key={`request:${line.request.what}`} plain label={REQUEST_LABEL} onPress={() => act({ draftPrompt: draft })} />
      return (
        <Box flexDirection="column">
          <Note kit={kit} glyph={GLYPH.deny} color={COLOR.fail}>
            {line.head ?? line.text}
          </Note>
          <Box flexDirection="row" paddingLeft={NOTE_GLYPH}>
            {requestRows(facts, width).isOneRow ? (
              <Box flexDirection="row">
                {facts !== '' && <Text dimColor>{`${facts} · `}</Text>}
                {press}
              </Box>
            ) : (
              <Box flexDirection="column">
                {facts !== '' && (
                  <Text dimColor wrap="wrap">
                    {facts}
                  </Text>
                )}
                {press}
              </Box>
            )}
          </Box>
        </Box>
      )
    }
    // Agent Services said so: the one place a settled pane keeps red.
    return (
      <Note kit={kit} glyph={line.isDenied ? GLYPH.deny : GLYPH.failed} color={COLOR.fail}>
        {line.text}
      </Note>
    )
  }
  if (line.kind === 'auth') {
    // Where the link goes, beside it: the host is the trust signal.
    if (line.url !== null && canOpen(ctx)) {
      // The host whole beside the label, or not at all (the label still opens it): never cut mid-name.
      const isHostShown = isHostBeside(line.text, line.host, ctx.columns - RESULT_INDENT - NOTE_GLYPH)
      return (
        <Box flexDirection="row">
          <Box width={NOTE_GLYPH} flexShrink={0}>
            <Text>{GLYPH.link}</Text>
          </Box>
          <Box flexShrink={1}>
            <LinkLabel ctx={ctx} id={`auth:${line.service}`} url={line.url} label={line.text} />
          </Box>
          {isHostShown && (
            <Box flexShrink={0}>
              <Text dimColor>{`  ${line.host}`}</Text>
            </Box>
          )}
        </Box>
      )
    }
    return (
      <Note kit={kit} glyph={GLYPH.link}>
        {line.url !== null && Link !== undefined ? <Text color={COLOR.link}><Link href={line.url} label={`[${line.text}]`} /></Text> : line.text}
        {line.host !== undefined && <Text dimColor>{`  ${line.host}`}</Text>}
        {line.url !== null && Link === undefined && <Text dimColor>{` ${line.url}`}</Text>}
      </Note>
    )
  }
  return null
}

/** Cells a title-only row's tip needs after the key to say anything. */
const TIP_MIN = 12

/**
 * A list's rows under its head: the key in the group's column, what follows
 * it wrapping beside it from the pane's value column where the key leaves
 * room (src/view/plan.ts previewLayout), the denial tags lined up in a column
 * of their own. The whole row is the hover trigger (its card, and for a
 * record its tip). A record's key is bracketed and drawn as a link: Markdown
 * whose link a plain click presses (`openUrl`), its label inline code so it
 * takes a fixed blue rather than the palette's (src/view/ui/preview-cards.tsx
 * markdownLink); else a plain Button (no color of its own); else the engine
 * Link (a prompt is up).
 */
function PreviewRows({ ctx, line }: { ctx: Ctx; line: Extract<ResultLine, { kind: 'preview' }> }) {
  const { kit } = ctx
  const { Box, Text, Link, Markdown } = kit
  const rowWidth = Math.max(1, ctx.columns - ROW_INDENT)
  const layout = previewLayout(line.items, rowWidth, ctx.column)
  const { column, gap, tagAt } = layout
  // Two roots' lists can share a field name: keys and scopes carry the root too.
  const list = listKey(line)
  return (
    <Box flexDirection="column">
      {line.items.map((item, index) => {
        const scope = previewScope(list, index)
        // A row with fields opens out under itself (▸/▾ in the two cells before its key); hover is the peek, the press pins it open.
        const key = ctx.callId === undefined ? undefined : rowKey(ctx.callId, list, index)
        const isOpen = key !== undefined && ctx.ui.row === key
        // Closed, the key and the text hold to a few rows, cut with `…` (closedItem); opened, the row says all of it, then its fields.
        const closed = closedItem(item, rowWidth, layout)
        const drawn = isOpen ? item : closed.item
        const toggle = <RowToggle ctx={ctx} item={item} rowAt={key} isOpen={isOpen} isCut={closed.isCut} hover={idHover(cardId.toggle(list, index))} />
        const opened = isOpen ? <OpenedRow ctx={ctx} item={item} /> : null
        // With no key column (a list of titles) the key wraps across the row; in one, a key too long for it wraps in it.
        const shown = shownLabel(drawn)
        const url = item.url
        const act = ctx.act
        const keyElement =
          url !== undefined && Markdown !== undefined && act !== undefined ? (
            <Markdown key={`open:row:${list}:${index}`} text={markdownLink(shown, url)} onLinkPress={() => act({ openUrl: url })} pressableLinks={[url]} />
          ) : url !== undefined && canOpen(ctx) ? (
            <OpenButton ctx={ctx} id={`row:${list}:${index}`} url={url} label={shown} hover={previewHover(list, index)} />
          ) : (
            <Text wrap="wrap" hover={previewHover(list, index)} {...(url !== undefined && { color: COLOR.link })}>
              {url !== undefined && Link !== undefined ? <Link href={url} label={shown} /> : shown}
            </Text>
          )
        if (column === null) {
          // The tip after the key's last row, where it leaves room for one.
          const keyRows = wrapLines(shown, rowWidth)
          const after = ROW_INDENT + cellWidth(keyRows[keyRows.length - 1] ?? '') + 2
          return (
            <Box key={`item:${scope}`} flexDirection="column">
              <Box key={`row:${scope}`} flexDirection="row" paddingLeft={ROW_INDENT - 2} hover={{ scope }}>
                {toggle}
                <Box flexGrow={1} flexShrink={1}>
                  {keyElement}
                </Box>
                {url !== undefined && ctx.columns - after >= TIP_MIN && <RowTip ctx={ctx} scope={scope} url={url} left={after} top={keyRows.length - 1} rows={1} />}
              </Box>
              {opened}
            </Box>
          )
        }
        const lead = previewLead(drawn)
        const pad = tagAt === undefined || (item.denied ?? []).length === 0 ? 0 : Math.max(0, tagAt - cellWidth(lead))
        return (
          <Box key={`item:${scope}`} flexDirection="column">
            <Box key={`row:${scope}`} flexDirection="row" paddingLeft={ROW_INDENT - 2} hover={{ scope }}>
              {toggle}
              <Box width={column} flexShrink={0}>
                {keyElement}
              </Box>
              <Box flexGrow={1} flexShrink={1} marginLeft={gap}>
                <Text wrap="wrap" hover={previewHover(list, index)}>
                  {drawn.text !== undefined && <Text>{drawn.text}</Text>}
                  {item.extra !== undefined && <Text {...struct(STRUCT.date)}>{`${item.text === undefined ? '' : '  '}${item.extra}`}</Text>}
                  {pad > 0 && ' '.repeat(pad)}
                  {/* Denied on the row that owns it: the mark red, the name quiet, so the summary box stays the loudest thing. */}
                  {(item.denied ?? []).map((one, at) => (
                    <Text>
                      {lead !== '' || pad > 0 || at > 0 ? '  ' : ''}
                      <Text color={COLOR.deny}>{GLYPH.deny}</Text>
                      <Text dimColor>{` ${one.field}`}</Text>
                    </Text>
                  ))}
                </Text>
              </Box>
              {url !== undefined && <RowTip ctx={ctx} scope={scope} url={url} left={ROW_INDENT + column + gap} rows={previewItemRows(drawn, rowWidth, layout)} />}
            </Box>
            {opened}
          </Box>
        )
      })}
      {(line.more > 0 || line.expand === 'less') && (
        <Box paddingLeft={ROW_INDENT}>
          {/* `… 3 more` opens the list out to every kept row; `show fewer` folds it back. */}
          {line.expand !== undefined && ctx.act !== undefined && kit.Button !== undefined && ctx.callId !== undefined ? (
            <kit.Button key={`more:${list}`} plain label={moreLabel(line)} onPress={() => ctx.act?.({ more: line.expand === 'more' && ctx.callId !== undefined ? moreKey(ctx.callId, list) : null })} />
          ) : (
            <Text dimColor wrap="wrap">
              {moreLabel(line)}
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}


/**
 * `▸` on a row with more to show (fields to open out, or text cut closed),
 * `▾` while it is open; two blank cells otherwise, so keys stay in one
 * column. It lights its own card, which says what a press opens.
 */
function RowToggle({ ctx, item, rowAt, isOpen, isCut, hover }: { ctx: Ctx; item: Extract<ResultLine, { kind: 'preview' }>['items'][number]; rowAt: string | undefined; isOpen: boolean; isCut: boolean; hover: TextHoverProps }) {
  const { Box, Button } = ctx.kit
  const act = ctx.act
  const canToggle = rowAt !== undefined && act !== undefined && Button !== undefined && (openedFields(item).length > 0 || isCut)
  return (
    <Box width={2} flexShrink={0}>
      {canToggle && <Button key={`toggle:${rowAt}`} plain label={isOpen ? GLYPH.open : GLYPH.closed} hover={hover} onPress={() => act({ row: isOpen ? null : rowAt })} />}
    </Box>
  )
}

/**
 * A row opened out: every field it kept, one a row under it, names in one
 * column, a denied field said so, and a value on a configured https host a
 * link a click opens (the permalink the card could only show).
 */
function OpenedRow({ ctx, item }: { ctx: Ctx; item: Extract<ResultLine, { kind: 'preview' }>['items'][number] }) {
  const { Box, Text } = ctx.kit
  const config = ctx.links ?? configOf(undefined)
  const width = Math.max(1, ctx.columns - OPENED_INDENT)
  const names = fieldNameColumn(item, width)
  return (
    <Box flexDirection="column" paddingLeft={OPENED_INDENT}>
      {openedFields(item).map((field, index) => {
        const url = field.value === undefined ? undefined : openableUrl(field.value, config)
        return (
          <Box key={`field:${index}`} flexDirection="row">
            {/* A name wider than its column breaks into rows there (nameRows), as the plan counts it. */}
            <Box width={names} flexShrink={0}>
              <Text dimColor>{nameRows(field.name, names).join('\n')}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} marginLeft={2}>
              {field.denial !== undefined ? (
                <Text wrap="wrap">
                  <Text color={COLOR.deny}>{GLYPH.deny}</Text>
                  <Text dimColor>{fieldValueText(field, false).slice(GLYPH.deny.length)}</Text>
                </Text>
              ) : url !== undefined ? (
                <LinkLabel ctx={ctx} id={`field:${index}:${url}`} url={url} label={url} />
              ) : (
                <Text wrap="wrap">{field.value ?? ''}</Text>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The flags line, directly under the summary box: the call's surprises and
 * risks, computed (never Haiku's), most important first, ` · ` between them.
 * It wraps and is never cut; its hover card says each one in full.
 */
function Flags({ ctx, plan }: { ctx: Ctx; plan: Plan['flags'] }) {
  const { kit } = ctx
  const { Box, Text } = kit
  if (plan.all.length === 0) return null
  const worst = plan.all.some(flag => flag.tone === 'deny' || flag.tone === 'write') ? COLOR.deny : COLOR.mask
  return (
    <Box flexDirection="row">
      <Box width={NOTE_GLYPH} flexShrink={0}>
        <Text color={worst} hover={flagsHover()}>
          {GLYPH.flag}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        <Text wrap="wrap" hover={flagsHover()}>
          {plan.all.map((flag, index) => (
            <Text>
              {index > 0 && <Text dimColor>{GLYPH.separator}</Text>}
              {flag.text}
              {flag.request !== undefined && plan.draft === undefined && <Text>{`${GLYPH.separator}${REQUEST_TEXT}`}</Text>}
            </Text>
          ))}
        </Text>
        {/* Settled: the request is a press that drafts it into the prompt box, never one that files it. */}
        {plan.draft !== undefined && <RequestButton ctx={ctx} draft={plan.draft} />}
      </Box>
    </Box>
  )
}

/** `a: draft access request`: puts the request in the prompt box (`draftPrompt`); the person sends it, and Claude asks before filing. */
function RequestButton({ ctx, draft }: { ctx: Ctx; draft: string }) {
  const { Box, Button } = ctx.kit
  const act = ctx.act
  if (Button === undefined || act === undefined) return null
  return (
    <Box flexDirection="row">
      <Button key="request:draft" plain hotkey="a" label="draft access request" onPress={() => act({ draftPrompt: draft })} />
    </Box>
  )
}

/**
 * The trust line, under the flags: `✓ ran without asking · trust rule
 * JiraTriage` when the person's rules let the call skip its dialog, or, when
 * they have rules and none fit, a dim `asked:` and the first reason. Wraps,
 * never cut; its card says what fit where.
 */
function Trust({ ctx, plan }: { ctx: Ctx; plan: Plan['trust'] }) {
  const { Box, Text } = ctx.kit
  const line = plan.line
  if (line === undefined) return null
  const isAllowed = line.tone === 'allow'
  return (
    <Box flexDirection="row">
      <Box width={NOTE_GLYPH} flexShrink={0}>
        <Text color={isAllowed ? COLOR.allow : undefined} dimColor={!isAllowed} hover={trustHover()}>
          {isAllowed ? GLYPH.allow : GLYPH.bullet}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        <Text wrap="wrap" dimColor={!isAllowed} hover={trustHover()}>
          {line.text}
        </Text>
      </Box>
    </Box>
  )
}

/** The trust line's card: each root and the rule it fit, with why; or why the call asked. */
function TrustCard({ ctx, plan }: { ctx: Ctx; plan: Plan['trust'] }) {
  const { Text } = ctx.kit
  const fit = plan.line?.fit
  if (fit === undefined) return null
  const rows: RenderNode[] = fit.isAllowed
    ? [
        <Para ctx={ctx} text="Your trust rules let this call run without a permission dialog: every root it selects fits one." />,
        ...fit.fits.flatMap(one => [
          <Text wrap="wrap">
            <Text bold>{esc(one.root, 300)}</Text>
            <Text dimColor>{' fits '}</Text>
            <Text color={COLOR.allow}>{esc(one.rule, 300)}</Text>
          </Text>,
          ...one.reasons.map(reason => <Para ctx={ctx} dim indent={2} text={esc(reason, 600)} />),
        ]),
      ]
    : [
        <Para ctx={ctx} text={esc(fit.reason, 2_000)} />,
        <Para ctx={ctx} dim text="A call runs unasked only when every root it selects fits a rule: the same fields or fewer, and each argument the rule names set to a value it allows." />,
      ]
  return (
    <Frame ctx={ctx} id={cardId.trust()} title={fit.isAllowed ? 'trust rules · ran without asking' : 'trust rules · asked'}>
      {rows}
      <Para ctx={ctx} dim text={`Rules: ${TRUST_FILE}; /gas trust reloads them. A pattern matches the text, not what it means.`} />
    </Frame>
  )
}

/**
 * The line for a call a subagent made, under the trust line: `↳ from subagent
 * · Explore: find naming pages`. The main loop's own calls draw nothing.
 * Wraps, never cut; its card says who made the call, and what it was asked.
 */
function Agent({ ctx, plan }: { ctx: Ctx; plan: Plan['agent'] }) {
  const { Box, Text } = ctx.kit
  const line = plan.line
  if (line === undefined) return null
  return (
    <Box flexDirection="row">
      <Box width={NOTE_GLYPH} flexShrink={0}>
        <Text dimColor hover={agentHover()}>
          {GLYPH.agent}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        <Text wrap="wrap" hover={agentHover()}>
          {line.text}
        </Text>
      </Box>
    </Box>
  )
}

/** The agent line's card: what a subagent is, what this one was asked (the whole of it), and that the call is checked like any other. A plugin's call says which plugin; it claims nothing of trust rules, which are not proven to apply to a plugin's call. */
function AgentCard({ ctx, plan }: { ctx: Ctx; plan: Plan['agent'] }) {
  const line = plan.line
  if (line === undefined) return null
  if (line.plugin !== undefined) {
    return (
      <Frame ctx={ctx} id={cardId.agent()} title="from a plugin">
        <Para ctx={ctx} text="A plugin you installed made this call, not Claude: its own code called GraphOS Agent Services." />
        <Fact ctx={ctx} label="plugin" text={line.plugin} />
        {line.label !== '' && <Fact ctx={ctx} label="agent" text={line.label} />}
        <Para ctx={ctx} dim text="The call goes through the same permission check as any other: the dialog names the plugin." />
      </Frame>
    )
  }
  return (
    <Frame ctx={ctx} id={cardId.agent()} title="from a subagent">
      <Para ctx={ctx} text="A subagent Claude started made this call, not the main conversation. It works on a task of its own, in a context of its own." />
      <Fact ctx={ctx} label="agent" text={line.label === '' ? 'the session has no description of it' : line.label} />
      <Para ctx={ctx} dim text="The call goes through the same permission check as any other." />
    </Frame>
  )
}

/** The flags' card: each flag in full, one per row. */
function FlagsCard({ ctx, plan }: { ctx: Ctx; plan: Plan['flags'] }) {
  const { Text } = ctx.kit
  if (plan.all.length === 0) return null
  return (
    <Frame ctx={ctx} id={cardId.flags()} title={`flags · ${plan.all.length}`}>
      {plan.all.map(flag => (
        <Text wrap="wrap">
          <Text color={flag.tone === 'deny' || flag.tone === 'write' ? COLOR.deny : COLOR.mask}>{`${GLYPH.flag} `}</Text>
          {flag.detail}
        </Text>
      ))}
    </Frame>
  )
}

/**
 * Where the call can be opened in the product (src/links.ts), said as what
 * it opens and where: `↗ [this search in Jira]  yourco.atlassian.net`,
 * the label a link (LinkLabel) and the first one also opening on `o`.
 * Without a Link element or presses the URL is dim text. The row lights the
 * link's card, which shows the query. Only canonical https URLs get here.
 */
function Links({ ctx, plan, ir, outcome, gap }: { ctx: Ctx; plan: Plan['links']; ir: InspectedCall['ir']; outcome: InspectedCall['outcome']; gap: number }) {
  const { kit } = ctx
  const { Box, Text, Button, Link } = kit
  if (plan.shown.length === 0) return null
  const isOneOfMany = plan.shown.length > 1
  const act = ctx.act
  return (
    <Box flexDirection="column" marginTop={gap}>
      {plan.shown.map((link, index) => {
        const label = linkLabel(link, ir, outcome, isOneOfMany)
        const host = esc(hostOf(link.url), 80)
        // The first link opens on `o` too: a trailing `o: open`, since a link's label carries no hotkey. It gives way before the label would wrap.
        const hasHotkey = index === 0 && canOpen(ctx) && NOTE_GLYPH + cellWidth(`[${label}]`) + OPEN_HINT <= ctx.columns
        // The host gives way whole rather than being cut mid-name: the card still says it.
        const isHostShown = NOTE_GLYPH + cellWidth(`[${label}]`) + 2 + cellWidth(host) + (hasHotkey ? OPEN_HINT : 0) <= ctx.columns
        return (
          <Box key={`link:${index}`} flexDirection="row" hover={{ scope: linkScope(index) }}>
            <Box width={NOTE_GLYPH} flexShrink={0}>
              <Text dimColor>{GLYPH.link}</Text>
            </Box>
            <Box flexShrink={1}>
              <LinkLabel ctx={ctx} id={`link:${index}`} url={link.url} label={label} hover={linkHover(index)} />
            </Box>
            {Link === undefined && !canOpen(ctx) && (
              <Box flexShrink={1}>
                <Text dimColor wrap="wrap">{` ${link.url}`}</Text>
              </Box>
            )}
            {(Link !== undefined || canOpen(ctx)) && isHostShown && (
              <Box flexShrink={1}>
                <Text dimColor wrap="truncate-end">{`  ${host}`}</Text>
              </Box>
            )}
            {hasHotkey && Button !== undefined && act !== undefined && (
              <Box flexShrink={0} marginLeft={2}>
                <Button key="open:hotkey" plain hotkey="o" label="open" dimColor onPress={() => act({ openUrl: link.url })} />
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/** Cells the first deep link's trailing `o: open` takes, with its two-cell gap. */
const OPEN_HINT = 9

/**
 * A link's label as links are written: bracketed, in the link blue. Settled,
 * Markdown whose one link a plain click presses (`openUrl`), its label inline
 * code so it takes a fixed blue rather than the palette's; without Markdown a
 * plain Button (no color of its own); while a prompt is up the engine Link (a
 * click or cmd-click opens it); without that, the label alone.
 */
function LinkLabel({ ctx, id, url, label, hover }: { ctx: Ctx; id: string; url: string; label: string; hover?: TextHoverProps }) {
  const { Text, Link, Markdown } = ctx.kit
  const act = ctx.act
  const shown = `[${label}]`
  if (Markdown !== undefined && act !== undefined) return <Markdown key={`open:${id}`} text={markdownLink(shown, url)} onLinkPress={() => act({ openUrl: url })} pressableLinks={[url]} />
  if (canOpen(ctx)) return <OpenButton ctx={ctx} id={id} url={url} label={shown} {...(hover !== undefined && { hover })} />
  return (
    <Text wrap="wrap" color={COLOR.link} {...(hover !== undefined && { hover })}>
      {Link !== undefined ? <Link href={url} label={shown} /> : shown}
    </Text>
  )
}

/** Presses can arrive and the kit has Buttons: a link is drawn as one that opens its URL. */
const canOpen = (ctx: Ctx) => ctx.act !== undefined && ctx.kit.Button !== undefined

/** A link's label as a plain Button that asks the host to open `url`; `hotkey` for the first deep link. */
function OpenButton({ ctx, id, url, label, hotkey, hover }: { ctx: Ctx; id: string; url: string; label: string; hotkey?: string; hover?: TextHoverProps }) {
  const { Button } = ctx.kit
  if (Button === undefined || ctx.act === undefined) return null
  const act = ctx.act
  return <Button key={`open:${id}`} plain label={label} {...(hotkey !== undefined && { hotkey })} {...(hover !== undefined && { hover })} onPress={() => act({ openUrl: url })} />
}

/** Each deep link's card: what it opens, the query it carries, and the host. */
function linkCards(ctx: Ctx, plan: Plan['links'], ir: InspectedCall['ir'], outcome: InspectedCall['outcome']): RenderNode[] {
  const { Text } = ctx.kit
  return plan.shown.map((link, index) => (
    <Frame ctx={ctx} id={cardId.link(index)} title={linkLabel(link, ir, outcome, plan.shown.length > 1)}>
      {linkFacts(link, ir).query !== undefined && <Text wrap="wrap">{esc(linkFacts(link, ir).query ?? '', 600)}</Text>}
      <Text dimColor wrap="wrap">{`opens on ${esc(hostOf(link.url), 80)}`}</Text>
    </Frame>
  ))
}

/** Nothing yet: centered, half the spare rows above (the /diff mod's messagePaneOf), and how to open it. */
function Empty({ kit, bodyRows }: { kit: Kit; bodyRows: number | undefined }) {
  const { Box, Text } = kit
  const LINES = 3
  const above = bodyRows === undefined ? 0 : Math.max(0, Math.floor((bodyRows - LINES) / 2))
  return (
    <Box flexDirection="column" alignItems="center" paddingRight={RIGHT_PAD}>
      <Box height={above} />
      <Text bold>No GraphOS Agent Services call yet.</Text>
      <Text dimColor wrap="wrap">
        Each Agent Services execute call shows here before you approve it.
      </Text>
      <Text dimColor wrap="wrap">
        {'Open this pane any time with '}
        <Text color={ACCENT}>/gas</Text>
      </Text>
    </Box>
  )
}

/**
 * The plan viewOf draws `call` by (src/view/plan.ts): rows per block, shed in
 * a fixed order so the pane fits `bodyRows`. The same options viewOf passes,
 * so a test can hold the plan's count against what is drawn.
 */
export function planFor(kit: Kit, call: InspectedCall, columns: number, ui: PaneUi = CLOSED, act?: Act, options: ViewOptions = {}): Plan {
  const isPending = call.status === 'pending'
  const config = options.links ?? configOf(undefined)
  const status = statusOf(call.status, options.waiting ?? 0, call.outcome)
  return planOf(call.ir, {
    status: status === undefined ? '' : `${status.glyph === '' ? '' : `${status.glyph} `}${status.word}`,
    ...(options.nav !== undefined && { nav: options.nav }),
    rows: options.bodyRows ?? Infinity,
    columns,
    isPending,
    open: ui,
    now: call.arrivedAt,
    sectionGap: sectionGapOf(options),
    links: linksOf(call.ir, config),
    linkConfig: config,
    hasLinkElement: kit.Link !== undefined,
    hasControls: isInteractiveOf(kit, call, act),
    callId: call.id,
    isLink: value => value !== undefined && openableUrl(value, config) !== undefined,
    ...(call.trust !== undefined && { trust: call.trust }),
    ...(call.agent !== undefined && { agent: call.agent }),
    // What an unparseable call draws in place of the form (Unparseable), so the plan counts it.
    sent: { operation: call.operation, variables: call.variables, ...(call.inputError !== undefined && { inputError: call.inputError }) },
    // RESULT only for a call that ran: a refusal or a tool error carries no GraphQL response.
    ...(call.outcome !== undefined && call.status === 'ran' && { outcome: call.outcome }),
  })
}

/** Presses can arrive: the call has settled, the host passed `act`, and the kit has Buttons. */
const isInteractiveOf = (kit: Kit, call: InspectedCall, act: Act | undefined) => call.status !== 'pending' && act !== undefined && kit.Button !== undefined

/** Off the terminal, sections get a row more air. */
const sectionGapOf = (options: ViewOptions) => (options.surface !== undefined && options.surface !== 'terminal' ? 1 : 0)

/**
 * The pane for the call `shown` picks. `ui` is the pane's own drawer state
 * (default: everything closed); `act` applies a change to it. Without `act`,
 * or while the call is pending, nothing is pressable.
 */
export function viewOf(kit: Kit, shown: Shown, columns: number, ui: PaneUi = CLOSED, act?: Act, options: ViewOptions = {}) {
  const { Box } = kit
  const { call, waiting } = shown
  // Inside the built-in's blank last column, as the /diff mod's insetOf.
  const inner = Math.max(1, Math.floor(columns) - RIGHT_PAD)

  if (call === null) return <Empty kit={kit} bodyRows={options.bodyRows} />

  const isPending = call.status === 'pending'
  const isInteractive = isInteractiveOf(kit, call, act)
  const sectionGap = sectionGapOf(options)
  const { ir } = call
  // A past call, stepped back to: say so in the rule under the header.
  const isHistorical = !isPending && options.nav !== undefined && !options.nav.isLive
  const plan = planFor(kit, call, columns, ui, act, { ...options, waiting })
  // The rows a hover card opens into: the window when the host gives one, else the pane as drawn (a snapshot, a test).
  const view = options.bodyRows === undefined ? { top: 0, rows: plan.total } : { top: options.scrollOffset ?? 0, rows: options.bodyRows }
  const ctx: Ctx = {
    kit,
    columns: inner,
    column: plan.column,
    ui,
    act: isInteractive ? act : undefined,
    now: call.arrivedAt,
    isSettled: !isPending,
    ...(ir.opName !== undefined && { opName: ir.opName }),
    sectionGap,
    pins: annotationIndex(ir, plan.annotations, call.status === 'ran' ? call.outcome : undefined),
    cards: { anchors: plan.anchors, ...view, total: plan.total },
    callId: call.id,
    ...(options.links !== undefined && { links: options.links }),
    ...(options.surface !== undefined && { surface: options.surface }),
  }

  return (
    <Box flexDirection="column" paddingRight={RIGHT_PAD}>
      <Header ctx={ctx} call={call} waiting={waiting} nav={options.nav} head={plan.head} />
      <HeaderRule ctx={ctx} opType={ir.opType} />
      {ir.state === 'unparseable' || ir.opType === undefined ? (
        <Unparseable ctx={ctx} call={call} />
      ) : (
        <Box flexDirection="column">
          <SummaryLine ctx={ctx} ir={ir} plan={plan.summary} />
          <Flags ctx={ctx} plan={plan.flags} />
          <Trust ctx={ctx} plan={plan.trust} />
          <Agent ctx={ctx} plan={plan.agent} />
          {/* A write's CHANGES come first: what approving it changes, from the call alone. */}
          <Changes ctx={ctx} plan={plan.changes} gap={plan.gap} />
          <Result ctx={ctx} plan={plan.result} gap={plan.gap} />
          <Notes ctx={ctx} plan={plan.notes} gap={plan.gap} />
          <Box flexDirection="column" rowGap={plan.gap} marginTop={plan.gap}>
            {ir.roots.map((root, index) => (
              <RootForm ctx={ctx} root={root} opType={ir.opType ?? 'query'} plan={plan.roots[index] as RootPlan} />
            ))}
          </Box>
          <Links ctx={ctx} plan={plan.links} ir={ir} outcome={call.status === 'ran' ? call.outcome : undefined} gap={plan.gap} />
        </Box>
      )}
      {/* Last, so it paints over the rows: the hovered card, popped up beside what lit it. */}
      {ir.state !== 'unparseable' &&
        ir.opType !== undefined && [
          ...headerCards(ctx, call, waiting),
          ...detailCards(ctx, ir, call.status === 'ran' ? call.outcome : undefined),
          ...resultCards(ctx, plan.result, ir, call.status === 'ran' ? call.outcome : undefined),
          ...toggleCards(ctx, plan.result),
          ...changeCards(ctx, plan.changes),
          <ConfirmCard ctx={ctx} outcome={call.status === 'ran' ? call.outcome : undefined} />,
          <FlagsCard ctx={ctx} plan={plan.flags} />,
          <TrustCard ctx={ctx} plan={plan.trust} />,
          <AgentCard ctx={ctx} plan={plan.agent} />,
          ...linkCards(ctx, plan.links, ir, call.status === 'ran' ? call.outcome : undefined),
        ]}
    </Box>
  )
}
