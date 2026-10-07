// The text renderer on hand-built trees. A full viewOf render needs JSX, which
// Node cannot load: that one is tests/snapshot.test.ts, in the plugin tests.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { snapshotOptionsOf } from '../../src/snapshot/options.ts'
import { displayWidth, renderText, stubKit } from '../../src/snapshot/text.ts'

const { Box, Text, Code, Button, Link, Client } = stubKit()
const lines = (text: string) => text.split('\n')

test('display width: wide CJK and emoji are 2, combining marks 0, symbols 1', () => {
  assert.equal(displayWidth('✓'), 1)
  assert.equal(displayWidth('◐'), 1)
  assert.equal(displayWidth('日本語'), 6)
  assert.equal(displayWidth('é'), 1)
  assert.equal(displayWidth('😀'), 2)
})

test('a row with a flexGrow spacer right-aligns its right side', () => {
  const tree = Box({ flexDirection: 'row', children: [Text({ children: 'left' }), Box({ flexGrow: 1, minWidth: 2 }), Text({ children: 'right' })] })
  assert.equal(renderText(tree, 20), `left${' '.repeat(11)}right`)
})

test('truncate-end cuts with an ellipsis within the width', () => {
  const out = renderText(Text({ wrap: 'truncate-end', children: 'a very long line indeed' }), 10)
  assert.equal(out, 'a very lo…')
  assert.equal(displayWidth(out), 10)
})

test('truncate counts wide characters as two cells', () => {
  const out = renderText(Text({ wrap: 'truncate-end', children: '日本語のテスト' }), 9)
  assert.ok(displayWidth(out) <= 9)
  assert.ok(out.endsWith('…'))
})

test('wrapped text stays under its indent', () => {
  const tree = Box({ flexDirection: 'column', paddingLeft: 4, children: [Text({ wrap: 'wrap', children: 'one two three four five six' })] })
  const rows = lines(renderText(tree, 16))
  assert.ok(rows.length > 1)
  for (const row of rows) {
    assert.ok(row.startsWith('    '))
    assert.ok(displayWidth(row) <= 16)
  }
  assert.equal(rows.map(row => row.trim()).join(' '), 'one two three four five six')
})

test('gap, marginTop, display none, nested Text, Button, Link, Code and Client', () => {
  const tree = Box({
    flexDirection: 'column',
    gap: 1,
    children: [
      Text({ children: ['a ', Text({ bold: true, children: 'b' })] }),
      Box({ display: 'none', children: Text({ children: 'hidden' }) }),
      Text({ marginTop: 1, children: 'c' }),
      Box({ flexDirection: 'row', columnGap: 3, children: [Button({ plain: true, hotkey: 'r', label: 'raw ▸' }), Button({ label: 'ok' })] }),
      Text({ children: ['see ', Link({ href: 'https://x.example', label: 'here' })] }),
      Code({ source: 'query A {\n  b\n}', wrap: 'wrap' }),
      Client({ module: './s.tsx', props: { text: 'checking' } }),
    ],
  })
  assert.equal(renderText(tree, 40), ['a b', '', '', 'c', '', 'r: raw ▸   ok', '', 'see here', '', 'query A {', '  b', '}', '', '✻ checking'].join('\n'))
})

test('snapshot options: off by default, widths parsed and defaulted', () => {
  assert.deepEqual(snapshotOptionsOf(undefined), { isOn: false, widths: [50, 64, 84] })
  assert.deepEqual(snapshotOptionsOf({ snapshots: true, snapshotWidths: '40, 72,x' }), { isOn: true, widths: [40, 72] })
})

test('word wrap breaks at ASCII whitespace only, never at a non-breaking space', () => {
  const credit = 'summary · Haiku'
  const out = renderText(Text({ wrap: 'wrap', children: `List five incidents from PagerDuty. ${credit}` }), 40)
  assert.ok(lines(out).some(row => row.includes(credit)), out)
  // A credit that fits nowhere on the first row moves whole.
  assert.deepEqual(lines(renderText(Text({ wrap: 'wrap', children: `aaaa bbbb ${credit}` }), 16)), ['aaaa bbbb', credit])
})
