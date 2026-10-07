// What opens once the call has settled: a field's drawer. Schema text is untrusted: escaped, and descriptions
// are quoted and dimmed.

import type { FieldIR } from '../ir.ts'
import type { Ctx } from './kit.ts'
import { POLICY_WORDS, TOKEN_NOTE, esc, hintLines, omittedLines } from './kit.ts'
import { drawerTitleRows } from './plan.ts'
import { COLOR, Drawer, DrawerField, PolicyChip } from './ui/index.tsx'

/** A field's drawer, `width` cells wide: description, type, policy, scopes, deprecation, directives. Its title, the coordinate, breaks into rows (drawerTitleRows), never cut. */
export function FieldDrawer({ ctx, field, width }: { ctx: Ctx; field: FieldIR; width: number }) {
  const { kit } = ctx
  const { Text } = kit
  const { schema } = field
  const policy = POLICY_WORDS[field.policy]
  return (
    <Drawer kit={kit} title={drawerTitleRows(field, width).join('\n  ')} marginTop={ctx.sectionGap}>
      {schema?.description !== undefined && (
        <Text dimColor italic wrap="wrap">
          {`“${esc(schema.description.trim(), 800)}”`}
        </Text>
      )}
      <DrawerField kit={kit} label="type">
        <Text wrap="wrap">{schema === undefined ? 'unknown (schema not loaded)' : esc(schema.type, 200)}</Text>
      </DrawerField>
      <DrawerField kit={kit} label="policy">
        <Text wrap="wrap">
          {field.policy === 'mask' || field.policy === 'deny' ? (
            <PolicyChip kit={kit} kind={field.policy} />
          ) : (
            <Text color={ctx.isSettled ? undefined : policy.color}>{policy.glyph}</Text>
          )}
          <Text>{` ${policy.text}`}</Text>
          {field.denialContext !== undefined && <Text dimColor>{TOKEN_NOTE}</Text>}
        </Text>
      </DrawerField>
      {hintLines(field).length > 0 && (
        <DrawerField kit={kit} label="hints">
          <Text wrap="wrap">{hintLines(field).join(' · ')}</Text>
        </DrawerField>
      )}
      {omittedLines(field).length > 0 && (
        <DrawerField kit={kit} label="not set">
          {omittedLines(field).map(one => (
            <Text wrap="wrap">{one}</Text>
          ))}
        </DrawerField>
      )}
      {(schema?.scopes.length ?? 0) > 0 && (
        <DrawerField kit={kit} label="needs">
          {(schema?.scopes ?? []).map(scope => (
            <Text wrap="wrap">{esc(scope, 200)}</Text>
          ))}
        </DrawerField>
      )}
      {schema?.deprecated !== undefined && (
        <DrawerField kit={kit} label="deprecated">
          <Text color={COLOR.mask} wrap="wrap">
            {esc(schema.deprecated, 400)}
          </Text>
        </DrawerField>
      )}
      {(schema?.tags.length ?? 0) > 0 && (
        <DrawerField kit={kit} label="directives">
          <Text wrap="wrap">{(schema?.tags ?? []).map(tag => `@${esc(tag, 80)}`).join(' ')}</Text>
        </DrawerField>
      )}
    </Drawer>
  )
}
