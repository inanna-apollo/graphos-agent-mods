import test from 'node:test'
import assert from 'node:assert/strict'
import { escapeText } from '../../src/escape.ts'

const text = (value: string, max?: number) => escapeText(value, max).text

test('plain text is unchanged', () => {
  assert.deepEqual(escapeText('query { me { id } }'), { text: 'query { me { id } }', isTruncated: false })
})

test('CSI color codes are made visible', () => {
  assert.equal(text('a\x1b[31mred\x1b[0mb'), 'a\\x1b[31mred\\x1b[0mb')
})

test('CSI cursor movement and screen clear are made visible', () => {
  assert.equal(text('\x1b[2J\x1b[H\x1b[10;20H'), '\\x1b[2J\\x1b[H\\x1b[10;20H')
})

test('OSC 8 hyperlink terminated by BEL', () => {
  const out = text('\x1b]8;;http://evil.test\x07click\x1b]8;;\x07')
  assert.equal(out, '\\x1b]8;;http://evil.test\\u0007click\\x1b]8;;\\u0007')
})

test('OSC 8 hyperlink terminated by ST', () => {
  const out = text('\x1b]8;;http://evil.test\x1b\\click\x1b]8;;\x1b\\')
  assert.equal(out, '\\x1b]8;;http://evil.test\\u001b\\\\click\\x1b]8;;\\u001b\\\\')
})

test('OSC title set by BEL and by ST', () => {
  for (const end of ['\x07', '\x1b\\']) {
    const out = text(`\x1b]0;pwned${end}after`)
    assert.ok(out.startsWith('\\x1b]0;pwned'), out)
    assert.ok(out.endsWith('after'), out)
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out), out)
  }
})

test('unterminated OSC is still neutralised', () => {
  const out = text('\x1b]0;title with no end\nnext line')
  assert.ok(!out.includes('\x1b'))
})

test('a lone ESC at end of string is shown', () => {
  assert.equal(text('abc\x1b'), 'abc\\x1b')
})

test('ESC followed by a non-sequence character is shown', () => {
  assert.equal(text('\x1bcreset'), '\\x1bcreset')
})

test('carriage return is shown, not passed through', () => {
  assert.equal(text('safe\rEVIL'), 'safe\\x0dEVIL')
  assert.equal(text('a\r\nb'), 'a\\x0d\nb')
})

test('NUL, DEL, and other C0 controls are shown', () => {
  assert.equal(text('a\x00b'), 'a\\x00b')
  assert.equal(text('a\x7fb'), 'a\\x7fb')
  assert.equal(text('\x08\x0b\x0c\x1f'), '\\x08\\x0b\\x0c\\x1f')
})

test('C1 controls are shown, including 8-bit CSI', () => {
  assert.equal(text('\x9b31m'), '\\x9b31m')
  assert.equal(text('\x80\x9f'), '\\x80\\x9f')
})

test('bidi overrides and isolates are shown', () => {
  assert.equal(text('a\u202eb'), 'a\\u{202e}b')
  assert.equal(text('\u2066x\u2069'), '\\u{2066}x\\u{2069}')
  assert.equal(text('\u200e\u200f\u061c'), '\\u{200e}\\u{200f}\\u{061c}')
})

test('newline survives', () => {
  assert.equal(text('a\nb\n'), 'a\nb\n')
})

test('tab becomes two spaces', () => {
  assert.equal(text('a\tb'), 'a  b')
})

test('ordinary unicode is untouched', () => {
  assert.equal(text('héllo 日本語 🎉'), 'héllo 日本語 🎉')
})

test('text at exactly max is not truncated', () => {
  assert.deepEqual(escapeText('abcde', 5), { text: 'abcde', isTruncated: false })
})

test('text past max is cut with an ellipsis', () => {
  assert.deepEqual(escapeText('abcdef', 5), { text: 'abcde…', isTruncated: true })
})

test('truncation counts escaped length', () => {
  const result = escapeText('\x00\x00\x00', 5)
  assert.equal(result.isTruncated, true)
  assert.equal(result.text, '\\x00\\…')
})

test('a 10,000-char string is capped at the default max', () => {
  const result = escapeText('x'.repeat(10_000))
  assert.equal(result.isTruncated, true)
  assert.equal(result.text.length, 9_001)
  assert.ok(result.text.endsWith('…'))
})

test('a 10,000-character string of terminal sequences is escaped and capped', () => {
  const result = escapeText('\x1b[31m'.repeat(2_000), 10_000)
  assert.equal(result.isTruncated, true)
  assert.ok(!result.text.includes('\x1b'))
})

test('truncation does not cut an escape in a way that exposes a raw control', () => {
  for (let max = 1; max < 12; max++) {
    const out = text('\x1b[31m\x1b]0;t\x07\r\u202e', max)
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/.test(out), `max ${max}: ${JSON.stringify(out)}`)
  }
})

test('generated control-sequence inputs produce no raw ESC, CR or other controls', () => {
  const pieces = ['\x1b', '\x1b[', '\x1b[31m', '\x1b]', '\x1b]0;x', '\x07', '\x1b\\', '\r', '\x00', '\x7f', '\x9b', '\x9d', '\u202e', '\u2066', 'a', '[', ']', '\\', ';']
  let seed = 12345
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
  for (let i = 0; i < 500; i++) {
    let input = ''
    for (let j = 0, n = next() % 12; j < n; j++) input += pieces[next() % pieces.length]
    const out = text(input)
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(out), JSON.stringify(input))
  }
})
