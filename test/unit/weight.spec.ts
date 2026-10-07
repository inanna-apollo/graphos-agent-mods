// What a response cost in context, and which fields cost it (src/weight.ts):
// the measure, the choice of fields to name, the bounds, the words for a size.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf, savedOutcome } from '../../src/result.ts'
import { MAX_DEPTH, MAX_HEAVY, MAX_PATHS, MAX_SEGMENT, bytesWithout, fieldsOf, percentText, sizeText, tokensOf, tokensText, utf8Bytes, weightOf } from '../../src/weight.ts'

const irOf = (operation: string) => buildIR('t', normalize(operation, {}))
const SEARCH = irOf('query Q { jira_searchIssues(jql: "x") { issues { key fields } isLast } }')
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const mcp = (value: unknown, space?: number) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, space) }] })

test('a string is counted in UTF-8 bytes as an encoder writes it, lone surrogates included', () => {
  for (const text of ['', 'abc', 'café', 'ß', '中文', '€', '\u{1f600}', 'a\u{1f600}b', '\ud800', '\udc00', '\ud800a', 'a\udc00', '😀\ud83d', '\u0000\u007f\u0080߿ࠀ\uffff']) {
    assert.equal(utf8Bytes(text), Buffer.byteLength(text), JSON.stringify(text))
  }
})

test('the total is the response as compact JSON, byte for byte, whatever it holds', () => {
  const shapes: unknown[] = [
    {},
    { data: {} },
    { data: null },
    { data: { r: null } },
    { data: { r: [] } },
    { data: { r: {} } },
    { data: { r: [{}, [], [[1, 2], [3]], null] } },
    { data: { r: { n: 1, f: -0.5, e: 1e21, small: 1e-7, big: 12345678901234567890, t: true, f2: false, z: null } } },
    { data: { r: { s: 'quote " backslash \\ slash / tab \t newline \n cr \r bell \u0007 nul \u0000 del \u007f' } } },
    { data: { r: { s: '\u2028\u2029 é 中文 \u{1f600} \ud800 lone \udc00' } } },
    { data: { r: { 'é中 \u{1f600} "key"': 'v', '': '' } } },
    { data: { r: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `n${i}`, tags: ['a', 'b'] })) }, errors: [{ message: 'm', path: ['r', 3, 'x'], extensions: { code: 'C' } }], extensions: { cost: 4 } },
    { errors: [{ message: 'boom' }] },
  ]
  for (const shape of shapes) assert.equal(weightOf(SEARCH, shape)?.bytes, bytesOf(shape), JSON.stringify(shape).slice(0, 80))
})

test('the measure does not move with a service\'s whitespace: pretty text and compact text weigh the same', () => {
  const response = { data: { jira_searchIssues: { issues: [{ key: 'DEV-1', fields: { summary: 'x'.repeat(300) } }], isLast: true } } }
  const compact = outcomeOf(SEARCH, mcp(response)).weight
  const pretty = outcomeOf(SEARCH, mcp(response, 4)).weight
  assert.ok(compact !== undefined)
  assert.deepEqual(pretty, compact)
  assert.equal(compact.bytes, bytesOf(response))
})

test('a field is its path with list indices dropped: the rows of a list are summed, and each key is counted with its value', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ key: `DEV-${i}`, fields: { summary: `s${i}`, description: 'd'.repeat(200) } }))
  const response = { data: { jira_searchIssues: { issues: rows, isLast: false } } }
  const weight = weightOf(SEARCH, response)
  assert.ok(weight !== undefined)
  const [top] = weight.fields
  assert.equal(top?.path, 'jira_searchIssues.issues.fields.description')
  assert.equal(top?.name, 'issues.fields.description')
  // Every row's `"description":"ddd…"`, key and value, summed.
  assert.equal(top?.bytes, 50 * (Buffer.byteLength('"description":') + bytesOf('d'.repeat(200))))
  assert.equal(top?.rows, 50)
  assert.equal(top?.share, Math.round((top!.bytes / weight.bytes) * 10_000) / 10_000)
  assert.ok(top!.share > 0.8)
})

test('every tracked path has its exact bytes, real name, rows and share, in the order the response wrote them', () => {
  const ir = irOf('query Q { open: jira_searchIssues(jql: "x") { rows: issues { id: key body: fields } isLast } }')
  const rows = [{ id: 'A', body: { text: 'é' } }, { id: 'BB', body: null }]
  const data = { open: { rows, isLast: true } }
  const errors = [{ message: 'm' }]
  const response = { data, errors }
  const table = fieldsOf(ir, response)
  assert.ok(table !== undefined)
  assert.equal(table.bytes, bytesOf(response))
  // One member as JSON writes it: the key, a colon, the value.
  const member = (key: string, value: unknown) => Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)}`)
  const share = (bytes: number) => Math.round((bytes / table.bytes) * 10_000) / 10_000
  const expected = [
    { path: 'open', name: '', bytes: member('open', data.open) },
    { path: 'open.rows', name: 'issues', bytes: member('rows', rows), rows: 2 },
    { path: 'open.rows.id', name: 'issues.key', bytes: member('id', 'A') + member('id', 'BB'), rows: 2 },
    { path: 'open.rows.body', name: 'issues.fields', bytes: member('body', rows[0]!.body) + member('body', null), rows: 2 },
    { path: 'open.rows.body.text', name: 'issues.fields.text', bytes: member('text', 'é'), rows: 2 },
    { path: 'open.isLast', name: 'isLast', bytes: member('isLast', true) },
    { path: 'errors', name: 'errors', bytes: member('errors', errors), rows: 1, isMeta: true as const },
    { path: 'errors.message', name: 'errors.message', bytes: member('message', 'm'), rows: 1, isMeta: true as const },
  ].map(one => ({ ...one, share: share(one.bytes) }))
  assert.deepEqual(table.fields, expected)
  // A field holds the fields under it.
  const bytes = Object.fromEntries(table.fields.map(field => [field.path, field.bytes]))
  assert.ok(bytes['open']! >= bytes['open.rows']! + bytes['open.isLast']!)
  assert.ok(bytes['open.rows']! >= bytes['open.rows.id']! + bytes['open.rows.body']!)
  assert.equal(fieldsOf(ir, [1]), undefined)
})

test('rows are those of the nearest list on the path, the field\'s own included, and absent where there is none', () => {
  const nested = irOf('query Q { teams { name members { email } } }')
  const teams = Array.from({ length: 3 }, (_, t) => ({ name: `t${t}`, members: Array.from({ length: t + 2 }, () => ({ email: 'e'.repeat(300) })) }))
  const weight = weightOf(nested, { data: { teams } })
  assert.equal(weight?.fields[0]?.path, 'teams.members.email')
  // 2 + 3 + 4 members in all, not 3 teams.
  assert.equal(weight?.fields[0]?.rows, 9)
  const whole = weightOf(irOf('query Q { teams { name } }'), { data: { teams: Array.from({ length: 7 }, () => ({ name: 'n'.repeat(500) })) } })
  assert.equal(whole?.fields[0]?.path, 'teams.name')
  assert.equal(whole?.fields[0]?.rows, 7)
  // A list that is itself the field named: its rows are its items.
  const list = weightOf(irOf('query Q { tags }'), { data: { tags: Array.from({ length: 40 }, () => 'tag-'.repeat(20)) } })
  assert.equal(list?.fields[0]?.path, 'tags')
  assert.equal(list?.fields[0]?.rows, 40)
  // No list anywhere on the path.
  const flat = weightOf(irOf('query Q { jira_count { text } }'), { data: { jira_count: { text: 'x'.repeat(400) } } })
  assert.equal(flat?.fields[0]?.path, 'jira_count.text')
  assert.equal(flat?.fields[0]?.rows, undefined)
})

test('a null costs its key and four bytes, once per row that has one; an absent field costs nothing', () => {
  const ir = irOf('query Q { members { id note email } }')
  const members = Array.from({ length: 40 }, (_, i) => ({ id: `id-${i}`, note: i % 2 === 0 ? null : 'n'.repeat(400), email: null }))
  const weight = weightOf(ir, { data: { members } })
  assert.equal(weight?.fields[0]?.path, 'members.note')
  assert.equal(weight?.fields[0]?.bytes, 20 * Buffer.byteLength('"note":null') + 20 * Buffer.byteLength(`"note":${JSON.stringify('n'.repeat(400))}`))
  // No row at all carries it here.
  const absent = weightOf(ir, { data: { members: members.map(({ note: _note, ...rest }) => rest) } })
  assert.ok(!(absent?.fields ?? []).some(field => field.path === 'members.note'))
})

test('bytes, not characters: Chinese text costs three bytes a character, an emoji four, and the total says so', () => {
  const ir = irOf('query Q { notes { cjk emoji ascii } }')
  const note = { cjk: '中'.repeat(100), emoji: '\u{1f600}'.repeat(100), ascii: 'a'.repeat(100) }
  const weight = weightOf(ir, { data: { notes: [note] } })
  assert.equal(weight?.bytes, bytesOf({ data: { notes: [note] } }))
  const by = Object.fromEntries((weight?.fields ?? []).map(field => [field.name, field.bytes]))
  assert.equal(by.emoji, Buffer.byteLength('"emoji":') + 2 + 400)
  assert.equal(by.cjk, Buffer.byteLength('"cjk":') + 2 + 300)
  // Ranked by what they cost, not by their length.
  assert.deepEqual((weight?.fields ?? []).map(field => field.name).slice(0, 2), ['emoji', 'cjk'])
})

test('a field is named by its real name, whatever alias the response wrote it under; the path keeps the response\'s keys', () => {
  const ir = irOf('query Q { open: jira_searchIssues(jql: "x") { rows: issues { id: key body: fields } isLast } }')
  const response = { data: { open: { rows: Array.from({ length: 10 }, () => ({ id: 'DEV-1', body: { text: 't'.repeat(500) } })), isLast: true } } }
  const weight = weightOf(ir, response)
  assert.equal(weight?.fields[0]?.path, 'open.rows.body.text')
  // `issues`, `fields`: what the call selected; `text` is inside untyped JSON, which the IR has no field for.
  assert.equal(weight?.fields[0]?.name, 'issues.fields.text')
})

test('two roots keep their own paths, so the same field name under each is told apart', () => {
  const ir = irOf('query Q { a: jira_searchIssues(jql: "x") { issues { key fields } } b: jira_searchIssues(jql: "y") { issues { key fields } } }')
  const big = (n: number) => ({ issues: Array.from({ length: 10 }, () => ({ key: 'K', fields: { text: 't'.repeat(n) } })) })
  const weight = weightOf(ir, { data: { a: big(500), b: big(450) } })
  assert.deepEqual(weight?.fields.map(field => field.path), ['a.issues.fields.text', 'b.issues.fields.text'])
  assert.deepEqual(weight?.fields.map(field => field.name), ['issues.fields.text', 'issues.fields.text'])
})

test('which fields explain the response: down into the field that holds most of it, while it does', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ key: `DEV-${i}`, fields: { summary: `Issue ${i}`, description: 'd'.repeat(800), comment: { total: 1, items: [{ body: 'c'.repeat(150) }] } } }))
  const weight = weightOf(SEARCH, { data: { jira_searchIssues: { issues: rows, isLast: false } } })
  // Not `jira_searchIssues` (the whole response) and not `issues` (almost all of it): the fields a person would drop or narrow.
  assert.deepEqual(weight?.fields.map(field => field.name), ['issues.fields.description', 'issues.fields.comment.items.body'])
  assert.ok((weight?.fields[0]?.share ?? 0) > 0.7)
  assert.ok((weight?.fields[1]?.share ?? 0) > 0.1)
})

test('weight spread over many small fields is named by the field that holds them: no one of them is the answer', () => {
  const ir = irOf('query Q { members { f0 } }')
  const row = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'v'.repeat(100)]))
  const weight = weightOf(ir, { data: { members: Array.from({ length: 20 }, () => row) } })
  assert.deepEqual(weight?.fields.map(field => field.path), ['members'])
  assert.equal(weight?.fields[0]?.rows, 20)
})

test('a field over a tenth of the response that is only a sliver of its parent does not stand for the parent', () => {
  const ir = irOf('query Q { r { a } }')
  // `a` is 15% of the response; the rest of `r` is spread over many small fields.
  const small = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, 'x'.repeat(60)]))
  const weight = weightOf(ir, { data: { r: { a: 'y'.repeat(450), ...small } } })
  assert.deepEqual(weight?.fields.map(field => field.path), ['r'])
})

test('two heavy fields are both named, heaviest first; a field under a tenth is left out', () => {
  const ir = irOf('query Q { r { a b c } }')
  const weight = weightOf(ir, { data: { r: { a: 'x'.repeat(400), b: 'y'.repeat(600), c: 'z'.repeat(20) } } })
  assert.deepEqual(weight?.fields.map(field => field.name), ['b', 'a'])
  assert.ok(weight!.fields.every(field => field.share >= 0.1))
})

test('a response whose only root is a few bytes still names it; nothing is named in a response with no data and no errors', () => {
  const weight = weightOf(irOf('query Q { n }'), { data: { n: 1 } })
  assert.equal(weight?.bytes, bytesOf({ data: { n: 1 } }))
  assert.deepEqual(weight?.fields.map(field => field.path), ['n'])
  for (const empty of [{}, { data: {} }, { data: null }, { data: { r: [] } }]) assert.deepEqual(weightOf(SEARCH, empty)?.fields.filter(field => field.bytes > 8), [], JSON.stringify(empty))
  assert.deepEqual(weightOf(SEARCH, {})?.fields, [])
  assert.deepEqual(weightOf(SEARCH, { data: {} })?.fields, [])
  assert.deepEqual(weightOf(SEARCH, { data: null })?.fields, [])
})

test('an errors-only response is sized, and its weight goes to the errors, not to a field the call selected', () => {
  const token = 'tok'.repeat(700)
  const errors = Array.from({ length: 12 }, (_, i) => ({ message: '', path: ['members', String(i), 'email'], extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: token, visibility: 'requestable' } }))
  const weight = weightOf(SEARCH, { data: null, errors })
  assert.equal(weight?.bytes, bytesOf({ data: null, errors }))
  assert.equal(weight?.fields[0]?.path, 'errors.extensions.denial_context')
  assert.equal(weight?.fields[0]?.isMeta, true)
  assert.equal(weight?.fields[0]?.rows, 12)
  assert.ok((weight?.fields[0]?.share ?? 0) > 0.9)
  // A response of one short error is sized too.
  const short = weightOf(SEARCH, { errors: [{ message: 'boom' }] })
  assert.equal(short?.bytes, bytesOf({ errors: [{ message: 'boom' }] }))
})

test('errors beside heavy data are a field of their own, marked as the response\'s and never mistaken for a root', () => {
  const ir = irOf('query Q { members { email } }')
  const token = 'tok'.repeat(500)
  const errors = Array.from({ length: 10 }, () => ({ message: 'm', extensions: { denial_context: token } }))
  const weight = weightOf(ir, { data: { members: Array.from({ length: 10 }, () => ({ email: null })) }, errors })
  assert.equal(weight?.fields[0]?.isMeta, true)
  assert.ok(weight?.fields.every(field => field.isMeta === true || !field.path.startsWith('errors')))
  const own = weightOf(irOf('query Q { errors { x } }'), { data: { errors: [{ x: 'v'.repeat(500) }] } })
  assert.equal(own?.fields[0]?.path, 'errors.x')
  assert.equal(own?.fields[0]?.isMeta, undefined)
})

test('the shares of fields that do not hold one another never add to more than the whole, and are the bytes over the total', () => {
  const ir = irOf('query Q { r { a b c d e f g h } }')
  const r = Object.fromEntries('abcdefgh'.split('').map((key, i) => [key, 'x'.repeat(100 + i * 20)]))
  const weight = weightOf(ir, { data: { r } })
  assert.ok(weight !== undefined)
  assert.ok(weight.fields.reduce((sum, field) => sum + field.share, 0) <= 1)
  for (const field of weight.fields) assert.ok(Math.abs(field.share - field.bytes / weight.bytes) < 0.0001)
  assert.deepEqual(weight.fields.map(field => field.bytes), [...weight.fields.map(field => field.bytes)].sort((a, b) => b - a))
})

test(`at most ${MAX_HEAVY} fields are kept, heaviest first, equal ones in the order the response wrote them`, () => {
  const names = 'abcdefgh'.split('')
  const ir = irOf(`query Q { r { ${names.join(' ')} } }`)
  const weight = weightOf(ir, { data: { r: Object.fromEntries(names.map(key => [key, 'x'.repeat(200)])) } })
  assert.equal(weight?.fields.length, MAX_HEAVY)
  assert.deepEqual(weight?.fields.map(field => field.name), names.slice(0, MAX_HEAVY))
})

test(`fields deeper than ${MAX_DEPTH} levels are counted in the field at that level, and the total stays exact`, () => {
  let value: unknown = 'leaf'.repeat(500)
  for (let level = 0; level < MAX_DEPTH + 6; level++) value = { [`k${MAX_DEPTH + 5 - level}`]: value }
  const response = { data: { r: value } }
  const weight = weightOf(irOf('query Q { r }'), response)
  assert.equal(weight?.bytes, bytesOf(response))
  const [top] = weight?.fields ?? []
  assert.ok(top !== undefined)
  assert.ok(top.path.split('.').length <= MAX_DEPTH)
  assert.ok(top.bytes >= 2000)
})

test('an object nested past anything the stack walks is not sized, and nothing throws', () => {
  let value: unknown = 1
  for (let level = 0; level < 200_000; level++) value = [value]
  assert.equal(weightOf(SEARCH, { data: { r: value } }), undefined)
})

test(`only ${MAX_PATHS} distinct paths are tracked: a map keyed by ids leaves the total exact and the record small`, () => {
  const ids = Object.fromEntries(Array.from({ length: MAX_PATHS * 3 }, (_, i) => [`id-${i}`, { name: 'n'.repeat(40) }]))
  const response = { data: { byId: ids } }
  const weight = weightOf(irOf('query Q { byId }'), response)
  assert.equal(weight?.bytes, bytesOf(response))
  assert.equal(weight?.isCapped, true)
  assert.ok((weight?.fields.length ?? 0) <= MAX_HEAVY)
  assert.ok(JSON.stringify(weight).length < 3000)
  // Few paths: no cap.
  assert.equal(weightOf(SEARCH, { data: { r: { a: 1 } } })?.isCapped, undefined)
})

test('a key as long as a page is cut where it is kept, and the record stays small', () => {
  const key = 'k'.repeat(10_000)
  const response = { data: { r: { [key]: 'v'.repeat(500) } } }
  const weight = weightOf(irOf('query Q { r }'), response)
  assert.equal(weight?.bytes, bytesOf(response))
  const [top] = weight?.fields ?? []
  assert.ok(top !== undefined)
  assert.ok(top.path.length <= 4 * MAX_SEGMENT && top.name.length <= 4 * MAX_SEGMENT)
  assert.ok(JSON.stringify(weight).length < 2500)
  // A cut never halves a surrogate pair.
  const emoji = weightOf(irOf('query Q { r }'), { data: { r: { ['\u{1f600}'.repeat(MAX_SEGMENT)]: 'v'.repeat(500) } } })
  assert.doesNotMatch(emoji?.fields[0]?.path ?? '', /[\ud800-\udbff](?![\udc00-\udfff])/)
})

test('a key named __proto__ is a key like another: counted, and the prototype is left alone', () => {
  const response = JSON.parse('{"data":{"r":{"__proto__":{"polluted":"' + 'x'.repeat(500) + '"},"constructor":"c"}}}')
  const weight = weightOf(irOf('query Q { r }'), response)
  assert.equal(weight?.bytes, bytesOf(response))
  assert.equal(weight?.fields[0]?.path, 'r.__proto__.polluted')
  assert.equal(({} as { polluted?: string }).polluted, undefined)
})

test('what the response would weigh without a field is its bytes less the field\'s, never below nothing', () => {
  const weight = weightOf(irOf('query Q { r { a b } }'), { data: { r: { a: 'x'.repeat(600), b: 'y'.repeat(200) } } })
  assert.ok(weight !== undefined && weight.fields[0] !== undefined)
  assert.equal(bytesWithout(weight, weight.fields[0]), weight.bytes - weight.fields[0].bytes)
  assert.equal(bytesWithout({ bytes: 10, fields: [] }, { path: 'x', name: 'x', bytes: 99, share: 1 }), 0)
})

test('only a response is sized: what is not an object is left alone', () => {
  for (const value of [null, undefined, 3, 'text', [1, 2]]) assert.equal(weightOf(SEARCH, value), undefined)
})

// ---- Saying it

test('a size reads as a person writes it: bytes, then KB with one decimal under ten, whole after, then MB; a KB is 1,024 bytes', () => {
  const cases: [number, string][] = [[0, '0 B'], [1, '1 B'], [812, '812 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [4300, '4.2 KB'], [10_239, '10 KB'], [10_240, '10 KB'], [59_597, '58 KB'], [1_047_552, '1023 KB'], [1_048_500, '1 MB'], [1_468_006, '1.4 MB'], [52_428_800, '50 MB']]
  for (const [bytes, text] of cases) assert.equal(sizeText(bytes), text, String(bytes))
})

test('tokens are always about: at four bytes each, in the fewest digits that stay honest', () => {
  const cases: [number, string][] = [[0, 'about 0 tokens'], [4, 'about 1 token'], [400, 'about 100 tokens'], [3400, 'about 850 tokens'], [4000, 'about 1k tokens'], [5600, 'about 1.4k tokens'], [59_597, 'about 15k tokens'], [3_996, 'about 1k tokens'], [39_996, 'about 10k tokens'], [3_999_996, 'about 1M tokens'], [6_000_000, 'about 1.5M tokens']]
  for (const [bytes, text] of cases) assert.equal(tokensText(bytes), text, String(bytes))
  assert.equal(tokensOf(58 * 1024), 14_848)
  assert.match(tokensText(123_456), /^about /)
})

test('a share reads as a whole percent, and a trace as under one', () => {
  assert.equal(percentText(0.7694), '77%')
  assert.equal(percentText(0.5), '50%')
  assert.equal(percentText(1), '100%')
  assert.equal(percentText(0.004), '<1%')
  assert.equal(percentText(0), '0%')
})

// ---- On an outcome

test('every response that was read carries its weight, small and bounded; one that was not read carries none', () => {
  const response = { data: { jira_searchIssues: { issues: [{ key: 'DEV-1', fields: { text: 'x'.repeat(2000) } }], isLast: true } } }
  const outcome = outcomeOf(SEARCH, mcp(response))
  assert.equal(outcome.weight?.bytes, bytesOf(response))
  assert.equal(outcome.weight?.isPersisted, undefined)
  assert.ok(JSON.stringify(outcome.weight).length < 2500)
  assert.equal(outcomeOf(SEARCH, mcp({ errors: [{ message: 'boom' }] })).weight?.bytes, bytesOf({ errors: [{ message: 'boom' }] }))
  assert.equal(outcomeOf(SEARCH, { content: [{ type: 'text', text: 'Error: nope' }] }).weight, undefined)
  assert.equal(outcomeOf(SEARCH, { content: [{ type: 'text', text: '[1,2]' }] }).weight, undefined)
  const tooLarge = outcomeOf(SEARCH, '<persisted-output>\nOutput too large (58.2KB). Full output saved to: /Users/x/.claude/projects/-p/abc/tool-results/t.json\n\nPreview (first 2KB):\n...\n</persisted-output>')
  assert.equal(tooLarge.isTooLarge, true)
  assert.equal(tooLarge.weight, undefined)
  // `size` stays the stand-in's own count.
  assert.equal(tooLarge.size, 59_597)
})

test('the saved file of an oversized result, read back, is the response sized from the file and marked as one Claude only saw a preview of', () => {
  const response = { data: { jira_searchIssues: { issues: Array.from({ length: 30 }, (_, i) => ({ key: `DEV-${i}`, fields: { text: 'x'.repeat(2000) } })), isLast: true } } }
  // A saved tool result is content blocks, pretty-printed, the response text inside as a string.
  const file = JSON.stringify([{ type: 'text', text: JSON.stringify(response) }], null, 2)
  const full = outcomeOf(SEARCH, file)
  assert.equal(full.isUnreadable, undefined)
  assert.equal(full.weight?.bytes, bytesOf(response))
  assert.equal(full.weight?.isPersisted, undefined)
  const saved = savedOutcome(full)
  assert.equal(saved.weight?.isPersisted, true)
  assert.equal(saved.weight?.bytes, bytesOf(response))
  assert.equal(saved.rows[0]?.count, 30)
  // Only a response that was read has a weight to mark.
  assert.deepEqual(savedOutcome({ rows: [], errors: [], authLinks: [], isUnreadable: true }), { rows: [], errors: [], authLinks: [], isUnreadable: true })
})
