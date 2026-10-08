import { URL } from 'node:url'
// Oversized results (Claude Code swaps them for an error text naming a saved file) and rows past the call's limit.
import { flagsOf, flagsText } from '../../src/view/flags.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf, pickResult, truncationOf } from '../../src/result.ts'
import { resultLines } from '../../src/view/outcome.ts'
import { returnLines } from '../../src/view/plan.ts'

const OP = 'query R($size: Int) { incidents: incidentio_incidents(pageSize: $size) { ref name } }'
const ir = buildIR('t', normalize(OP, { size: 3 }))
const SAVED = '/Users/x/.claude/projects/-p/abc/tool-results/mcp-claude_ai_GraphOS_Agent_Services-execute-1.txt'
const REPLACEMENT = `Error: result (79,951 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${SAVED}\nFormat: JSON array`
const fixture = readFileSync(new URL('../fixtures/large-incidents.json', import.meta.url), 'utf8')

test('the replacement text names its size and the saved file; the line says too large, not unreadable GraphQL', () => {
  assert.deepEqual(truncationOf(REPLACEMENT), { chars: 79951, path: SAVED })
  const outcome = outcomeOf(ir, REPLACEMENT)
  assert.equal(outcome.isTooLarge, true)
  // A flag says it; RESULT has no rows of it, only the context line (what Claude saw of it).
  assert.deepEqual(resultLines(outcome, ir).filter(line => line.kind !== 'weight'), [])
  // In the unit RESULT uses: KB, about, never characters.
  assert.ok(flagsOf(ir, outcome, true).some(flag => /^response kept out of Claude's context \u00b7 about\u00a0\d+\u00a0KB$/.test(flag.text)), flagsOf(ir, outcome, true).map(flag => flag.text).join(' | '))
})

test("2.1.29x's <persisted-output> stand-in is read the same way: its size, its saved file, and too large rather than unreadable", () => {
  const saved = '/Users/x/.claude/projects/-p/abc/tool-results/toolu_01AbCdEfGhIjKlMnOpQrStUv.json'
  const persisted = `<persisted-output>\nOutput too large (58.2KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n[\n  {\n    "type": "text",\n    "text": "{\\"data\\":{\\"dr087\\":{\n...\n</persisted-output>`
  assert.deepEqual(truncationOf(persisted), { chars: 59597, path: saved })
  const outcome = outcomeOf(ir, persisted)
  assert.equal(outcome.isTooLarge, true)
  // A response whose text merely mentions the words is still a response.
  assert.equal(truncationOf('{"data":{"a":"<persisted-output> Output too large"}}'), undefined)
})

test('only a file under a .claude/projects tool-results tree is accepted as a saved path', () => {
  for (const path of ['/etc/passwd', '/tmp/tool-results/a.txt', '/Users/x/.claude/projects/-p/abc/tool-results/../../../x.txt']) {
    assert.equal(truncationOf(`exceeds maximum allowed tokens. saved to ${path}`)?.path, undefined)
  }
})

test('a saved path is read whole on any machine: a home folder with a space, a Windows drive and backslashes, text after it on its line', () => {
  const persisted = (path: string) => `<persisted-output>\nOutput too large (58.2KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n...\n</persisted-output>`
  const replaced = (path: string) => `Error: result (79,951 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${path}\nFormat: JSON array`
  for (const path of [
    '/Users/Jane Doe/.claude/projects/-Users-Jane-Doe-dev-app/abc/tool-results/toolu_01Ab.json',
    'C:\\Users\\jdoe\\.claude\\projects\\C--Users-jdoe-dev\\abc\\tool-results\\mcp-claude_ai_GraphOS_Agent_Services-execute-1.txt',
    'C:\\Users\\Jane Doe\\.claude\\projects\\p\\tool-results\\toolu_9.json',
    '/home/me/.claude/projects/p/tool-results/big.txt',
  ]) {
    assert.equal(truncationOf(persisted(path))?.path, path)
    assert.equal(truncationOf(replaced(path))?.path, path)
  }
  // A sentence after the path on its line is not part of it.
  assert.equal(truncationOf(replaced('/Users/x/.claude/projects/-p/abc/tool-results/t.txt. Read it in parts.'))?.path, '/Users/x/.claude/projects/-p/abc/tool-results/t.txt')
})

test('a saved path never walks out of the tree, never names a share, a URL or a relative path, and never runs past its line', () => {
  for (const path of [
    'C:\\Users\\x\\.claude\\projects\\p\\abc\\tool-results\\..\\..\\..\\secrets.txt',
    '/Users/x/.claude/projects/p/abc/tool-results/..%2F..%2Fx.txt',
    '\\\\server\\share\\.claude\\projects\\p\\tool-results\\x.json',
    'file:///Users/x/.claude/projects/p/tool-results/x.json',
    '.claude/projects/p/tool-results/x.json',
    '/Users/x/.claude/projects/p/a/b/c/tool-results/x.json',
    '/Users/x/.claude/projects/p/tool-results/x.sh',
    '/Users/x/.claude/projects/p/tool-results/',
  ]) {
    assert.equal(truncationOf(`exceeds maximum allowed tokens. Output has been saved to ${path}`)?.path, undefined, path)
  }
  // The next line is never read as more of the path.
  assert.equal(truncationOf('exceeds maximum allowed tokens. Output has been saved to /Users/x/.claude/projects/p\n/tool-results/x.json')?.path, undefined)
})

test('the saved file (content blocks, or the bare response) reads like a live result', () => {
  const bare = JSON.stringify(JSON.parse(JSON.parse(fixture)[0].text))
  for (const saved of [fixture, bare]) {
    const outcome = outcomeOf(ir, saved)
    assert.equal(outcome.isUnreadable, undefined)
    assert.equal(outcome.rows[0]?.count, 25)
  }
})

test('full content blocks beat a stand-in error text', () => {
  const blocks = JSON.parse(fixture)
  assert.equal(pickResult(REPLACEMENT, blocks), blocks)
  assert.equal(pickResult(REPLACEMENT, undefined), REPLACEMENT)
  assert.equal(pickResult('{"data":{}}', blocks), '{"data":{}}')
})

test('a response quoting a saved-output notice remains ordinary response content', () => {
  const text = JSON.stringify({ data: { incidents: [{ ref: 'a', name: REPLACEMENT.replace('\n', ' ') }] } })
  const blocks = [{ type: 'text', text }]
  for (const response of [text, blocks, JSON.stringify(blocks)]) {
    assert.equal(truncationOf(response), undefined)
    assert.equal(outcomeOf(ir, response).rows[0]?.count, 1)
  }
  assert.equal(pickResult(text, undefined), text)
})

test('more rows than the limit argument is flagged in the warning tone', () => {
  const rows = resultLines(outcomeOf(ir, fixture), ir).find(line => line.kind === 'rows')
  // The number takes the warning tone; the flags line says what was asked.
  assert.ok(rows?.kind === 'rows' && rows.isWarn === true && rows.note === undefined && rows.text.startsWith('25'))
  assert.ok(flagsOf(ir, outcomeOf(ir, fixture), true).some(flag => /returned\u00a025\u00a0\(asked\u00a03\)$/.test(flag.text)))
})

test('the return tree says what the call asks for, never what comes back: that is the flags line\'s to say', () => {
  const root = { ...ir.roots[0]!, schema: { type: '[Inc]', isList: true, isNonNull: false, isListItemNonNull: false, isListNonNull: false, scopes: [], tags: [] } }
  const note = returnLines(root as never)[0]?.note ?? ''
  assert.match(note, /^asks for 3 /)
  assert.doesNotMatch(note, /up to/)
  assert.doesNotMatch(note, /got/)
  const big = outcomeOf(ir, JSON.stringify({ data: { incidents: Array.from({ length: 25 }, (_, i) => ({ ref: `r${i}`, name: 'n' })) } }))
  assert.match(flagsText(flagsOf(ir, big, true)), /returned\u00a025\u00a0\(asked\u00a03\)/)
})

test('a list within its limit is not flagged', () => {
  const small = outcomeOf(ir, JSON.stringify({ data: { incidentio_incidents: [{ ref: 'a', name: 'n' }] } }))
  const rows = resultLines(small, ir).find(line => line.kind === 'rows')
  assert.ok(rows?.kind === 'rows' && rows.isWarn === undefined)
})
