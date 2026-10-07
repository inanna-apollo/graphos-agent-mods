import test from 'node:test'
import assert from 'node:assert/strict'
import { resultLines } from '../../src/view/outcome.ts'

const outcome = {
  rows: [{ field: 'results', count: 5, total: 3766 }],
  preview: [{ field: 'results', items: [{ label: 'A\u001b[31m', extra: 'x' }], more: 4 }],
  scalars: [{ field: 'count', value: 1342 }],
  errors: [],
  authLinks: [],
}

test('resultLines: rows, then a preview of them (escaped), then scalars', () => {
  const lines = resultLines(outcome as never)
  assert.deepEqual(lines.map(line => line.kind), ['rows', 'preview', 'scalar'])
  const preview = lines[1]
  assert.ok(preview?.kind === 'preview' && preview.items[0]?.label === 'A\\x1b[31m' && preview.more === 4)
  assert.equal(lines[2]?.kind === 'scalar' && lines[2].text, '1,342')
})

test('resultLines: a first page says so when the root pages', () => {
  const ir = { roots: [{ name: 'confluence_search', children: [{ name: 'results' }], paging: { kind: 'cursor', via: ['cursor'], isFirstPage: true } }] }
  const rows = resultLines(outcome as never, ir as never)[0]
  assert.ok(rows?.kind === 'rows' && rows.note === 'first page')
})

test('resultLines: the count, then the items; an empty list reads "no …", never "of 0"; a total above 0 reads "none of N …"', () => {
  const text = (count: number, total?: number) => {
    const rows = resultLines({ rows: [{ field: 'matches', count, total }], errors: [], authLinks: [] } as never)[0]
    return rows?.kind === 'rows' ? rows.text : undefined
  }
  assert.equal(text(0, 0), 'no matches')
  assert.equal(text(0), 'no matches')
  assert.equal(text(0, 12), 'none of 12 matches')
  assert.equal(text(3, 3766), '3 of 3,766 matches')
  assert.equal(text(1), '1 match')
})

test('resultLines: shortcodes in a row draw as the emoji, after escaping; the link is worked out from the text as sent', () => {
  const sent = {
    rows: [{ field: 'messages', count: 1 }],
    preview: [{ field: 'messages', items: [{ label: 'deploy-bot', text: ':white_check_mark: shipped :slack: \u001b[2J', fields: [{ name: 'text', value: ':fire: hot' }] }], more: 0 }],
    errors: [],
    authLinks: [],
  }
  const preview = resultLines(sent as never).find(line => line.kind === 'preview')
  const item = preview?.kind === 'preview' ? preview.items[0] : undefined
  assert.equal(item?.text, '✅ shipped :slack: \\x1b[2J')
  assert.equal(item?.fields?.[0]?.value, '\u{1F525} hot')
})
