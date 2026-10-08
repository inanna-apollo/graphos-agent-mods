// Card paragraphs fill the card's width, as a plain wrap does, but never
// end on a lone word: the line before gives its last word to the last line.
import { expect, test } from 'claude-code/testing'

import { pretty } from '../src/view/ui/hover.tsx'
import { cellWidth } from '../src/view/plan.ts'

const SAID = 'A card paragraph with enough words to wrap across several lines must keep its complete contents across narrow and wide widths.'

test('a wrapped card paragraph fills its width, keeps its words, and never strands one word on its last line', () => {
  for (let width = 20; width <= 140; width++) {
    const lines = pretty(SAID, width)
    for (const line of lines) expect(`${width}: ${cellWidth(line) <= width}`).toBe(`${width}: true`)
    expect(lines.join(' ')).toBe(SAID)
    if (lines.length > 1) expect(`${width}: ${(lines.at(-1) ?? '').includes(' ')}`).toBe(`${width}: true`)
  }
  // Wide enough for the first line to hold most of it: it does, rather than splitting the text in halves.
  expect(cellWidth(pretty(SAID, 110)[0] ?? '')).toBeGreaterThan(90)
  expect(pretty('one', 10)).toEqual(['one'])
})
