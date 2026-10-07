// The form: one block per root field, in a fixed order: the root with its
// verb, its arguments, what it returns, access. Labels sit in a fixed column and
// wrapped values continue under the value column. Real names only.

import type { RenderChildren, RenderNode } from 'claude-code'

import { full, renderArg } from '../format/index.ts'
import type { ArgIR, FieldIR, OpType } from '../ir.ts'
import { FieldDrawer } from './drawers.tsx'
import type { Ctx } from './kit.ts'
import { esc, rootVerb } from './kit.ts'
import { IN_CHANGES, RETURN_LABEL, argCutText, compact, isAttentionShown, moreText } from './plan.ts'
import { Attention, FieldName, NameLine, PinNote, PolicyMark } from './names.tsx'
import { noteText } from './annotations.ts'
import type { AccessPlan, ArgPlan, ReturnsPlan, RootPlan } from './plan.ts'
import { argHover, rootHover } from './ui/hover.tsx'
import { Field, GLYPH, MARK, STRUCT, TONE, struct } from './ui/index.tsx'
import { TEXT } from './ui/theme.ts'

/** The drawer for the open field, when it is one of `fields`, `width` cells wide. */
function drawerFor(ctx: Ctx, fields: readonly (FieldIR | undefined)[], width: number): RenderNode | null {
  if (ctx.act === undefined || ctx.ui.field === null) return null
  const open = fields.find(field => field?.path === ctx.ui.field)
  return open === undefined ? null : <FieldDrawer ctx={ctx} field={open} width={width} />
}

// ---- Arguments

/** Query words (AND, ORDER BY, in, is not) draw as keywords; symbols (=, ~) as operators. */
const isKeyword = (text: string) => /[a-z]/i.test(text)

function Arg({ ctx, root, arg, plan }: { ctx: Ctx; root: FieldIR; arg: ArgIR; plan: ArgPlan }) {
  const { kit } = ctx
  const { Text, Button, Link } = kit
  const id = `${root.path}(${arg.name})`
  const isFull = ctx.act !== undefined && ctx.ui.arg === id
  const rendered = isFull ? full(arg.value) : renderArg(arg, root.name, ctx.now, ctx.links)
  // Syntax is quiet, the values the call sets are bold: settled or not.
  const toneOf = (tone: keyof typeof TONE) => TONE[tone]
  const lines = rendered.isFallback ? rendered.lines : compact(rendered.lines)
  // The lines left out, the planner's and the renderer's own, are counted under the value: never a `…` on it.
  const hidden = plan.more + (isFull ? 0 : plan.hidden)
  const canExpand = ctx.act !== undefined && Button !== undefined && (rendered.isTruncated === true || isFull || hidden > 0)
  const below = argCutText(hidden, canExpand, isFull)
  const shown = lines.slice(0, plan.maxLines)
  const label = (
    // The mark column indents argument names under the root field.
    <Field
      kit={kit}
      label={plan.isStacked ? '' : plan.label}
      mark=""
      labelWidth={ctx.column}
      labelColor={TEXT}
      isLabelBold={false}
      {...(!plan.isStacked && { labelHover: argHover(root.path, arg.name) })}
    >
        {shown.map((line, index) => (
          <Text wrap="wrap">
            {line.map(segment => (
              segment.url !== undefined && Link !== undefined ? (
                <Text {...toneOf(segment.tone ?? 'value')}>
                  <Link href={segment.url} label={segment.text} />
                </Text>
              ) : segment.tone === 'op' ? (
                <Text {...struct(isKeyword(segment.text) ? STRUCT.keyword : STRUCT.operator)}>{segment.text}</Text>
              ) : segment.tone === undefined || segment.tone === 'value' ? (
                <Text {...TONE.value}>{segment.text}</Text>
              ) : (
                <Text {...toneOf(segment.tone)}>{segment.text}</Text>
              )
            ))}
            {/* Schema hints after the value (`· max 100`), only where the plan found room. */}
            {plan.hint !== undefined && index === shown.length - 1 && <Text dimColor>{plan.hint}</Text>}
          </Text>
        ))}
        {!canExpand && below !== undefined && <Text dimColor wrap="wrap">{below}</Text>}
        {canExpand && Button !== undefined && below !== undefined && <Button key={`arg:${id}`} plain dimColor label={below} onPress={() => ctx.act?.({ arg: isFull ? null : id })} />}
    </Field>
  )
  if (!plan.isStacked) return label
  // A name too long for the value column has its own row (rows, broken where it is wider than the pane); the value starts under the column on the next.
  return (
    <kit.Box flexDirection="column">
      <kit.Box flexDirection="row" paddingLeft={MARK}>
        <Text hover={argHover(root.path, arg.name)}>{(plan.labelRows ?? [plan.label]).join('\n')}</Text>
      </kit.Box>
      {label}
    </kit.Box>
  )
}

/**
 * A row of a root's form that labels a part of it (`return type`, `access`): the
 * label lowercase and dim at the argument names' indent, its content at the
 * value column, so it reads as one more row of the form.
 */
function SubRow({ ctx, label, children }: { ctx: Ctx; label: string; children?: RenderChildren }) {
  return (
    <Field kit={ctx.kit} label={label} mark="" labelWidth={ctx.column} labelColor={STRUCT.returns} isLabelBold={false}>
      {children}
    </Field>
  )
}

// ---- In CHANGES

/**
 * A write's arguments its CHANGES block already shows, on one dim row in the
 * `return type` row's style: their names, ` · ` apart, each lighting its own
 * argument's card, so the form does not say each value a second time.
 */
function InChanges({ ctx, root, plan }: { ctx: Ctx; root: FieldIR; plan: NonNullable<RootPlan['inChanges']> }) {
  const { Box, Text } = ctx.kit
  return (
    <SubRow ctx={ctx} label={IN_CHANGES}>
      <Box flexDirection="row" flexWrap="wrap">
        {plan.names.flatMap((one, index) => [
          ...(index > 0 ? [<Text dimColor>{GLYPH.separator}</Text>] : []),
          <Text dimColor hover={argHover(root.path, one.name)}>
            {one.label}
          </Text>,
        ])}
      </Box>
    </SubRow>
  )
}

// ---- Return type

/** What comes back: the plan's lines (src/view/plan.ts returnLines), collapsed or cut to fit. */
function Returns({ ctx, plan }: { ctx: Ctx; plan: ReturnsPlan }) {
  const { lines } = plan
  if (lines.length === 0) return null
  return (
    <SubRow ctx={ctx} label={RETURN_LABEL}>
      {/* The tree always starts on the row after the label: a list's own note is the label row, else the root's type in words (or nothing). */}
      {!plan.isLeadLine &&
        (plan.isLeadUnread === true ? (
          <ctx.kit.Text dimColor wrap="wrap">
            {plan.lead ?? ' '}
          </ctx.kit.Text>
        ) : (
          <ctx.kit.Text {...struct(STRUCT.type, true, { italic: true })} wrap="wrap">
            {plan.lead ?? ' '}
          </ctx.kit.Text>
        ))}
      {lines.flatMap((line, index) => [
        <NameLine
          ctx={ctx}
          where={`r${index}`}
          prefix={line.prefix}
          {...(line.rows !== undefined && { rows: line.rows })}
          {...(line.breaks !== undefined && { breaks: line.breaks })}
          {...(line.onType !== undefined && { onType: line.onType })}
          {...(line.annotation !== undefined && { annotation: line.annotation })}
          {...(line.head !== undefined && { head: line.head })}
          fields={line.fields}
          {...(line.tags !== undefined && { tags: line.tags })}
          {...(line.note !== undefined && { note: line.note })}
          {...(line.fold !== undefined && { fold: line.fold })}
        />,
        drawerFor(ctx, [line.head, ...line.fields], Math.max(1, ctx.columns - ctx.column)),
      ])}
      {plan.paging !== undefined && (
        <ctx.kit.Text dimColor wrap="wrap">
          {plan.paging}
        </ctx.kit.Text>
      )}
      {plan.more > 0 && <ctx.kit.Text dimColor>{`${GLYPH.checking} ${plan.more} more`}</ctx.kit.Text>}
    </SubRow>
  )
}

// ---- ACCESS

/**
 * The root's `access` row, only when it says something: the scopes it needs,
 * or `not checked` when other roots were. With no scope anywhere the policy
 * card says so; masks and denials are on the names.
 */
function Access({ ctx, plan }: { ctx: Ctx; plan: AccessPlan }) {
  const { kit } = ctx
  const { Text } = kit
  // Roots on one service share the row the last one draws.
  if (plan.isMerged === true) return null
  const scopes = plan.scopes.slice(0, plan.needs)
  if (scopes.length === 0 && plan.empty === undefined) return null
  return (
    <SubRow ctx={ctx} label="access">
      {scopes.length === 0 ? (
        <Text dimColor>{plan.empty}</Text>
      ) : (
        // Each scope wraps, never cut; the last carries `+N` for the ones left out.
        scopes.map((scope, index) => (
          <Text wrap="wrap">
            {scope}
            {index === scopes.length - 1 && plan.more > 0 && <Text dimColor>{moreText(plan.more)}</Text>}
          </Text>
        ))
      )}
    </SubRow>
  )
}

// ---- One root

/**
 * One root as a block. Its header line opens it: `┃ VERB`, the bar in the
 * structure hue and the verb bold in default text, then the alias and the
 * root's real name in default text; with several roots a faint rule runs to
 * the edge, so each reads as its own block. Arguments, `return type` and
 * `access` are rows of its form beneath.
 */
export function RootForm({ ctx, root, opType, plan }: { ctx: Ctx; root: FieldIR; opType: OpType; plan: RootPlan }) {
  const { kit } = ctx
  const { Box, Text } = kit
  const verb = rootVerb(root, opType)
  const pinned = ctx.pins.field(root.coordinate)
  const alias = root.alias === undefined ? '' : `${esc(root.alias, 40)}`.replace(/\s+/g, ' ')
  // With several roots, the rule the header runs out in (the plan's cells): after a name that breaks, on its last row.
  const rule = plan.rule > 0 ? <Text {...struct(STRUCT.rootRule)}>{` ${GLYPH.rule.repeat(plan.rule)}`}</Text> : null
  const isRuleOnName = plan.nameRows !== undefined && plan.hint === undefined && (pinned === undefined || noteText(pinned) === '')
  return (
    <Box flexDirection="column">
      {/* The root name gets the whole row after the verb: its column is never sized by argument names. */}
      <Field kit={kit} label={verb} isSection labelWidth={ctx.column} labelHover={rootHover(root.path)} labelColor={STRUCT.verb} isLabelBold>
        <Box flexDirection="row" flexWrap="wrap">
          {pinned !== undefined && isAttentionShown(pinned, root) && <Attention ctx={ctx} pinned={pinned} />}
          <PolicyMark ctx={ctx} field={root} />
          {/* The caller's own name for the root, as the operation spells it (`open: jira_search…`), so the reader can match it to the agent's words. */}
          {alias !== '' && <Text>{`${alias}: `}</Text>}
          <FieldName ctx={ctx} field={root} where="root" {...(plan.nameRows !== undefined && { rows: plan.nameRows })} {...(isRuleOnName && rule !== null && { tail: rule })} />
          {plan.hint !== undefined && <Text dimColor>{plan.hint}</Text>}
          {pinned !== undefined && <PinNote ctx={ctx} pinned={pinned} />}
          {!isRuleOnName && rule}
        </Box>
      </Field>
      {/* Only a description that fits whole on its row; the root's card has all of it. */}
      {plan.description !== undefined && (
        <Field kit={kit} label="" labelWidth={ctx.column}>
          <Text dimColor wrap="truncate-end">{`\u201c${plan.description.text}\u201d`}</Text>
        </Field>
      )}
      {drawerFor(ctx, [root], ctx.columns)}
      {root.args.map((arg, index) => (plan.args[index]?.isInChanges === true ? null : <Arg ctx={ctx} root={root} arg={arg} plan={plan.args[index] as ArgPlan} />))}
      {plan.inChanges !== undefined && <InChanges ctx={ctx} root={root} plan={plan.inChanges} />}
      {/* Arguments left out that have a default: what the server will use. */}
      {plan.defaults.map(one => (
        <Box flexDirection="column">
          {one.rows !== undefined && (
            <Box paddingLeft={MARK}>
              <Text dimColor hover={argHover(root.path, one.name)}>
                {one.rows.join('\n')}
              </Text>
            </Box>
          )}
          <Field kit={kit} label={one.rows !== undefined ? '' : one.name} mark="" labelWidth={ctx.column} {...(one.rows === undefined && { labelHover: argHover(root.path, one.name) })}>
            <Text dimColor wrap="wrap">
              {one.text}
            </Text>
          </Field>
        </Box>
      ))}
      <Returns ctx={ctx} plan={plan.returns} />
      <Access ctx={ctx} plan={plan.access} />
    </Box>
  )
}
