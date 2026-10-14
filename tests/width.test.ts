import { expect, test } from 'claude-code/testing'
import { cellWidth, takeCells } from '../src/view/text-width.ts'

test('vendored Unicode width works in the actual plugin environment', () => {
  expect(cellWidth('e\u0301')).toBe(1)
  expect(cellWidth('🇫🇷')).toBe(2)
  expect(cellWidth('界')).toBe(2)
  expect(cellWidth('👩‍💻')).toBe(2)
  expect(takeCells('🇫🇷ab', 3)).toBe('🇫🇷a')
})
