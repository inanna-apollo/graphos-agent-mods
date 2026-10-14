// Measure the already escaped display string. Unicode tables belong to the
// vendored library; grapheme boundaries must also survive wrapping.
import { cellWidth } from '../vendor/string-width.js'
export { cellWidth }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), part => part.segment)
export const cellsOf = (grapheme: string): number => cellWidth(grapheme)
export function takeCells(text: string, width: number): string {
  let used = 0
  let out = ''
  for (const { segment: part } of segmenter.segment(text)) {
    const cells = cellWidth(part)
    if (used + cells > width) break
    used += cells
    out += part
  }
  return out
}
