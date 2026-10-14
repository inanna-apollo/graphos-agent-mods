// Complete retained inputs, paginated under the host's per-drawing code budget.
import type { ResolvedCall } from '../../types'
import type { Act, Kit, PaneUi } from './kit.ts'
import { esc, walk } from './kit.ts'
import { LOOKUP_BADGE } from './kinds.ts'
import { retentionReason } from './details.ts'
import { rawPages } from './raw-pages.ts'
import { BACKGROUND, QUIET, RIGHT_PAD } from './ui/index.tsx'

export function rawTitleOf(call: ResolvedCall | null): string {
  if (call === null) return 'raw operation'
  if (!('ir' in call)) return esc(call.overview.operationName ?? 'raw operation', 200)
  const named = call.ir.opName ?? call.ir.roots[0]?.name
  if (call.tool === undefined) return esc(named ?? 'raw operation', 200)
  const subject = named ?? call.input?.type ?? call.input?.terms?.join(' ')
  return esc(subject ? `${LOOKUP_BADGE[call.tool].toLowerCase()} · ${subject}` : `${LOOKUP_BADGE[call.tool].toLowerCase()} input`, 200)
}

export function RawView({ kit, call, onClose, bodyRows, ui, onChange }: {
  kit: Kit; call: ResolvedCall | null; onClose?: () => void; bodyRows?: number;
  ui?: PaneUi; onChange?: Act
}) {
  const { Box, Text, Code, Button } = kit
  const close = onClose !== undefined && Button !== undefined && <Button key="close" plain hotkey="r" label="close" onPress={onClose} />
  if (call === null || !('ir' in call)) return (
    <Box backgroundColor={BACKGROUND} flexDirection="column" minHeight={bodyRows}>
      {close}
      <Text color={QUIET} wrap="wrap">{call === null ? 'No Agent Services call yet.' : `${retentionReason(call.details)} Full inputs are unavailable; this call has not been rerun.`}</Text>
    </Box>
  )
  const hasOperation = call.tool === undefined && call.operation !== ''
  const canNormalize = hasOperation && call.ir.printed !== undefined
  const asSent = ui?.rawAsSent === true || !canNormalize
  const operation = asSent ? call.operation : call.ir.printed!
  const aliases = walk(call.ir.roots).filter(field => field.alias !== undefined).map(field => `${field.alias} → ${field.name}`)
  const inputLabel = call.tool === undefined ? 'variables' : 'input as sent'
  const parts = [
    ...(hasOperation ? [{ label: asSent ? 'operation as sent' : 'normalized operation · fragments inlined, aliases kept', source: operation, language: 'graphql' as const }] : []),
    ...(call.variables !== '' ? [{ label: inputLabel, source: call.variables, language: 'json' as const }] : []),
  ]
  const pages = parts.flatMap(part => rawPages(part.source).map(source => ({ ...part, source })))
  // Ordinary calls retain the familiar operation + variables layout on one page.
  const isSmall = parts.reduce((n, part) => n + rawPages(part.source).join('').length, 0) <= 32_000
  const page = Math.min(Math.max(0, Math.floor(ui?.rawPage ?? 0)), Math.max(0, pages.length - 1))
  const shown = isSmall ? parts.map(part => ({ ...part, source: rawPages(part.source).join('') })) : pages.slice(page, page + 1)
  const change: Act = next => onChange?.({ ...next, expectedCallId: call.id })
  return (
    <Box flexDirection="column" paddingRight={RIGHT_PAD} backgroundColor={BACKGROUND} minHeight={bodyRows}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {close}
        {canNormalize && Button !== undefined && onChange !== undefined && <Button key="source" plain hotkey="s" label={asSent ? 'normalized' : 'as sent'} onPress={() => change({ rawAsSent: !asSent, rawPage: 0 })} />}
        {!isSmall && <Text color={QUIET}>{`part ${page + 1}/${pages.length}`}</Text>}
        {!isSmall && Button !== undefined && onChange !== undefined && <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {page > 0 && <Button key="previous-part" plain hotkey="p" label="previous part" onPress={() => change({ rawPage: page - 1 })} />}
          {page + 1 < pages.length && <Button key="next-part" plain hotkey="n" label="next part" onPress={() => change({ rawPage: page + 1 })} />}
        </Box>}
      </Box>
      {aliases.length > 0 && <Text color={QUIET} wrap="wrap">{esc(`aliases: ${aliases.slice(0, 20).join(' · ')}${aliases.length > 20 ? ' · further aliases in source' : ''}`, 8_000)}</Text>}
      {shown.map((part, index) => <Box key={`part:${index}`} flexDirection="column">
        <Text color={QUIET} wrap="wrap">{part.label}</Text>
        <Box backgroundColor="userMessageBackground">
          {/* The native highlighter elides source lines over 2,000 characters.
              Text preserves those retained bytes; ordinary code keeps highlighting. */}
          {part.source.split('\n').some(line => line.length > 2_000)
            ? <Text wrap="wrap">{part.source}</Text>
            : <Code source={part.source} language={part.language} wrap="wrap" />}
        </Box>
      </Box>)}
    </Box>
  )
}
