import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeText } from '../../src/escape.ts'
import { renderCql } from '../../src/format/cql.ts'
import { renderDate } from '../../src/format/date.ts'
import { chunk, chunkRanges, full, renderFallback } from '../../src/format/fallback.ts'
import { renderArg } from '../../src/format/index.ts'
import { renderId } from '../../src/format/id.ts'
import { renderJql } from '../../src/format/jql.ts'
import { pickRenderer } from '../../src/format/pick.ts'
import { renderSlack } from '../../src/format/slack.ts'
import { renderUrl } from '../../src/format/url.ts'
import type { Rendered, Segment } from '../../src/format/types.ts'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const all = (r: Rendered): Segment[] => r.lines.flat()
const text = (r: Rendered) => all(r).map(s => s.text).join('')
const strip = (s: string) => s.replace(/\s+/g, '')
const tones = (r: Rendered, tone: string) => all(r).filter(s => s.tone === tone).map(s => s.text.trim())
// Round-trip property: nothing dropped, added or reordered (whitespace aside).
const assertRoundTrip = (r: Rendered, input: string) => assert.equal(strip(text(r)), strip(escapeText(input).text), input)
const arg = (name: string, value: unknown, extra: { type?: string } = {}) => ({ name, value, ...extra })

describe('pickRenderer', () => {
  it('chooses by name and type', () => {
    assert.equal(pickRenderer(arg('cql', 'x'), 'confluence_search'), 'cql')
    assert.equal(pickRenderer(arg('jql', 'x'), 'jira_search'), 'jql')
    assert.equal(pickRenderer(arg('query', 'x'), 'slack_search'), 'slack')
    assert.equal(pickRenderer(arg('query', 'x'), 'confluence_search'), undefined)
    assert.equal(pickRenderer(arg('thing', 'x', { type: 'ID!' }), 'f'), 'id')
    assert.equal(pickRenderer(arg('thing', 'x', { type: 'ID' }), 'f'), 'id')
    assert.equal(pickRenderer(arg('issueId', 'x'), 'f'), 'id')
    assert.equal(pickRenderer(arg('pageID', 'x'), 'f'), 'id')
    assert.equal(pickRenderer(arg('key', 'ENG-12'), 'f'), 'id')
    assert.equal(pickRenderer(arg('id', 'ENG-12'), 'f'), 'id')
    assert.equal(pickRenderer(arg('key', 'hello'), 'f'), undefined)
    assert.equal(pickRenderer(arg('link', 'https://example.com/a'), 'f'), 'url')
    assert.equal(pickRenderer(arg('since', '2026-01-02'), 'f'), 'date')
    assert.equal(pickRenderer(arg('since', '2026-01-02T03:04:05Z'), 'f'), 'date')
    assert.equal(pickRenderer(arg('since', '2026-02-30'), 'f'), undefined)
    assert.equal(pickRenderer(arg('n', 5), 'f'), undefined)
  })
  it('applies precedence cql > jql > slack > id > url > date', () => {
    assert.equal(pickRenderer(arg('cql', 'https://a.com', { type: 'ID' }), 'slack_x'), 'cql')
    assert.equal(pickRenderer(arg('query', 'https://a.com', { type: 'ID' }), 'slack_x'), 'slack')
    assert.equal(pickRenderer(arg('pageId', 'https://a.com'), 'f'), 'id')
    assert.equal(pickRenderer(arg('x', 'https://a.com/2026-01-01'), 'f'), 'url')
    assert.equal(pickRenderer(arg('createdId', '2026-01-01'), 'f'), 'id')
  })
  it('ignores javascript: URLs', () => {
    assert.equal(pickRenderer(arg('link', 'javascript:alert(1)'), 'f'), undefined)
  })
})

describe('cql and jql', () => {
  it('splits clauses and tones field, operator, value', () => {
    const r = renderCql('type=page AND text ~ "query plan" ORDER BY lastmodified DESC')
    assert.equal(r.isFallback, false)
    assert.equal(r.lines.length, 3)
    assert.deepEqual(tones(r, 'key'), ['type', 'text'])
    assert.ok(tones(r, 'op').includes('=') && tones(r, 'op').includes('~') && tones(r, 'op').includes('AND') && tones(r, 'op').includes('ORDER BY'))
    assert.deepEqual(tones(r, 'value'), ['page', '"query plan"', 'lastmodified DESC'])
  })
  it('handles keyword operators and lower-case connectors', () => {
    const r = renderJql('project in (A, B) and status not in (Done) or assignee is not EMPTY and status was "Open" order by created')
    assert.equal(r.isFallback, false)
    for (const op of ['in', 'not in', 'is not', 'was']) assert.ok(tones(r, 'op').includes(op), op)
    assert.equal(r.lines.length, 5)
    assertRoundTrip(r, 'project in (A, B) and status not in (Done) or assignee is not EMPTY and status was "Open" order by created')
  })
  it('aligns operators with padding segments', () => {
    const r = renderCql('a = 1 AND longer ~ 2')
    const offsets = r.lines.map(l => {
      const i = l.findIndex(s => s.tone === 'op' && (s.text === '=' || s.text === '~'))
      return l.slice(0, i).map(s => s.text).join('').length
    })
    assert.equal(offsets[0], offsets[1])
  })
  it('does not split on AND inside quotes or parentheses', () => {
    const r = renderCql('title ~ "this AND that" AND (a = 1 OR b = 2)')
    assert.equal(r.lines.length, 2)
    assert.ok(text(r).includes('"this AND that"'))
    assert.ok(text(r).includes('(a = 1 OR b = 2)'))
  })
  it('keeps single quotes and escaped quotes verbatim', () => {
    const r = renderJql(`summary ~ 'it\\'s  here' AND text ~ "a \\" b"`)
    assert.equal(r.isFallback, false)
    assert.ok(text(r).includes(`'it\\'s  here'`))
    assert.ok(text(r).includes('"a \\" b"'))
  })
  it('falls back on unbalanced quotes or parens', () => {
    for (const bad of ['text ~ "abc', 'a = (1', 'a = 1)', "x = 'y", 'a ~ "x\ny"']) {
      const r = renderCql(bad)
      assert.equal(r.isFallback, true, bad)
      assert.equal(r.lines.map(l => l.map(s => s.text).join('')).join('\n'), escapeText(bad).text)
    }
  })
  it('shows a JQL injection attempt exactly as sent', () => {
    // The quotes here happen to balance, so the injected OR stays inside a string
    // and must not become its own clause; the text is shown exactly as written.
    const balanced = 'project = X" OR "1"="1'
    const r = renderJql(balanced)
    assert.equal(r.lines.length, 1)
    assert.equal(strip(text(r)), strip(balanced))
    assert.ok(text(r).includes('" OR "'))
    // With an odd number of quotes the parse fails and the plain text is shown.
    for (const odd of ['project = X" OR "1"="1"', 'project = "X" OR "1', `project = X' OR 1=1 --'x'"`]) {
      const f = renderJql(odd)
      assert.equal(f.isFallback, true, odd)
      assert.equal(text(f), odd)
    }
  })
  it('falls back for non-strings and empty input', () => {
    assert.equal(renderCql(42).isFallback, true)
    assert.equal(renderCql('   ').isFallback, true)
    assert.equal(renderJql({ a: 1 }).isFallback, true)
  })
  it('escapes ANSI and bidi characters', () => {
    const input = 'title ~ "\x1b[31mred\x1b[0m" AND text ~ "‮evil​"'
    const r = renderCql(input)
    const out = text(r)
    assert.ok(!out.includes('\x1b'))
    assert.ok(!/[‮​]/.test(out))
    assert.ok(out.includes('\\x1b') && out.includes('\\u{202e}'))
    assertRoundTrip(r, input)
  })
  it('renders long valid CQL structurally or marks the fallback as truncated', () => {
    const mid = Array.from({ length: 300 }, (_, i) => `field${i} = "value ${i}"`).join(' AND ')
    const r = renderCql(mid)
    assert.equal(r.isFallback, false)
    assert.equal(r.lines.length, 300)
    assertRoundTrip(r, mid)
    const huge = `text ~ "${'x'.repeat(10_000)}"`
    const h = renderCql(huge)
    assert.equal(h.isFallback, true)
    assert.equal(h.isTruncated, true)
    assert.ok(h.lines.length <= 2)
  })
  it('round-trips over many inputs', () => {
    const pieces = [
      'type=page', 'type = page', 'text ~ "a b"', "title != 'x y'", 'a>=1', 'b <= 2', 'c !~ "q"', 'd IN (1,2,3)',
      'e NOT IN ("x", "y")', 'f IS EMPTY', 'g IS NOT NULL', 'h WAS "Open"', 'i CHANGED', '(a = 1 OR b = 2)',
      'created > startOfDay("-7d")', 'assignee = currentUser()', 'label = "x AND y"', 'text ~ "ORDER BY"',
      'ancestor = 123', 'x = "‮"', 'y = "\x1b[2J"', 'z​ = 1', 'bare words here', '  spaced   out  =  1 ',
    ]
    const joiners = [' AND ', ' OR ', '  and  ', '\nOR\n', ' AND  ']
    const tails = ['', ' ORDER BY created DESC', ' order by a asc, b desc']
    let seed = 7
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n)
    let count = 0
    for (let i = 0; i < 400; i++) {
      const n = 1 + rnd(5)
      let input = ''
      for (let j = 0; j < n; j++) input += (j ? joiners[rnd(joiners.length)] : '') + pieces[rnd(pieces.length)]
      input += tails[rnd(tails.length)]
      for (const render of [renderCql, renderJql]) {
        const r = render(input)
        assertRoundTrip(r, input)
        for (const line of r.lines) for (const s of line) assert.ok(!s.text.includes('\n'))
        count++
      }
    }
    assert.equal(count, 800)
  })
  it('keeps quoted literals verbatim in the output', () => {
    const r = renderCql('a = "x   AND   y" AND b = \'p  q\'')
    assert.ok(text(r).includes('"x   AND   y"'))
    assert.ok(text(r).includes("'p  q'"))
  })
})

describe('slack', () => {
  it('puts modifiers on their own lines and groups free text', () => {
    const r = renderSlack('deploy failed in:#ops from:@bob after:2026-01-01 has:link')
    assert.equal(r.isFallback, false)
    assert.deepEqual(tones(r, 'key'), ['in:', 'from:', 'after:', 'has:'])
    assert.deepEqual(tones(r, 'value'), ['deploy failed', '#ops', '@bob', '2026-01-01', 'link'])
    assert.equal(r.lines.length, 5)
  })
  it('keeps order and quoted values', () => {
    const input = 'a in:#x "b c" from:"john smith" d is:thread'
    const r = renderSlack(input)
    assertRoundTrip(r, input)
    assert.ok(text(r).includes('from:"john smith"'))
    assert.ok(text(r).includes('"b c"'))
  })
  it('falls back on unbalanced quotes and non-strings', () => {
    assert.equal(renderSlack('a "b').isFallback, true)
    assert.equal(renderSlack(3).isFallback, true)
    assert.equal(renderSlack('   ').isFallback, true)
  })
  it('escapes control characters and round-trips', () => {
    const input = 'x \x1b[31mred in:#a‮'
    const r = renderSlack(input)
    assert.ok(!text(r).includes('\x1b') && !text(r).includes('‮'))
    assertRoundTrip(r, input)
  })
  it('round-trips over many inputs', () => {
    const bits = ['foo', 'in:#general', 'from:@a', '"two words"', 'to:me', 'before:2026-01-01', 'on:today', 'during:march', 'is:saved', '-in:#x', 'IN:#y', 'in:']
    let seed = 3
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n)
    for (let i = 0; i < 300; i++) {
      const input = Array.from({ length: 1 + rnd(8) }, () => bits[rnd(bits.length)]).join(rnd(2) ? ' ' : '  ')
      assertRoundTrip(renderSlack(input), input)
    }
  })
})

describe('id', () => {
  it('shows the value emphasized on one line', () => {
    const r = renderId('ENG-123')
    assert.deepEqual(r.lines, [[{ text: 'ENG-123', tone: 'emph' }]])
    assert.equal(renderId(42).isFallback, false)
  })
  it('falls back for objects and multi-line values, and escapes', () => {
    assert.equal(renderId({ a: 1 }).isFallback, true)
    assert.equal(renderId('a\nb').isFallback, true)
    assert.equal(text(renderId('A\x1b[31m')), 'A\\x1b[31m')
  })
})

describe('url', () => {
  it('tones scheme, host and the rest, and round-trips exactly', () => {
    const input = 'https://example.com:8443/a/b?q=1#frag'
    const r = renderUrl(input)
    assert.equal(r.isFallback, false)
    assert.equal(text(r), input)
    assert.deepEqual(tones(r, 'emph'), ['example.com'])
    assert.ok(all(r).filter(s => s.tone === 'dim').map(s => s.text).join('').includes('/a/b?q=1#frag'))
    assert.equal(r.lines.length, 1)
  })
  it('flags userinfo as warn', () => {
    const input = 'https://trusted.com@evil.example/login'
    const r = renderUrl(input)
    assert.equal(text(r), input)
    assert.deepEqual(tones(r, 'warn'), ['trusted.com@'])
    assert.deepEqual(tones(r, 'emph'), ['evil.example'])
    const r2 = renderUrl('http://user:pass@host.test/')
    assert.deepEqual(tones(r2, 'warn'), ['user:pass@'])
  })
  it('flags IDN and punycode hosts with a second line', () => {
    const cyr = 'https://аpple.com/id'
    const r = renderUrl(cyr)
    assert.equal(r.lines.length, 2)
    assert.ok(r.lines[0]?.map(s => s.text).join('').startsWith('https://аpple.com'))
    assert.equal(r.lines[1]?.[0]?.tone, 'warn')
    assert.ok(r.lines[1]?.[0]?.text.startsWith('internationalized host: xn--'))
    const px = renderUrl('http://xn--80ak6aa92e.com/')
    assert.equal(px.lines.length, 2)
    assert.ok(px.lines[1]?.[0]?.text.includes('xn--80ak6aa92e.com'))
  })
  it('falls back for non-http(s) and unparseable input', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://a.com', 'not a url', 'https://', '']) {
      assert.equal(renderUrl(bad).isFallback, true, bad)
    }
    assert.equal(renderUrl(5).isFallback, true)
  })
  it('falls back when parsers could disagree about the host', () => {
    for (const bad of ['https://evil.com\\@good.com/', 'https://good.com\t.evil.com/', 'https://exa%6dple.com/', 'http://0x7f.1/', ' https://a.com', 'https://a.com/\x1b[31m']) {
      const r = renderUrl(bad)
      assert.equal(r.isFallback, true, JSON.stringify(bad))
      assert.ok(!text(r).includes('\x1b') && !text(r).includes('\t'))
    }
  })
})

describe('date', () => {
  it('shows the original and a relative description', () => {
    const r = renderDate('2026-10-08T12:00:00Z', NOW)
    assert.equal(r.lines[0]?.[0]?.text, '2026-10-08T12:00:00Z')
    assert.equal(r.lines[1]?.[0]?.tone, 'dim')
    assert.equal(r.lines[1]?.[0]?.text, 'in 3 days')
    assert.equal(renderDate('2026-10-05T10:00:00Z', NOW).lines[1]?.[0]?.text, '2 hours ago')
    assert.equal(renderDate('2026-10-05T12:00:20+00:00', NOW).lines[1]?.[0]?.text, 'just now')
    assert.equal(renderDate('2026-10-05', NOW).lines[1]?.[0]?.text, '12 hours ago')
    assert.equal(renderDate('2026-10-05T14:00:00+02:00', NOW).lines[1]?.[0]?.text, 'just now')
    assert.equal(renderDate('2025-10-05T12:00:00Z', NOW).lines[1]?.[0]?.text, '1 year ago')
  })
  it('notes a missing timezone', () => {
    assert.ok(renderDate('2026-10-05T12:00:00', NOW).lines[1]?.[0]?.text.includes('UTC'))
  })
  it('falls back on invalid input', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '2026-10-05T25:00:00Z', '', '2026-10-05\x1b[31m']) {
      assert.equal(renderDate(bad, NOW).isFallback, true, bad)
    }
    assert.equal(renderDate('2026-10-05', Number.NaN).isFallback, true)
  })
  it('uses the passed clock only', () => {
    assert.equal(renderDate('2026-10-05T12:00:00Z', Date.parse('2026-10-05T12:00:00Z') + 5 * 60_000).lines[1]?.[0]?.text, '5 minutes ago')
  })
})

describe('fallback', () => {
  it('shows strings as-is and others as JSON', () => {
    assert.equal(text(renderFallback('hello')), 'hello')
    assert.equal(text(renderFallback({ a: [1, 'x'] })), '{"a":[1,"x"]}')
    assert.equal(text(renderFallback(undefined)), 'undefined')
    assert.equal(renderFallback('x').isFallback, true)
    assert.equal(renderFallback('x').isTruncated, false)
  })
  it('survives unserializable values', () => {
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    assert.equal(renderFallback(loop).isFallback, true)
    assert.ok(text(renderFallback(10n)).includes('10'))
  })
  it('keeps the compact form to two pieces and counts the rest, never ending in …', () => {
    // One source line: its two pieces are one drawn line (the surface wraps it), the rest counted.
    const r = renderFallback('y'.repeat(1000))
    assert.equal(r.lines.length, 1)
    assert.equal(text(r), 'y'.repeat(280))
    assert.equal(r.more, 6)
    assert.equal(r.isTruncated, true)
    // Lines of their own stay lines; past two, they are counted.
    const multi = renderFallback('a\nb\nc\nd')
    assert.equal(multi.lines.length, 2)
    assert.equal(multi.more, 2)
    assert.equal(multi.isTruncated, true)
    for (const one of [r, multi, renderFallback(`${'word '.repeat(200)}end`)]) assert.ok(!one.lines.flat().some(s => s.text.includes('…')))
    // Nothing left out: no count.
    assert.equal(renderFallback('short').more, undefined)
  })
  it('breaks a long line at the last space at or before the width, so the shown text ends on a whole word', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const shown = text(renderFallback(words))
    assert.ok(words.startsWith(shown))
    assert.ok(shown.length <= 280)
    // The next character is the space it broke at: no word is cut.
    assert.equal(words.charAt(shown.length), ' ')
    assert.equal(renderFallback(words).more, chunk(words, 140).length - 2)
  })
  it('chunks at spaces, cuts hard only inside a run with no space, and never splits a surrogate pair', () => {
    assert.deepEqual(chunk('aaa bbb ccc', 7), ['aaa bbb', 'ccc'])
    // A space exactly at the width ends the piece there.
    assert.deepEqual(chunk('aaaa bbbb', 4), ['aaaa', 'bbbb'])
    // A word longer than the width is cut hard, and only it.
    assert.deepEqual(chunk('a bbbbbbbbbb c', 4), ['a', 'bbbb', 'bbbb', 'bb c'])
    assert.deepEqual(chunk('x'.repeat(10), 4), ['xxxx', 'xxxx', 'xx'])
    // Runs of spaces at a break are passed over.
    assert.deepEqual(chunk('ab    cd', 3), ['ab', 'cd'])
    // A pair is kept whole, even at a width of one.
    const smile = '\u{1F600}'
    for (const width of [1, 2, 3]) for (const piece of chunk(`${smile}${smile}a${smile}`, width)) assert.ok(!/[\ud800-\udbff]$/.test(piece) && !/^[\udc00-\udfff]/.test(piece), `${width}: ${JSON.stringify(piece)}`)
    assert.deepEqual(chunk('', 5), [''])
  })
  it('chunk loses nothing but the spaces it breaks at, and holds every piece to the width (property)', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const alphabet = ['a', 'b', ' ', ' ', 'é', '\u{1F600}', '-']
    for (let n = 0; n < 500; n++) {
      const line = Array.from({ length: Math.floor(rnd() * 60) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
      const width = 1 + Math.floor(rnd() * 12)
      const ranges = chunkRanges(line, width)
      let at = 0
      for (const [start, end] of ranges) {
        // Between pieces only spaces are dropped.
        assert.ok(/^ *$/.test(line.slice(at, start)), JSON.stringify({ line, width }))
        assert.ok(end - start <= Math.max(width, 2), JSON.stringify({ line, width, start, end }))
        // A piece cut hard (not at a space) had no space to break at within the width.
        if (end < line.length && line.charAt(end) !== ' ') assert.ok(!line.slice(start, end).includes(' '), JSON.stringify({ line, width, start, end }))
        at = end
      }
      assert.equal(at, line.length)
    }
  })
  it('full() keeps everything under the escape cap', () => {
    const input = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const r = full(input)
    assert.equal(r.lines.length, 50)
    assert.equal(r.isTruncated, false)
    assert.equal(full('z'.repeat(20_000)).isTruncated, true)
  })
  it('escapes control and bidi characters', () => {
    const input = '\x1b[31mred\x1b[0m ‮⁦ \x07 \x00'
    for (const r of [renderFallback(input), full(input)]) {
      assert.ok(!/[\x00-\x08\x1b‮⁦]/.test(text(r)))
      assert.equal(text(r), escapeText(input).text)
    }
  })
})

describe('renderArg', () => {
  const mk = (name: string, value: unknown, extra: Record<string, unknown> = {}) => ({ name, value, fromVariable: false, ...extra }) as Parameters<typeof renderArg>[0]
  it('dispatches by picked renderer', () => {
    assert.equal(renderArg(mk('cql', 'type = page AND a = 1'), 'confluence_search', NOW).lines.length, 2)
    assert.deepEqual(tones(renderArg(mk('issueId', 'A-1'), 'f', NOW), 'emph'), ['A-1'])
    assert.deepEqual(tones(renderArg(mk('u', 'https://a.com/x'), 'f', NOW), 'emph'), ['a.com'])
    assert.equal(renderArg(mk('d', '2026-10-06T12:00:00Z'), 'f', NOW).lines[1]?.[0]?.text, 'in 1 day')
    assert.deepEqual(tones(renderArg(mk('query', 'x in:#a'), 'slack_search', NOW), 'key'), ['in:'])
    assert.equal(renderArg(mk('n', 5), 'f', NOW).isFallback, true)
  })
  it('prefers an explicit renderer over picking', () => {
    const r = renderArg(mk('whatever', 'a = 1 AND b = 2', { renderer: 'jql' }), 'f', NOW)
    assert.equal(r.isFallback, false)
    assert.equal(r.lines.length, 2)
  })
  it('falls back when the explicit renderer cannot parse the value', () => {
    assert.equal(renderArg(mk('x', { a: 1 }, { renderer: 'url' }), 'f', NOW).isFallback, true)
    assert.equal(renderArg(mk('x', 7, { renderer: 'date' }), 'f', NOW).isFallback, true)
  })
  it('catches exceptions into the fallback', () => {
    const hostile = { get value(): unknown { throw new Error('boom') }, name: 'x', fromVariable: false } as unknown as Parameters<typeof renderArg>[0]
    assert.equal(renderArg(hostile, 'f', NOW).isFallback, true)
    const toxic = { toJSON() { throw new Error('no') }, toString() { throw new Error('no') } }
    assert.equal(renderArg(mk('x', toxic), 'f', NOW).isFallback, true)
  })
  it('does not let model-written text pick the renderer', () => {
    const r = renderArg(mk('note', 'cql: type = page AND a = 1'), 'f', NOW)
    assert.equal(r.isFallback, true)
  })
})

describe('structured object and list arguments', () => {
  const text = (value: unknown) => renderArg({ name: 'facetFilters', value, fromVariable: true } as never, 'glean_search', 0)
  const lines = (value: unknown) => text(value).lines.map(line => line.map(segment => segment.text).join(''))

  it('draws a list of objects whose values are scalar lists as key/value rows', () => {
    const filters = [{ fieldName: 'type', values: [{ value: 'page' }, { value: 'document' }] }]
    assert.deepEqual(lines(filters), ['fieldName type', 'values page · document'])
  })

  it('joins a list of scalars with a dot', () => {
    assert.deepEqual(lines(['confluence', 'gdrive']), ['confluence · gdrive'])
  })

  it('keys are dim and values plain', () => {
    const [first] = text({ a: 'b' }).lines
    assert.deepEqual(first!.map(segment => segment.tone), ['dim', 'value', 'value'])
  })

  it('stops at six rows and says how many more', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))
    const out = lines(many)
    assert.equal(out.length, 7)
    assert.equal(out[6], '… 3 more')
    assert.equal(text(many).isTruncated, true)
  })

  it('never lets JSON punctuation or control characters through', () => {
    const joined = lines([{ a: 'x\u001b[31m red', b: [1, 2] }]).join('\n')
    assert.ok(!joined.includes('\u001b'))
    assert.ok(!/[{}"]/.test(joined))
  })

  it('leaves plain strings and numbers to the fallback', () => {
    assert.equal(text('hello').isFallback, true)
    assert.equal(text(5).isFallback, true)
  })
})
