import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadLinkConfig } from '../../src/links.ts'
import { outcomeOf } from '../../src/result.ts'
import { MAX_HEADS, MAX_ITEMS, resultBlockOf } from '../../src/view/transcript.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { reviewCall } from '../../tests/review-fixtures.ts'

// Link rules of the test's own: no shipped host is assumed.
const { config: WIKI } = loadLinkConfig({
  shipped: `[bases]
wiki = "https://wiki.example.com"

[[record]]
service = "jira"
field = "key"
url = "{wiki}/browse/{value}"
`,
})

const reply = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

test('a call that ran says what came back and shows its first records, keys as links, and how many more there are', () => {
  const call = reviewCall('ran')
  const block = resultBlockOf(call.outcome, call.ir, WIKI)
  assert.ok(block !== undefined)
  // The rows line, as the pane draws it, for each list (the Jira issues, the org's members).
  assert.ok(block.heads.length >= 1 && block.heads.length <= MAX_HEADS)
  assert.match(block.heads.join('\n'), /5/)
  assert.equal(block.items.length, MAX_ITEMS)
  assert.deepEqual(block.items.map(item => item.key), ['[DEV-634]', '[DEV-467]', '[DEV-589]'])
  assert.deepEqual(block.items.map(item => item.url), ['https://wiki.example.com/browse/DEV-634', 'https://wiki.example.com/browse/DEV-467', 'https://wiki.example.com/browse/DEV-589'])
  // What follows each key is the record's own text.
  assert.match(block.items[0]?.text ?? '', /CSV export to the reports page/)
  // Five issues came back; three are shown.
  assert.equal(block.more, 2)
})

test('a record with no link says its key plainly', () => {
  const call = reviewCall('ran')
  const block = resultBlockOf(call.outcome, call.ir, loadLinkConfig({ shipped: '' }).config)
  assert.ok(block !== undefined)
  assert.ok(block.items.length > 0)
  for (const item of block.items) {
    assert.equal(item.url, undefined)
    assert.doesNotMatch(item.key, /^\[/)
  }
})

test('nothing for a call with no outcome yet, an unreadable response or one too large to read', () => {
  const call = reviewCall('ran')
  assert.equal(resultBlockOf(undefined, call.ir, WIKI), undefined)
  assert.equal(resultBlockOf({ rows: [], errors: [], authLinks: [], isUnreadable: true }, call.ir, WIKI), undefined)
  assert.equal(resultBlockOf({ rows: [], errors: [], authLinks: [], isUnreadable: true, isTooLarge: true }, call.ir, WIKI), undefined)
  // Not a GraphQL response at all.
  assert.equal(resultBlockOf(outcomeOf(call.ir, { content: [{ type: 'text', text: 'Error: nope' }] }), call.ir, WIKI), undefined)
})

test('a response that is only errors has nothing to show here: the verdict and the pane say it', () => {
  const ir = buildIR('toolu_x', normalize('query Q { jira_searchIssues(jql: "x") { issues { key } } }', {}))
  const outcome = outcomeOf(ir, reply({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL' } }] }))
  assert.equal(resultBlockOf(outcome, ir, WIKI), undefined)
})

test('a value with no list is a line and no records', () => {
  const ir = buildIR('toolu_x', normalize('query Q { jira_countIssues(jql: "x") { count } }', {}))
  const block = resultBlockOf(outcomeOf(ir, reply({ data: { jira_countIssues: { count: 412 } } })), ir, WIKI)
  assert.ok(block !== undefined)
  assert.match(block.heads.join('\n'), /412/)
  assert.deepEqual(block.items, [])
  assert.equal(block.more, 0)
})

test('what the response said is escaped: a key or a title cannot carry a control sequence into the transcript', () => {
  const ir = buildIR('toolu_x', normalize('query Q { jira_searchIssues(jql: "x") { issues { key fields } } }', {}))
  const outcome = outcomeOf(ir, reply({ data: { jira_searchIssues: { issues: [{ key: 'DEV-1\x1b[2J', fields: { summary: 'bad \x1b]0;title\x07 title' } }] } } }), WIKI)
  const block = resultBlockOf(outcome, ir, WIKI)
  assert.ok(block !== undefined)
  const everything = [...block.heads, ...block.items.flatMap(item => [item.key, item.text])].join('\n')
  assert.doesNotMatch(everything, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
})
