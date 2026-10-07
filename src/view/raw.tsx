// The raw operation's own pane: the normalized operation (fragments inlined,
// aliases kept) and its variables, for the call the main pane shows. Pure
// apart from the element table handed in.

import type { InspectedCall } from '../../types'
import type { FieldIR } from '../ir.ts'
import type { Kit } from './kit.ts'
import { esc, walk } from './kit.ts'
import { GLYPH, RIGHT_PAD } from './ui/index.tsx'

/** Aliases the operation uses, as `alias → real name`. */
function aliasesOf(roots: readonly FieldIR[]): string[] {
  return walk(roots).flatMap(field => (field.alias === undefined ? [] : [`${esc(field.alias, 80)} → ${esc(field.name, 80)}`]))
}

/** The pane's title: the operation's name, else its first root field, else a plain word. Escaped. */
export function rawTitleOf(call: InspectedCall | null): string {
  if (call === null) return 'raw operation'
  return esc(call.ir.opName ?? call.ir.roots[0]?.name ?? 'raw operation', 80)
}

/** `r:close` closes the pane where the person can press (`onClose` given and the kit has Button). */
export function RawView({ kit, call, onClose }: { kit: Kit; call: InspectedCall | null; onClose?: (() => void) | undefined }) {
  const { Box, Text, Code, Button } = kit
  if (call === null) return <Text dimColor>No Agent Services call yet.</Text>
  const aliases = aliasesOf(call.ir.roots)
  return (
    <Box flexDirection="column" paddingRight={RIGHT_PAD}>
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {call.ir.printed === undefined ? 'operation as sent' : 'normalized operation · fragments inlined, aliases kept'}
          </Text>
        </Box>
        {onClose !== undefined && Button !== undefined && <Button key="close" plain hotkey="r" label="close" onPress={onClose} />}
      </Box>
      <Code source={esc(call.ir.printed ?? call.operation)} language="graphql" wrap="wrap" />
      {aliases.length > 0 && (
        <Text dimColor wrap="wrap">
          {`aliases: ${aliases.join(GLYPH.separator)}`}
        </Text>
      )}
      {call.variables !== '' && <Text dimColor>variables</Text>}
      {call.variables !== '' && <Code source={esc(call.variables)} language="json" wrap="wrap" />}
    </Box>
  )
}
