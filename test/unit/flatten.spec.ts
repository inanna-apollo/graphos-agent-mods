import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LINE_MAX,
  MAX_DEPTH,
  MAX_INPUT,
  MAX_LINES,
  MAX_REFS,
  adfLines,
  attachmentLines,
  blocksLines,
  broadcastsIn,
  broadcastsInBlocks,
  confluenceFormat,
  flatten,
  isAdf,
  mrkdwnLines,
  slackJson,
  storageLines,
  textLines,
} from '../../src/preview/flatten.ts'
import type { Flat } from '../../src/preview/flatten.ts'

const texts = (flat: Flat) => flat.lines.map(line => line.text)
const kinds = (flat: Flat) => flat.lines.map(line => line.kind)
const ESC = '\u001b'

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })
const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks !== undefined && { marks }) })

// ---- ADF

test('ADF: a paragraph a line, headings with #, a hard break splits the line', () => {
  const flat = adfLines(doc({ type: 'heading', attrs: { level: 3 }, content: [text('Goal')] }, para(text('one'), { type: 'hardBreak' }, text('two'))))
  assert.deepEqual(texts(flat), ['### Goal', 'one', 'two'])
  assert.deepEqual(kinds(flat), ['heading', 'para', 'para'])
  assert.equal(flat.total, 3)
})

test('ADF: lists take bullets and numbers, nested two cells deeper, a later paragraph of an item under its text', () => {
  const item = (...content: unknown[]) => ({ type: 'listItem', content })
  const flat = adfLines(
    doc(
      { type: 'bulletList', content: [item(para(text('a')), para(text('a, more')), { type: 'bulletList', content: [item(para(text('nested')))] }), item(para(text('b')))] },
      { type: 'orderedList', attrs: { order: 3 }, content: [item(para(text('third'))), item(para(text('fourth')))] },
    ),
  )
  assert.deepEqual(texts(flat), ['• a', '  a, more', '  • nested', '• b', '3. third', '4. fourth'])
  assert.ok(kinds(flat).slice(0, 1).every(kind => kind === 'item'))
})

test('ADF: code blocks keep their lines and are never turned into emoji; quotes, panels, rules and tables have their marks', () => {
  const flat = adfLines(
    doc(
      { type: 'codeBlock', content: [text('a :fire:\nb')] },
      { type: 'blockquote', content: [para(text('quoted'))] },
      { type: 'panel', content: [para(text('noted'))] },
      { type: 'rule' },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('k'))] }, { type: 'tableCell', content: [para(text('v'))] }] }] },
    ),
  )
  assert.deepEqual(texts(flat), ['a :fire:', 'b', '│ quoted', '▌ noted', '───', '│ k │ v │'])
  assert.deepEqual(kinds(flat), ['code', 'code', 'para', 'para', 'rule', 'row'])
})

test('ADF inline: code in backticks, a link keeps its label and its href for the card, mentions, emoji, cards, status and dates', () => {
  const flat = adfLines(
    doc(
      para(
        text('run '),
        text('gas check', [{ type: 'code' }]),
        text(' per '),
        text('the guide', [{ type: 'link', attrs: { href: 'https://example.atlassian.net/wiki/x' } }]),
        text(' '),
        { type: 'mention', attrs: { id: 'acc-1', text: '@Leo Marsh' } },
        text(' '),
        { type: 'mention', attrs: { id: 'acc-2', text: 'Sam' } },
        text(' '),
        { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
        { type: 'emoji', attrs: { shortName: ':wave:' } },
        text(' '),
        { type: 'inlineCard', attrs: { url: 'https://example.com/card' } },
        text(' '),
        { type: 'status', attrs: { text: 'in review' } },
        text(' '),
        { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 9, 7)) } },
      ),
    ),
  )
  assert.deepEqual(texts(flat), ['run `gas check` per the guide @Leo Marsh @Sam 😄👋 https://example.com/card [IN REVIEW] 2026-10-07'])
  assert.deepEqual(flat.links, ['https://example.atlassian.net/wiki/x', 'https://example.com/card'])
  assert.deepEqual(flat.mentions, ['acc-1', 'acc-2'])
})

test('ADF: a node it does not know is [type], its content walked when it has some; media is [media]', () => {
  const flat = adfLines(doc({ type: 'mysteryBlock' }, { type: 'mysteryWrapper', content: [para(text('inside'))] }, { type: 'mediaSingle', content: [{ type: 'media' }] }, para({ type: 'oddInline' })))
  assert.deepEqual(texts(flat), ['[mysteryBlock]', 'inside', '[media]', '[oddInline]'])
})

test('ADF from a JSON string is the same document; a string that is not JSON, or JSON that is no document, is shown as written', () => {
  const value = doc(para(text('hello')))
  assert.deepEqual(texts(adfLines(JSON.stringify(value))), ['hello'])
  const raw = adfLines('just words\nover two lines')
  assert.equal(raw.isRaw, true)
  assert.deepEqual(texts(raw), ['just words', 'over two lines'])
  assert.equal(adfLines({ summary: 'x' }).isRaw, true)
  assert.equal(adfLines(42).isRaw, true)
  assert.equal(isAdf(value), true)
  assert.equal(isAdf(JSON.stringify(value)), true)
  assert.equal(isAdf('{"type":"doc"}'), false)
  assert.equal(isAdf('not json'), false)
})

test('ADF: malformed nodes are skipped, never thrown on', () => {
  const weird = [null, 7, 'text', [], { content: 'not a list' }, { type: 'paragraph', content: [null, { type: 'text', text: 9 }, { type: 'text', text: 'ok' }] }, { type: 'heading', attrs: { level: 'x' }, content: [text('h')] }, { type: 'orderedList', attrs: { order: 'NaN' }, content: [null, { type: 'listItem' }] }, { type: 'table', content: [null, { type: 'tableRow', content: 'x' }] }]
  const flat = adfLines({ type: 'doc', content: weird })
  assert.ok(texts(flat).includes('ok'))
  assert.ok(texts(flat).includes('# h'))
  for (const value of [undefined, null, '', '{', '[]', '{"type":"doc","content":null}', { type: 'doc', content: [{ type: 'date', attrs: { timestamp: '1e300' } }] }]) assert.doesNotThrow(() => adfLines(value))
})

test('ADF: deep nesting stops at the depth bound and says it was cut', () => {
  let node: unknown = para(text('bottom'))
  for (let i = 0; i < 500; i++) node = { type: 'blockquote', content: [node] }
  const flat = adfLines(doc(node))
  assert.equal(flat.isCapped, true)
  assert.ok(!texts(flat).some(line => line.includes('bottom')))
})

test('ADF: a huge document keeps MAX_LINES lines and counts them all; a node bomb stops at the node bound', () => {
  const many = adfLines(doc(...Array.from({ length: MAX_LINES + 300 }, (_, i) => para(text(`line ${i}`)))))
  assert.equal(many.lines.length, MAX_LINES)
  assert.ok(many.total >= MAX_LINES)
  const wide = adfLines(doc(para(...Array.from({ length: 50_000 }, () => text('x')))))
  assert.equal(wide.isCapped, true)
})

test('ADF: control characters and bidi overrides come out as visible escapes', () => {
  const flat = adfLines(doc(para(text(`red ${ESC}[31mhere\u202eevil`))))
  const [line] = texts(flat)
  assert.ok(line !== undefined && !line.includes(ESC) && !line.includes('\u202e'))
  assert.match(line ?? '', /\\x1b\[31m/)
  assert.match(line ?? '', /\\u\{202e\}/)
})

test('a line is wrapped when drawn, never cut here: past LINE_MAX characters it is bounded', () => {
  const long = 'word '.repeat(400).trim()
  assert.equal(texts(adfLines(doc(para(text(long)))))[0], long)
  const huge = adfLines(doc(para(text('y'.repeat(LINE_MAX * 2)))))
  assert.ok((huge.lines[0]?.text.length ?? 0) <= LINE_MAX + 1)
})

// ---- Confluence storage

const RUNBOOK = '<h2>Escalation</h2><p>Page the <strong>primary</strong> on-call.</p><ul><li><p>one</p><ul><li>nested</li></ul></li><li>two</li></ul><ol><li>first</li><li>second</li></ol>'

test('storage: block elements start lines, headings take #, list items bullets and numbers by depth, inline tags only their text', () => {
  assert.deepEqual(texts(storageLines(RUNBOOK)), ['## Escalation', 'Page the primary on-call.', '• one', '  • nested', '• two', '1. first', '2. second'])
})

test('storage: page links, users, images, emoticons, times and tasks read as words', () => {
  const flat = storageLines(
    [
      '<p>See <ac:link><ri:page ri:content-title="On-call runbook"/></ac:link> and <ac:link><ri:page ri:content-title="X"/><ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>.</p>',
      '<p>Ask <ac:link><ri:user ri:account-id="acc-9"/></ac:link> by <time datetime="2026-10-09"/> <ac:emoticon ac:name="smile"/></p>',
      '<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>',
      '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>ship</ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>tell</ac:task-body></ac:task></ac:task-list>',
      '<p><a href="https://example.com/a">a link</a></p>',
    ].join(''),
  )
  assert.deepEqual(texts(flat), ['See [On-call runbook] and the guide.', 'Ask @user by 2026-10-09 😄', '[image: diagram.png]', '☑ ship', '☐ tell', 'a link'])
  assert.deepEqual(flat.mentions, ['acc-9'])
  assert.deepEqual(flat.links, ['https://example.com/a'])
})

test('storage: a code or noformat macro is its CDATA as code lines, its parameters silent; any other macro is named before its body', () => {
  const flat = storageLines('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const a = 1\nrun()]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="info"><ac:parameter ac:name="title">T</ac:parameter><ac:rich-text-body><p>Heads up</p></ac:rich-text-body></ac:structured-macro>')
  assert.deepEqual(texts(flat), ['const a = 1', 'run()', '[macro: info]', 'Heads up'])
  assert.deepEqual(kinds(flat).slice(0, 2), ['code', 'code'])
})

test('storage: a table row is one line of cells; entities are decoded and then escaped', () => {
  const flat = storageLines(`<table><tbody><tr><th>Team</th><th>Channel</th></tr><tr><td>DB &amp; ops</td><td>&lt;#db&gt; &#27;[31m</td></tr></tbody></table>`)
  assert.equal(texts(flat)[0], '│ Team │ Channel │')
  assert.match(texts(flat)[1] ?? '', /^│ DB & ops │ <#db> \\x1b\[31m │$/)
  assert.ok(!texts(flat).join('').includes(ESC))
})

test('storage: malformed markup degrades, never throws: unclosed tags, stray brackets, an unterminated CDATA or comment', () => {
  for (const value of ['<p>open', '<ul><li>one<li>two', 'a < b > c', '<p>x</p><![CDATA[never closed', '<!-- never closed <p>x</p>', '<a href="unclosed>text', '</p></li></ul>', '<ac:structured-macro ac:name="code">', ''.padEnd(10, '<')]) {
    assert.doesNotThrow(() => storageLines(value))
  }
  assert.deepEqual(texts(storageLines('<ul><li>one<li>two')), ['• one', '• two'])
  assert.deepEqual(texts(storageLines('a < b > c')), ['a < b > c'])
})

test('storage: input past MAX_INPUT is cut there and says so; a value that is not a string is shown as JSON', () => {
  const big = storageLines(`<p>${'x '.repeat(MAX_INPUT)}</p>`)
  assert.equal(big.isCapped, true)
  assert.deepEqual(texts(storageLines({ a: 1 })), ['{"a":1}'])
})

/** Milliseconds `run` takes, the better of two runs: a pause in one (a collection, a busy machine) is not the code's. */
function timed(run: () => unknown): number {
  let best = Infinity
  for (let i = 0; i < 2; i++) {
    const start = performance.now()
    run()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

/**
 * The bound is loose on purpose: at the full input size a linear scan takes
 * milliseconds and a quadratic one seconds (each of these took 2 to 40 s
 * before), so only real quadratic behaviour fails it, never a loaded machine.
 */
const QUADRATIC_MS = 2_000

// Input the model writes can be shaped to make a backtracking scan quadratic; each of these used to take seconds (the pane froze on them).
test('flattening stays linear on input shaped to make a scan quadratic: long space runs, unclosed tags, deep nesting, unclosed broadcasts', () => {
  const near = (unit: string) => unit.repeat(Math.floor(MAX_INPUT / unit.length))
  const cases: [string, () => unknown][] = [
    ['a long space run inside a line', () => textLines(`a${' '.repeat(MAX_INPUT - 2)}b`)],
    ['trailing tabs and carriage returns', () => textLines(`a${' \t\r'.repeat(80_000)}b`)],
    ['tags that never close', () => storageLines(near('<a '))],
    ['unclosed quotes in tags', () => storageLines(near('<a href="'))],
    ['unclosed single quotes in tags', () => storageLines(near("<a href='"))],
    ['one tag that never closes', () => storageLines(`<a${' x'.repeat(MAX_INPUT / 2 - 2)}`)],
    ['lists nested without end', () => storageLines(near('<ul><li>x'))],
    ['tables nested without end', () => storageLines(near('<table><tr><td>x'))],
    ['lists opened and never closed', () => storageLines(`${near('<ul>')}<li>x`)],
    ['broadcasts whose label never closes', () => broadcastsIn(near('<!channel|'))],
    ['mrkdwn broadcasts whose label never closes', () => mrkdwnLines(near('<!channel|'))],
  ]
  for (const [name, run] of cases) {
    const ms = timed(run)
    assert.ok(ms < QUADRATIC_MS, `${name}: ${Math.round(ms)} ms`)
  }
})

test('storage: lists and rows nest at most MAX_DEPTH deep, so an item is indented at most that far, and the cut is said', () => {
  const flat = storageLines('<ul><li>x'.repeat(MAX_DEPTH * 3))
  assert.equal(flat.isCapped, true)
  const widest = Math.max(...texts(flat).map(line => line.length))
  assert.ok(widest <= 2 * MAX_DEPTH + 4, `widest line ${widest}`)
  // Closes past the cap are matched with their opens: the list after them is a top-level list again.
  const balanced = storageLines(`${'<ul><li>x'.repeat(MAX_DEPTH + 10)}${'</li></ul>'.repeat(MAX_DEPTH + 10)}<ul><li>top</li></ul>`)
  assert.equal(texts(balanced).at(-1), '• top')
  assert.equal(storageLines('<ul><li>one<ul><li>two</li></ul></li></ul>').isCapped, false)
})

test('storage: a tag still reads with quoted attributes that hold > and quotes of the other kind; a raw < in one ends it as text', () => {
  assert.deepEqual(texts(storageLines('<p class="a>b" title=\'say "hi"\'>x</p>')), ['x'])
  assert.deepEqual(texts(storageLines('<p>a <b c="<">d</p>')), ['a <b c="<">d'])
})

test('a trailing run of spaces, tabs and carriage returns is trimmed from a line; inner runs stay', () => {
  assert.deepEqual(texts(textLines('a  b \t\r\nc')), ['a  b', 'c'])
  assert.deepEqual(texts(textLines('   ')), [''])
})

test('storage: many paragraphs keep MAX_LINES lines, every one counted', () => {
  const flat = storageLines('<p>x</p>'.repeat(MAX_LINES + 50))
  assert.equal(flat.lines.length, MAX_LINES)
  assert.equal(flat.total, MAX_LINES + 50)
})

// ---- Slack mrkdwn, blocks, attachments

test('mrkdwn: users, channels, links and broadcasts as words, entities decoded, emoji drawn, a line per newline', () => {
  const flat = mrkdwnLines('<!channel> hi <@U02ABC123> and <@U9|sam> in <#C01|ops> and <#C02>\n• see <https://example.com/x|the doc> or <https://example.com/y>\na &amp; b &lt;tag&gt; :rocket: <!subteam^S1|@platform> <!date^1700000000^{date}|Nov 14>')
  assert.deepEqual(texts(flat), ['@channel hi @U02ABC123 and @sam in #ops and #C02', '• see the doc ↗ or https://example.com/y', 'a & b <tag> 🚀 @platform Nov 14'])
  assert.deepEqual(kinds(flat), ['para', 'item', 'para'])
  assert.deepEqual(flat.links, ['https://example.com/x', 'https://example.com/y'])
  assert.deepEqual(flat.mentions, ['U02ABC123', 'U9', 'C01', 'C02'])
})

test('mrkdwn: a fenced block is code, its emoji left as written; *bold* _it_ ~s~ stay as written; a quote is a quote', () => {
  const flat = mrkdwnLines('*bold* _it_ ~s~\n```\nrun :fire:\n```\n> quoted')
  assert.deepEqual(texts(flat), ['*bold* _it_ ~s~', 'run :fire:', '> quoted'])
  assert.deepEqual(kinds(flat), ['para', 'code', 'quote'])
  assert.deepEqual(texts(mrkdwnLines('before ```inline code``` after')), ['before', 'inline code', 'after'])
})

test('mrkdwn: an entity that decodes to markup is shown, not parsed; control characters are escaped', () => {
  const flat = mrkdwnLines(`&lt;!channel&gt; ${ESC}[2J`)
  assert.equal(texts(flat)[0], '<!channel> \\x1b[2J')
})

test('broadcasts: <!channel>, <!here> and <!everyone>, with or without a label, each once; nothing else', () => {
  assert.deepEqual(broadcastsIn('hi <!here|here> and <!channel> and <!channel> and <!everyone>'), ['here', 'channel', 'everyone'])
  assert.deepEqual(broadcastsIn('@channel <!subteam^S1> &lt;!here&gt;'), [])
  assert.deepEqual(broadcastsIn(undefined), [])
  const blocks = JSON.stringify([{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'broadcast', range: 'here' }] }] }, { type: 'section', text: { type: 'mrkdwn', text: '<!channel> go' } }])
  assert.deepEqual(broadcastsInBlocks(encodeURIComponent(blocks)).sort(), ['channel', 'here'])
  assert.deepEqual(broadcastsInBlocks('not json'), [])
})

test('blocks: URL-encoded JSON or plain JSON; sections, headers, context, dividers, images, actions and rich text; any other block named', () => {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Release 2.4' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Ship it <!here>' }, fields: [{ type: 'mrkdwn', text: '*Owner* Leo' }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'by <@U1>' }, { type: 'image', alt_text: 'logo' }] },
    { type: 'divider' },
    { type: 'image', alt_text: 'chart' },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Approve' } }] },
    { type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'ordered', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'one ' }, { type: 'link', url: 'https://example.com', text: 'docs' }] }] }, { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'a\nb' }] }, { type: 'rich_text_quote', elements: [{ type: 'user', user_id: 'U2' }] }] },
    { type: 'video' },
  ]
  const expected = ['# Release 2.4', 'Ship it @here', '*Owner* Leo', 'by @U1 [image: logo]', '───', '[image: chart]', '[button: Approve]', '1. one docs ↗', 'a', 'b', '│ @U2', '[block: video]']
  assert.deepEqual(texts(blocksLines(encodeURIComponent(JSON.stringify(blocks)))), expected)
  assert.deepEqual(texts(blocksLines(JSON.stringify(blocks))), expected)
  assert.deepEqual(texts(blocksLines(blocks)), expected)
})

test('blocks and attachments that do not parse are shown as written; slackJson takes a list, an object, JSON and URL-encoded JSON', () => {
  assert.equal(blocksLines('%%%not').isRaw, true)
  assert.equal(attachmentLines('nope').isRaw, true)
  assert.deepEqual(slackJson('[1]'), [1])
  assert.deepEqual(slackJson('{"blocks":[{"type":"divider"}]}'), [{ type: 'divider' }])
  assert.deepEqual(slackJson({ type: 'divider' }), [{ type: 'divider' }])
  assert.equal(slackJson('%E0%A4%A'), undefined)
})

test('attachments: pretext, title, text and fields, through mrkdwn', () => {
  const flat = attachmentLines(JSON.stringify([{ pretext: 'Deploy', title: 'v2.4', text: 'by <@U1>', fields: [{ title: 'Env', value: 'prod' }] }, { fallback: 'old style' }]))
  assert.deepEqual(texts(flat), ['Deploy', 'v2.4', 'by @U1', 'Env: prod', 'old style'])
})

test('refs are bounded: at most MAX_REFS links and mentions are kept', () => {
  const flat = mrkdwnLines(Array.from({ length: 60 }, (_, i) => `<https://example.com/${i}|l${i}> <@U${i}>`).join(' '))
  assert.equal(flat.links.length, MAX_REFS)
  assert.equal(flat.mentions.length, MAX_REFS)
})

// ---- Formats and the never-throw sweep

test('a Confluence representation names its format; flatten dispatches on it', () => {
  assert.equal(confluenceFormat('storage'), 'storage')
  assert.equal(confluenceFormat('ATLAS_DOC_FORMAT'), 'adf')
  assert.equal(confluenceFormat('wiki'), 'wiki')
  assert.equal(confluenceFormat(undefined), 'text')
  assert.deepEqual(texts(flatten('h1. Title\nbody', 'wiki')), ['h1. Title', 'body'])
  assert.deepEqual(texts(flatten('<p>x</p>', 'storage')), ['x'])
  assert.deepEqual(texts(textLines('a\n\nb')), ['a', '', 'b'])
})

test('no flattener throws, whatever it is handed', () => {
  const values: unknown[] = [undefined, null, true, 0, -1, NaN, '', ' ', '\u0000', '{"a":', '[[[[', {}, [], [null], { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: { not: 'a string' } }] }] }, Symbol.iterator, () => 1, new Proxy({}, { get: () => { throw new Error('boom') } })]
  for (const value of values) {
    for (const format of ['adf', 'storage', 'wiki', 'mrkdwn', 'blocks', 'attachments', 'text'] as const) {
      assert.doesNotThrow(() => flatten(value, format), `${format} on ${String(typeof value)}`)
    }
    assert.doesNotThrow(() => broadcastsIn(value))
    assert.doesNotThrow(() => broadcastsInBlocks(value))
  }
})
