// The context receipt as the pane, the flags line, the transcript and the
// standing line say it (src/view/receipt.ts): what each words says, when a
// field is named and when a flag is raised, and that nothing a response wrote
// reaches the pane unescaped. Pure text, on fixtures of the test's own.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import type { CallIR, CallOutcome } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf, savedOutcome } from '../../src/result.ts'
import { flagsOf } from '../../src/view/flags.ts'
import { resultLines } from '../../src/view/outcome.ts'
import { SHED_ORDER, cardId, planOf, shedOrder } from '../../src/view/plan.ts'
import { CLOSED } from '../../src/view/kit.ts'
import { cardOf, metaWords, receiptOf } from '../../src/view/receipt.ts'
import { statusLine } from '../../src/view/status.ts'
import { resultBlockOf } from '../../src/view/transcript.ts'
import { LINKS } from './link-fixture.ts'

const irOf = (operation: string): CallIR => buildIR('t', normalize(operation, {}))
const SEARCH = irOf('query Q { jira_searchIssues(jql: "x") { issues { key fields } isLast } }')
const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
/** What the pane draws, with the words held together where a line may not break shown as spaces. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ')

/** `count` issues whose `fields.text` is `chars` characters long. */
const issues = (count: number, chars: number, others = 0) => ({
  data: { jira_searchIssues: { issues: Array.from({ length: count }, (_, i) => ({ key: `DEV-${i}`, fields: { text: 't'.repeat(chars), ...(others > 0 && { other: 'o'.repeat(others) }) } })), isLast: false } },
})
const receiptOfResponse = (response: unknown, ir: CallIR = SEARCH) => receiptOf(outcomeOf(ir, mcp(response)), ir)

test('a response that was read says its size, its tokens as about, and the field that took most of it', () => {
  const receipt = receiptOfResponse(issues(10, 1000))
  assert.ok(receipt !== undefined)
  assert.match(plain(receipt.line), /^\d+(\.\d)? KB · about [\d.]+k tokens · text \d+%$/)
  assert.equal(receipt.isKeptOut, false)
  assert.equal(receipt.fields[0]?.label, 'issues.fields.text')
  // The words that belong together do not break apart at a line's end.
  assert.match(receipt.line, /\d\u00a0KB/)
  assert.match(receipt.line, /about\u00a0[\d.]+k\u00a0tokens/)
})

test('a field the flags line already calls out is not named again on the line: each fact is said once', () => {
  const ir = SEARCH
  const outcome = outcomeOf(ir, mcp(issues(40, 1000)))
  const receipt = receiptOf(outcome, ir)
  assert.ok(receipt?.dominant !== undefined)
  assert.match(plain(receipt.line), /^\d+ KB · about [\d.]+k tokens$/)
  assert.ok(flagsOf(ir, outcome, true).some(flag => /^issues\.fields\.text is \d+% of a/.test(plain(flag.text))))
})

test('the response\'s own members beside the data keep their real name on the line, with plain words as a gloss for the cards', () => {
  const ir = irOf('query Q { r }')
  // Denial tokens are most of a small response: named on the line, not flagged.
  const response = { data: { r: 'x'.repeat(400) }, errors: Array.from({ length: 3 }, () => ({ message: 'm', extensions: { denial_context: 'tok'.repeat(300) } })) }
  const receipt = receiptOf(outcomeOf(ir, mcp(response)), ir)
  assert.ok(receipt !== undefined && receipt.dominant === undefined)
  assert.match(plain(receipt.line), /· denial_context \d+%$/)
  assert.equal(receipt.lead?.label, 'errors.extensions.denial_context')
  assert.equal(receipt.lead?.gloss, 'denial tokens')
  assert.ok(cardOf(receipt).fields.some(field => field.label === 'errors.extensions.denial_context'))
})

test('plain words for the response\'s members: denial tokens, error messages and details, anything else by its part', () => {
  const cases: [string, string][] = [
    ['errors.extensions.denial_context', 'denial tokens'],
    ['errors.extensions.code', 'error codes'],
    ['errors.extensions.visibility', 'denial details'],
    ['errors.extensions.anything', 'error details'],
    ['errors.extensions', 'error details'],
    ['errors.message', 'error messages'],
    ['errors.path', 'error paths'],
    ['errors.locations', 'error locations'],
    ['errors', 'errors'],
    ['errors.somethingNew', 'errors'],
    ['extensions', 'response extensions'],
    ['extensions.cost.requested', 'response extensions'],
    ['', 'response extensions'],
  ]
  for (const [path, words] of cases) assert.equal(metaWords(path), words, path)
})

test('a small response says its size and its tokens and names nothing: there is nothing worth a name', () => {
  const receipt = receiptOfResponse(issues(2, 100))
  assert.match(plain(receipt?.line ?? ''), /^\d+ B · about \d+ tokens$/)
  assert.equal(receipt?.lead, undefined)
})

test('a field is named in the line from a share of 30% of a response of 1 KB, and not before', () => {
  // `text` is well over a third of each row, and the response is a few KB: named.
  assert.match(receiptOfResponse(issues(30, 90, 40))?.line ?? '', /text/)
  // The same shares in a response under 1 KB: not named.
  assert.equal(receiptOfResponse(issues(3, 90, 40))?.lead, undefined)
  // A field under 30% of a big response is left out of the line.
  const spread = receiptOfResponse(issues(60, 100, 400))
  assert.notEqual(spread?.fields[0]?.entry.name, 'issues.fields.text')
})

test('a flag is for a field over half of a response over 16 KB: not at half, not under 16 KB, not for a whole root', () => {
  const flagged = (response: unknown, ir: CallIR = SEARCH) => flagsOf(ir, outcomeOf(ir, mcp(response)), true).filter(flag => /result$/.test(flag.text))
  const over = flagged(issues(20, 1200))
  assert.equal(over.length, 1)
  assert.match(plain(over[0]?.text ?? ''), /^issues\.fields\.text is \d+% of a \d+ KB result$/)
  assert.equal(over[0]?.tone, 'warn')
  // Just under 16 KB.
  assert.deepEqual(flagged(issues(12, 1200)), [])
  // Over 16 KB, but the field is under half of it.
  assert.deepEqual(flagged(issues(20, 700, 700)), [])
  // One root that is all of the response (its fields spread over many small ones) is the response, which says nothing.
  const members = irOf('query Q { members { f0 } }')
  const row = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'v'.repeat(100)]))
  assert.deepEqual(flagged({ data: { members: Array.from({ length: 12 }, () => row) } }, members), [])
})

test('the flag says what it cost and what it would be without the field, and that for a result Claude only saw a preview of', () => {
  const live = flagsOf(SEARCH, outcomeOf(SEARCH, mcp(issues(20, 1200))), true).find(flag => /result$/.test(flag.text))
  assert.match(plain(live?.detail ?? ''), /^issues\.fields\.text is \d+% of the \d+ KB response \(about [\d.]+k tokens\)\. Without it the response would be about \d+ (B|KB)/)
  const saved = flagsOf(SEARCH, savedOutcome(outcomeOf(SEARCH, mcp(issues(20, 1200)))), true).find(flag => /result$/.test(flag.text))
  assert.match(saved?.detail ?? '', /Claude saw only a short preview/)
})

test('RESULT ends with the line, for a response that was read; a response that was not read has none', () => {
  const outcome = outcomeOf(SEARCH, mcp(issues(20, 1200)))
  const lines = resultLines(outcome, SEARCH)
  assert.equal(lines.at(-1)?.kind, 'weight')
  assert.equal(lines.filter(line => line.kind === 'weight').length, 1)
  // Not a response at all: no context line, only what came back in its place.
  assert.deepEqual(resultLines(outcomeOf(SEARCH, { content: [{ type: 'text', text: 'Error: nope' }] }), SEARCH), [{ kind: 'error', isDenied: false, text: 'Error: nope' }])
  // An outcome from before the weight was kept draws as it did.
  const { weight: _weight, ...older } = outcome
  assert.equal(resultLines(older, SEARCH).some(line => line.kind === 'weight'), false)
})

test('a result Claude Code kept out of the context says Claude saw only a short preview and a file path, sized from the file when it was read back', () => {
  const response = issues(20, 1200)
  const read = savedOutcome(outcomeOf(SEARCH, { content: [{ type: 'text', text: JSON.stringify(response) }] }))
  const line = plain(receiptOf(read, SEARCH)?.line ?? '')
  // Its heaviest field is over half of it: the flags line says so, the line does not again.
  assert.match(line, /^\d+ KB saved to a file · Claude saw only a short preview and its path$/)
  assert.doesNotMatch(line, /tokens/)
  // Not read back: only Claude Code's own figure, said as approximate.
  const stood = outcomeOf(SEARCH, '<persisted-output>\nOutput too large (58.2KB). Full output saved to: /Users/x/.claude/projects/-p/abc/tool-results/t.json\n\nPreview (first 2KB):\n...\n</persisted-output>')
  const approximate = receiptOf(stood, SEARCH)
  assert.equal(plain(approximate?.line ?? ''), 'about 58 KB saved to a file · Claude saw only a short preview and its path')
  assert.equal(approximate?.isApproximate, true)
  assert.deepEqual(approximate?.fields, [])
  // Not even a figure.
  const unsized = receiptOf({ rows: [], errors: [], authLinks: [], isUnreadable: true, isTooLarge: true }, SEARCH)
  assert.equal(unsized?.line, 'saved to a file · Claude saw only a short preview and its path')
  // And its RESULT says so with no rows to go with it.
  assert.deepEqual(resultLines(stood, SEARCH).map(one => one.kind), ['weight'])
})

test('the card says each named field\'s size, share and cost a row, what the result would be without it, and the card is what a person reads', () => {
  const receipt = receiptOfResponse(issues(40, 1000))
  assert.ok(receipt !== undefined)
  const card = cardOf(receipt)
  assert.match(plain(card.title), /^context · \d+ KB · about [\d.]+k tokens$/)
  assert.match(plain(card.paragraphs[0] ?? ''), /^Claude read this whole response: \d+ KB, or about [\d.]+k tokens\./)
  // How it is measured, said as an estimate.
  assert.match(card.paragraphs[1] ?? '', /compactly, in UTF-8 bytes/)
  assert.match(card.paragraphs[1] ?? '', /about 4 characters each, not a count/)
  const [field] = card.fields
  assert.equal(field?.label, 'issues.fields.text')
  assert.match(plain(field?.takes ?? ''), /^\d+ KB · \d+% of the response · 40 rows, about \d+ B each$/)
  assert.match(plain(field?.without ?? ''), /^Without issues\.fields\.text this result would be about \d+(\.\d)? KB \(about \d+ tokens\)\.$/)
  assert.equal(card.fields.length, receipt.fields.length)
})

test('a result kept out of the context says so in its card, and what it would take if read', () => {
  const card = cardOf(receiptOf(savedOutcome(outcomeOf(SEARCH, mcp(issues(40, 1000)))), SEARCH)!)
  assert.match(plain(card.title), /^context · \d+ KB saved to a file$/)
  assert.match(card.paragraphs[0] ?? '', /kept this response out of Claude's context/)
  assert.match(card.paragraphs[0] ?? '', /Claude saw only a short preview and the file's path/)
  assert.match(plain(card.paragraphs[0] ?? ''), /Read in full, it would take about [\d.]+k tokens/)
  assert.match(card.fields[0]?.without ?? '', /the saved file would be/)
  const stood = cardOf(receiptOf(outcomeOf(SEARCH, '<persisted-output>\nOutput too large (58.2KB). Full output saved to: /Users/x/.claude/projects/-p/abc/tool-results/t.json\n</persisted-output>'), SEARCH)!)
  assert.match(stood.paragraphs[0] ?? '', /did not read the file/)
  assert.deepEqual(stood.fields, [])
})

test('each field says where its description comes from: the schema when the call selected it, else why there is none', () => {
  const ir = irOf('query Q { jira_searchIssues(jql: "x") { issues { key fields } isLast } }')
  const text = 'x'.repeat(900)
  // `key` is selected (and is heavy here); `fields.text` is inside untyped JSON.
  const response = { data: { jira_searchIssues: { issues: Array.from({ length: 30 }, () => ({ key: 'K'.repeat(500), fields: { text } })), isLast: true } } }
  const homes = Object.fromEntries((receiptOf(outcomeOf(ir, mcp(response)), ir)?.fields ?? []).map(field => [field.label, field.home.kind]))
  assert.equal(homes['issues.key'], 'selected')
  assert.equal(homes['issues.fields.text'], 'json')
  const errors = outcomeOf(ir, mcp({ errors: Array.from({ length: 12 }, () => ({ message: 'm', extensions: { denial_context: 'tok'.repeat(400) } })) }))
  assert.equal(receiptOf(errors, ir)?.fields[0]?.home.kind, 'response')
})

test('a field is named as the pane names things: a lone root\'s name is left out, several roots keep theirs, the response\'s own members are by path', () => {
  const one = receiptOfResponse(issues(30, 600))
  assert.equal(one?.fields[0]?.label, 'issues.fields.text')
  const two = irOf('query Q { open: jira_searchIssues(jql: "x") { issues { key fields } } closed: jira_searchIssues(jql: "y") { issues { key fields } } }')
  const big = { issues: Array.from({ length: 30 }, () => ({ key: 'K', fields: { text: 't'.repeat(600) } })) }
  const labels = receiptOfResponse({ data: { open: big, closed: big } }, two)?.fields.map(field => field.label)
  assert.deepEqual(labels, ['open.issues.fields.text', 'closed.issues.fields.text'])
  const unaliased = irOf('query Q { jira_searchIssues(jql: "x") { issues { key fields } } jira_countIssues(jql: "x") { count } }')
  assert.equal(receiptOfResponse({ data: { jira_searchIssues: big, jira_countIssues: { count: 1 } } }, unaliased)?.fields[0]?.label, 'jira_searchIssues.issues.fields.text')
  const meta = receiptOfResponse({ data: null, errors: Array.from({ length: 12 }, () => ({ message: 'm', extensions: { denial_context: 'tok'.repeat(400) } })) })
  assert.equal(meta?.fields[0]?.label, 'errors.extensions.denial_context')
})

test('what the response wrote is escaped wherever the receipt says it: the line, the flag, the card', () => {
  const key = 'bad\u001b[31m\u001b]0;title\u0007key'
  const ir = irOf('query Q { r }')
  const outcome = outcomeOf(ir, mcp({ data: { r: Array.from({ length: 30 }, () => ({ [key]: 'v'.repeat(900) })) } }))
  const receipt = receiptOf(outcome, ir)
  assert.ok(receipt !== undefined)
  const said = [receipt.line, ...flagsOf(ir, outcome, true).flatMap(flag => [flag.text, flag.detail]), ...cardOf(receipt).fields.flatMap(field => [field.label, field.takes, field.without])].join('\n')
  assert.match(said, /key/)
  assert.doesNotMatch(said, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
})

test('the transcript\'s first line carries the size, and a result kept out of the context says so there too', () => {
  const outcome = outcomeOf(SEARCH, mcp(issues(20, 1200)))
  const block = resultBlockOf(outcome, SEARCH, LINKS)
  assert.match(block?.size ?? '', /^\d+\u00a0KB$/)
  assert.match(resultBlockOf(savedOutcome(outcome), SEARCH, LINKS)?.size ?? '', /^\d+\u00a0KB saved to a file$/)
  // Only where there is a first line to carry it: a response with nothing else to say gets no block.
  assert.equal(resultBlockOf(outcomeOf(SEARCH, mcp({ errors: [{ message: 'boom' }] })), SEARCH, LINKS), undefined)
  assert.equal(resultBlockOf({ rows: [], errors: [], authLinks: [], isUnreadable: true, isTooLarge: true }, SEARCH, LINKS), undefined)
})

test('the standing line counts the bytes Claude read, after the calls, and says nothing of them when there are none', () => {
  const none = { calls: 5, unasked: 0, rules: 0, isTrustOff: false, isTrustFileChanged: false }
  assert.equal(statusLine({ ...none, bytes: 212 * 1024 }), 'Agent Services · 5 calls · 212 KB read')
  assert.equal(statusLine({ ...none, bytes: 0 }), 'Agent Services · 5 calls')
  assert.equal(statusLine(none), 'Agent Services · 5 calls')
  assert.equal(statusLine({ ...none, bytes: 700, rules: 3, unasked: 2 }), 'Agent Services · 5 calls · 700 B read · 3 trust rules · 2 ran unasked')
})

// ---- The planner

const options = (rows: number, outcome: CallOutcome | undefined) => ({ rows, columns: 64, isPending: false, open: CLOSED, now: 0, status: '✓ ran', ...(outcome !== undefined && { outcome }) })

test('the planner counts the context line as a row of RESULT and anchors its card on those rows', () => {
  const outcome = outcomeOf(SEARCH, mcp(issues(20, 1200)))
  const plan = planOf(SEARCH, options(Infinity, outcome))
  const line = plan.result.lines.at(-1)
  assert.equal(line?.kind, 'weight')
  const anchor = plan.anchors.get(cardId.weight())
  assert.ok(anchor !== undefined && anchor.rows >= 1)
  // A pane with no outcome has no such line, and no card for it.
  assert.equal(planOf(SEARCH, options(Infinity, undefined)).anchors.has(cardId.weight()), false)
  // The line costs the rows it takes.
  const without = planOf(SEARCH, options(Infinity, { ...outcome, weight: undefined } as CallOutcome))
  assert.ok(plan.total - without.total >= 1)
})

test('in a pane too short for everything the context line is the first of RESULT to go, before the form is cut', () => {
  const outcome = outcomeOf(SEARCH, mcp(issues(20, 1200)))
  const full = planOf(SEARCH, options(Infinity, outcome))
  const plan = planOf(SEARCH, options(full.total - 1, outcome))
  assert.equal(plan.shed[0], 'result-weight')
  assert.equal(plan.result.lines.some(line => line.kind === 'weight'), false)
  assert.equal(plan.anchors.has(cardId.weight()), false)
  // The rows lines stay: what came back is what the pane is for.
  assert.ok(plan.result.lines.some(line => line.kind === 'rows'))
  // Ahead of the form's own cuts, in the ladder every pane follows.
  const order = shedOrder(true)
  assert.ok(order.indexOf('result-weight') < order.indexOf('returns-collapse'))
  assert.ok(order.indexOf('result-weight') > order.indexOf('summary-credit'))
  assert.ok(SHED_ORDER.includes('result-weight'))
})
