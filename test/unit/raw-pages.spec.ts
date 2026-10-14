import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { rawPages, RAW_PAGE_SIZE } from '../../src/view/raw-pages.ts'
import { escapeText } from '../../src/escape.ts'
import { cellWidth, graphemes, takeCells } from '../../src/view/text-width.ts'

test('all raw pages reconstruct escaped input, including large values and terminal sequences', () => {
  const atoms = fc.constantFrom('a', '\n', '\t', '界', 'e\u0301', '🇫🇷', '👩‍💻', '\x1b[31m', '\u202e')
  fc.assert(fc.property(fc.array(atoms, { maxLength: 1000 }), fc.integer({ min: 2, max: 300 }), (parts, limit) => {
    const source = parts.join('')
    const pages = rawPages(source, limit)
    assert.equal(pages.join(''), escapeText(source, Infinity).text)
    for (const page of pages) {
      assert.ok(page.length <= limit)
      assert.ok(!/[\ud800-\udbff]$/.test(page))
      assert.ok(!/^[\udc00-\udfff]/.test(page))
    }
  }))
  const source = 'x'.repeat(100_000)
  assert.equal(rawPages(source).join(''), source)
  assert.ok(rawPages(source).every(page => page.length <= RAW_PAGE_SIZE))
})

test('display width and wrapping preserve grapheme clusters', () => {
  assert.equal(cellWidth('e\u0301'), 1)
  assert.equal(cellWidth('🇫🇷'), 2)
  assert.equal(cellWidth('界'), 2)
  assert.equal(cellWidth('👩‍💻'), 2)
  assert.deepEqual(graphemes('e\u0301🇫🇷'), ['e\u0301', '🇫🇷'])
  assert.equal(takeCells('e\u0301🇫🇷x', 2), 'e\u0301')
  assert.equal(takeCells('e\u0301🇫🇷x', 3), 'e\u0301🇫🇷')
  // Security escaping remains visible rather than being measured as a hidden joiner.
  assert.equal(cellWidth(escapeText('👩‍💻').text), 12)
})
