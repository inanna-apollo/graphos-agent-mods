import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeEntities } from '../../src/entities.ts'
import { resultLines } from '../../src/view/outcome.ts'

test('named and numeric references decode; unknown ones, bare ampersands and impossible code points stay as written', () => {
  assert.equal(decodeEntities('Team Notes/How-Tos/&quot;Gotchas&quot;'), 'Team Notes/How-Tos/"Gotchas"')
  assert.equal(decodeEntities('feature&rsquo;s &ldquo;commercial&rdquo; &amp; more'), 'feature’s “commercial” & more')
  assert.equal(decodeEntities('&#39;a&#x2019;'), "'a’")
  assert.equal(decodeEntities('AT&T &bogus; &#0; &#xD800; &#99999999;'), 'AT&T &bogus; &#0; &#xD800; &#99999999;')
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
})

test('a row draws decoded text, and a reference to a control character comes out escaped, never as the control', () => {
  const sent = { rows: [{ field: 'results', count: 1 }], preview: [{ field: 'results', items: [{ label: '&quot;Gotchas&quot; &#27;[2J' }], more: 0 }], errors: [], authLinks: [] }
  const preview = resultLines(sent as never).find(line => line.kind === 'preview')
  const label = preview?.kind === 'preview' ? preview.items[0]?.label : undefined
  assert.ok(label?.startsWith('"Gotchas"'))
  assert.ok(!label?.includes('\u001b'))
})
