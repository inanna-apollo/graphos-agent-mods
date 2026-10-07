// A write's CHANGES section, git style: what the call will change, from its
// own arguments (src/preview/changes.ts), first for a write, above RESULT and
// the form. Pure apart from the element table.
//
// One block per write root: `┃ CHANGES  issue DEV-634` (or what a create
// makes: `┃ NEW MESSAGE  in C0123`), then a row per new value with its sign in
// the sign column, its label in a column and its value at the CHANGES column:
// `+` and its value in the allow hue, `-` in the deny hue, `±` (an edit in
// place) in the mask hue, a restated value dim with no sign. A body's first
// lines follow its row, each with its sign, wrapped and never cut, then a
// count for the rest. Dim notes close the block: that the current state was
// not read, what a delete leaves. Every name lights a card: the section, the
// target, each row. The planner counts every row (src/view/plan.ts
// changesPlanOf) and anchors every card; tests/parity.test.ts holds the two
// together.

import type { RenderNode } from 'claude-code'

import { own } from '../guards.ts'
import type { CallOutcome } from '../ir.ts'
import type { ChangeBlock, ChangeRow, Sign } from '../preview/changes.ts'
import { FORMAT_WORDS } from '../preview/flatten.ts'
import { confirmText } from '../preview/confirm.ts'
import type { Ctx } from './kit.ts'
import type { ChangeBlockPlan, ChangeRowPlan, Plan } from './plan.ts'
import { BODY_INDENT, CHANGE_INDENT, SIGN_AT, cardId, lineText, restText } from './plan.ts'
import { Described, Fact, Frame, Para, TypeFacts, idHover } from './ui/hover.tsx'
import { COLOR, GLYPH, STRUCT } from './ui/theme.ts'

/** A sign's hue: what the call adds in the allow hue, what it removes in the deny hue, an edit in place in the mask hue. */
const HUE: Record<Sign, string | undefined> = { '+': COLOR.allow, '-': COLOR.deny, '±': COLOR.mask, ' ': undefined }

/** Cells of the sign column: the sign and a space. */
const SIGN_CELLS = CHANGE_INDENT - SIGN_AT

/** Every CHANGES block, each with the gap above it. Nothing for a call that writes nothing. */
export function Changes({ ctx, plan, gap }: { ctx: Ctx; plan: Plan['changes']; gap: number }) {
  const { Box } = ctx.kit
  if (plan.blocks.length === 0) return null
  return (
    <Box flexDirection="column">
      {plan.blocks.map(block => (
        <Block ctx={ctx} plan={block} column={plan.column} gap={gap} />
      ))}
    </Box>
  )
}

function Block({ ctx, plan, column, gap }: { ctx: Ctx; plan: ChangeBlockPlan; column: number; gap: number }) {
  const { Box, Text } = ctx.kit
  const { block } = plan
  const section = idHover(cardId.section(block.path))
  return (
    <Box flexDirection="column" marginTop={gap}>
      <Box flexDirection="row">
        <Box width={plan.labelCells} flexShrink={0}>
          <Text hover={section}>
            <Text color={STRUCT.bar}>{`${GLYPH.section} `}</Text>
            <Text bold>{block.section}</Text>
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap" {...(block.target.words !== '' && { hover: idHover(cardId.target(block.path)) })}>
            {block.target.words === '' ? ' ' : block.target.words}
          </Text>
        </Box>
      </Box>
      {plan.rows.map((row, index) => (
        <Row ctx={ctx} plan={row} column={column} hover={idHover(cardId.change(block.path, index))} />
      ))}
      {plan.moreRows > 0 && (
        <Box paddingLeft={CHANGE_INDENT}>
          <Text dimColor wrap="wrap" hover={section}>{`${block.more} more`}</Text>
        </Box>
      )}
      {plan.notes.map(note => (
        <Box paddingLeft={SIGN_AT}>
          <Text dimColor wrap="wrap" hover={section}>
            {note.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** The sign in its column, in its hue. */
function SignCell({ ctx, sign }: { ctx: Ctx; sign: Sign }) {
  const { Box, Text } = ctx.kit
  return (
    <Box width={SIGN_CELLS} flexShrink={0}>
      <Text color={HUE[sign]} bold={sign !== ' '}>
        {sign}
      </Text>
    </Box>
  )
}

/** One new value: the sign, the label in its column (or on rows of its own above, when too long), the value at the column; a body's first lines under it. */
function Row({ ctx, plan, column, hover }: { ctx: Ctx; plan: ChangeRowPlan; column: number; hover: ReturnType<typeof idHover> }) {
  const { Box, Text } = ctx.kit
  const { row } = plan
  const hue = HUE[row.sign]
  const isDim = row.isDim === true
  const value = (
    <Text wrap="wrap" color={hue} dimColor={isDim} hover={hover}>
      {row.text}
    </Text>
  )
  const head =
    plan.labelRows === undefined ? (
      <Box flexDirection="row" paddingLeft={SIGN_AT}>
        <SignCell ctx={ctx} sign={row.sign} />
        <Box width={Math.max(1, column - CHANGE_INDENT)} flexShrink={0}>
          <Text dimColor={isDim} hover={hover}>
            {row.label}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {value}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingLeft={SIGN_AT}>
          <SignCell ctx={ctx} sign={row.sign} />
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor={isDim} hover={hover}>
              {plan.labelRows.join('\n')}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" paddingLeft={column}>
          <Box flexGrow={1} flexShrink={1}>
            {value}
          </Box>
        </Box>
      </Box>
    )
  if (plan.lines.length === 0 && plan.rest === 0) return head
  return (
    <Box flexDirection="column">
      {head}
      {plan.lines.map(line => (
        <Box flexDirection="row" paddingLeft={SIGN_AT}>
          <SignCell ctx={ctx} sign={row.sign} />
          <Box flexGrow={1} flexShrink={1} marginLeft={BODY_INDENT - CHANGE_INDENT}>
            <Text wrap="wrap" color={hue} bold={line.kind === 'heading'} hover={hover}>
              {lineText(line)}
            </Text>
          </Box>
        </Box>
      ))}
      {plan.rest > 0 && (
        <Box paddingLeft={BODY_INDENT}>
          <Text dimColor wrap="wrap" hover={hover}>
            {restText(plan.rest)}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ---- Cards

/** What a sign means, for a row's card. */
const SIGN_WORDS: Record<Sign, string> = {
  '+': 'a value the call sets or adds',
  '-': 'what the call removes or deletes',
  '±': 'a value the call edits in place',
  ' ': 'a value the call must send on every change, set to what it almost always is: said, not a change',
}

/** What a target's noun is, taught on its card. */
const TARGET_LESSONS: Record<string, string> = {
  issue: "A Jira issue key is its project's key and a number (DEV-634). The issue's summary and status are not read.",
  page: "Confluence names a page by a numeric id. Its title and body as they are now are not read.",
  'blog post': 'Confluence names a blog post by a numeric id. Its title and body as they are now are not read.',
  comment: 'A comment is named by its id. Its text as it is now is not read.',
  'inline comment': 'An inline comment is named by its id. Its text as it is now is not read.',
  message:
    "Slack names a message by its channel and its ts, the time Slack stamped it with (seconds and microseconds): the pair is the message's id. A channel id starts with C for a channel, G for a private group and D for a direct message.",
}

/** The section's card: what the block is, how it was read, what the signs mean. */
function SectionCard({ ctx, block }: { ctx: Ctx; block: ChangeBlock }) {
  const lead =
    block.source === 'unread'
      ? 'What this call changes could not be read from its arguments.'
      : block.kind === 'create'
      ? 'What this call will create, read from its own arguments. Nothing that exists now is replaced.'
      : block.kind === 'delete'
        ? "What this call will delete, read from its own arguments. The record's current state is not read, so what it holds is not shown."
        : "What this call will change, read from its own arguments: the new values only. The record's current state is not read, so a value here may be what it holds already."
  return (
    <Frame ctx={ctx} id={cardId.section(block.path)} title={`${block.section.toLowerCase()} · ${block.source === 'mapped' ? 'built-in mapping' : block.source === 'unread' ? 'not read' : 'read from the schema'}`}>
      <Para ctx={ctx} text={lead} />
      <Para ctx={ctx} dim text={block.how} />
      {block.source !== 'unread' && <Para ctx={ctx} dim text="+ is a value the call sets or adds, - what it removes or deletes, ± a value it edits in place. A body shows its first lines and how many there are." />}
      {block.rows.length === 0 && block.source !== 'unread' && <Para ctx={ctx} text="The call sets nothing beyond its target." />}
    </Frame>
  )
}

/** The target's card: each argument that names it, its type and description, and what the noun is. */
function TargetCard({ ctx, block }: { ctx: Ctx; block: ChangeBlock }) {
  const { target } = block
  if (target.words === '') return null
  return (
    <Frame ctx={ctx} id={cardId.target(block.path)} title={`${target.words} · target`}>
      {target.parts.map(part => (
        <ctx.kit.Box flexDirection="column">
          <Fact ctx={ctx} label={part.role === 'id' ? 'names it' : 'where'} text={`${part.arg}: ${part.value}`} />
          {part.type !== undefined && <TypeFacts ctx={ctx} label="type" sdl={part.type} />}
          {part.description !== undefined && <Described ctx={ctx} text={part.description} isRead max={Infinity} />}
        </ctx.kit.Box>
      ))}
      <Para ctx={ctx} dim text={own(TARGET_LESSONS, target.noun) ?? 'The target as the call names it. The record itself is not read.'} />
    </Frame>
  )
}

/** A row's card: what the new value means, the argument it is in, its type in notation and words, its schema description, and the value as written; a body's format, size, links and mentions. */
function RowCard({ ctx, block, row, index }: { ctx: Ctx; block: ChangeBlock; row: ChangeRow; index: number }) {
  const { card, body } = row
  const where = card.path ?? card.arg
  // A field inside an argument has no type of its own in the schema: the argument's type is the container's.
  const title = `${row.label} · ${card.isJson === true ? 'untyped JSON' : card.inputType !== undefined ? `in ${card.inputType}` : (card.type ?? 'type not read')}`
  return (
    <Frame ctx={ctx} id={cardId.change(block.path, index)} title={title}>
      <Para ctx={ctx} text={`${row.sign === ' ' ? '' : `${row.sign} `}${card.meaning}`} />
      <Fact ctx={ctx} label="sign" text={SIGN_WORDS[row.sign]} />
      <Fact ctx={ctx} label="in call" text={where} />
      {card.type !== undefined && <TypeFacts ctx={ctx} label={card.path === undefined ? 'type' : 'arg type'} sdl={card.type} />}
      {card.isJson === true ? (
        <Para ctx={ctx} dim text="inside untyped JSON: the schema does not describe it, so the pane reads the call's own keys" />
      ) : card.inputType !== undefined ? (
        <Para ctx={ctx} dim text={`a field of the input object ${card.inputType}: the schema describes it on that type`} />
      ) : (
        <Described ctx={ctx} text={card.description} isRead={card.type !== undefined} max={Infinity} />
      )}
      {body !== undefined && <Fact ctx={ctx} label="format" text={`${FORMAT_WORDS[body.format]}${body.isRaw ? ': it did not parse as that, so it is shown as written' : ''}`} />}
      {body !== undefined && <Fact ctx={ctx} label="lines" text={`${body.total.toLocaleString('en-US')}${body.isCapped ? ', past the size the pane reads: the first of them' : ''}`} />}
      {body !== undefined && body.links.length > 0 && <Fact ctx={ctx} label="links" text={body.links.join('\n')} />}
      {body !== undefined && body.mentions.length > 0 && <Fact ctx={ctx} label="mentions" text={body.mentions.join(' · ')} />}
      {body === undefined && card.raw !== undefined && <Fact ctx={ctx} label="value" text={card.raw} />}
    </Frame>
  )
}

/** Every CHANGES card, for the pane's root (Frame): placed beside its trigger, hidden until lit. */
export function changeCards(ctx: Ctx, plan: Plan['changes']): RenderNode[] {
  return plan.blocks.flatMap(({ block }) => [
    <SectionCard ctx={ctx} block={block} />,
    <TargetCard ctx={ctx} block={block} />,
    ...block.rows.map((row, index) => <RowCard ctx={ctx} block={block} row={row} index={index} />),
  ])
}

type ConfirmPart = { text: string; state: 'same' | 'differs' | 'new'; label: string; value?: string }

/**
 * RESULT's confirmation line, as CHANGES says its rows: each label dim, each
 * value the response said back bold, a ✓ in the allow hue, a difference in
 * the mask hue. The words are `part.text` (src/preview/confirm.ts
 * confirmText), so the planner counts what is drawn; a part stored before the
 * label and value were kept draws its text as it is.
 */
export function ConfirmLine({ ctx, line }: { ctx: Ctx; line: { parts: ConfirmPart[] } }) {
  const { Text } = ctx.kit
  const words = (part: ConfirmPart) => {
    const value = part.value
    if (part.label === undefined) return <Text {...(part.state === 'differs' && { color: COLOR.mask })}>{part.text}</Text>
    if (part.state === 'differs') {
      return value === undefined ? (
        <Text>
          <Text dimColor>{part.label}</Text>
          <Text color={COLOR.mask}>{' came back different'}</Text>
        </Text>
      ) : (
        <Text>
          <Text dimColor>{`${part.label} came back as `}</Text>
          <Text bold color={COLOR.mask}>
            {value}
          </Text>
        </Text>
      )
    }
    return (
      <Text>
        <Text dimColor>{part.label}</Text>
        {value !== undefined && <Text bold>{` ${value}`}</Text>}
        {part.state === 'same' && <Text color={COLOR.allow}>{' ✓'}</Text>}
      </Text>
    )
  }
  return (
    <Text wrap="wrap" hover={idHover(cardId.confirm())}>
      {line.parts.map((part, index) => (
        <Text>
          {index > 0 && <Text dimColor>{GLYPH.separator}</Text>}
          {words(part)}
        </Text>
      ))}
    </Text>
  )
}

/** The confirmation line's card: each value, what was sent and what came back, and why only these. */
export function ConfirmCard({ ctx, outcome }: { ctx: Ctx; outcome: CallOutcome | undefined }) {
  const confirms = outcome?.confirms ?? []
  if (confirms.length === 0) return null
  return (
    <Frame ctx={ctx} id={cardId.confirm()} title="confirmed by the response">
      <Para ctx={ctx} text="Each new value the call set, against the one the response carries at the same place. The pane cannot add fields to the call, so it confirms only what the response happens to hold." />
      {confirms.map(one => (
        <Fact
          ctx={ctx}
          label={one.label}
          text={one.state === 'new' ? `the record this call made: ${one.value ?? ''}` : one.state === 'same' ? `${one.value === undefined ? 'the response says' : `${one.value}: the response says`} what the call sent` : one.value === undefined ? 'the response holds a different text: a service may store markup its own way' : `sent ${one.sent ?? '?'}, came back ${one.value}`}
        />
      ))}
      <Para ctx={ctx} dim text={confirms.map(confirmText).join(' · ')} />
    </Frame>
  )
}
