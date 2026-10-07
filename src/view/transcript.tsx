// The RESULT block under an Agent Services call's row in the transcript (src/view/transcript.ts),
// drawn as the pane draws its RESULT: a bar and the label, the rows line riding on
// it, the first records under. Pure apart from the element table.

import type { RenderNode } from 'claude-code'

import type { Kit } from './kit.ts'
import { cellWidth } from './plan.ts'
import { markdownLink } from './ui/preview-cards.tsx'
import { COLOR, GLYPH, STRUCT, struct } from './ui/index.tsx'
import type { ResultBlock } from './transcript.ts'

/** Cells before the bar: under the text of the verdict line above (`  ⎿  `). */
const BAR_AT = 5
/** The pane's indents under its RESULT label (a further line, a list's rows), from the bar. */
const LINE_AT = BAR_AT + 2
const ROW_AT = BAR_AT + 4
/** Cells between a key and what follows it. */
const GAP = 2
/** The widest key column: past it the keys wrap on rows of their own (an id is ten or twenty cells, a title is not an id). */
const MAX_KEY_CELLS = 20

export type TranscriptKit = Pick<Kit, 'Box' | 'Text' | 'Markdown'>

/**
 * `┃ RESULT  5 issues · first page`, then the first records, each key a link a
 * plain click presses (`onOpen`, the pane's own path: Markdown with
 * `onLinkPress`) where the surface has Markdown. Response content is already
 * escaped (outcome.ts); nothing is cut, text wraps.
 */
export function ResultBlockView({ kit, block, onOpen }: { kit: TranscriptKit; block: ResultBlock; onOpen: (url: string) => void }) {
  const { Box, Text, Markdown } = kit
  const column = Math.max(0, ...block.items.map(item => cellWidth(item.key)))
  const isColumn = column <= MAX_KEY_CELLS && block.items.some(item => item.text !== '')
  const number = struct(STRUCT.number, false, { bold: true })
  const [first, ...rest] = block.heads
  return (
    <Box flexDirection="column">
      <Box paddingLeft={BAR_AT}>
        <Text wrap="wrap">
          <Text color={STRUCT.bar}>{`${GLYPH.section} `}</Text>
          <Text bold color={STRUCT.result}>
            RESULT
          </Text>
          {first !== undefined && <Text>{'  '}</Text>}
          {first !== undefined && <Text {...number}>{first}</Text>}
          {block.size !== undefined && <Text dimColor>{`${first === undefined ? '  ' : GLYPH.separator}${block.size}`}</Text>}
        </Text>
      </Box>
      {rest.map(head => (
        <Box paddingLeft={LINE_AT}>
          <Text wrap="wrap" {...number}>
            {head}
          </Text>
        </Box>
      ))}
      {block.items.map((item, index) => {
        const url = item.url
        const key =
          url !== undefined && Markdown !== undefined ? (
            <Markdown key={`result:open:${index}`} text={markdownLink(item.key, url)} onLinkPress={() => onOpen(url)} pressableLinks={[url]} />
          ) : (
            <Text wrap="wrap" {...(url !== undefined && { color: COLOR.link })}>
              {item.key}
            </Text>
          )
        // Short keys with a word after them line up in a column. A key too wide for one (a title, a long identifier), or one with nothing after it, wraps across its row, and what follows it sits under it: nothing is cut or pushed off a narrow screen.
        if (!isColumn) {
          return (
            <Box key={`result:${index}`} flexDirection="column" paddingLeft={ROW_AT}>
              {key}
              {item.text !== '' && (
                <Box paddingLeft={GAP}>
                  <Text wrap="wrap">{item.text}</Text>
                </Box>
              )}
            </Box>
          )
        }
        return (
          <Box key={`result:${index}`} flexDirection="row" paddingLeft={ROW_AT}>
            <Box width={column} flexShrink={0}>
              {key}
            </Box>
            {item.text !== '' && (
              <Box flexGrow={1} flexShrink={1} marginLeft={GAP}>
                <Text wrap="wrap">{item.text}</Text>
              </Box>
            )}
          </Box>
        )
      })}
      {block.more > 0 && (
        <Box paddingLeft={ROW_AT}>
          <Text dimColor>{`${GLYPH.checking} ${block.more} more`}</Text>
        </Box>
      )}
    </Box>
  )
}

/** A standalone result row: the block ahead of the engine's own drawing, which stays whole beneath it. */
export function ResultRows({ kit, drawn, block, onOpen }: { kit: TranscriptKit; drawn: RenderNode; block: ResultBlock; onOpen: (url: string) => void }) {
  const { Box } = kit
  return (
    <Box flexDirection="column">
      <ResultBlockView kit={kit} block={block} onOpen={onOpen} />
      {drawn}
    </Box>
  )
}
