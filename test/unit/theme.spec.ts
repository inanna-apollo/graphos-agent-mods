import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACCENT, BADGE_HUE, BLOCK_HUE, COLOR, PANEL, PILL_TEXT, STRUCT, TONE, TREE, TREE_CELLS } from '../../src/view/ui/theme.ts'
import { continuationOf } from '../../src/view/plan.ts'

// Theme keys the engine resolves per light/dark theme (never raw ANSI).
const THEME_KEYS = ['claude', 'success', 'warning', 'error', 'suggestion', 'permission', 'planMode', 'ide', 'autoAccept', 'merged', 'remember', 'text', 'inverseText', 'inactive', 'subtle', 'userMessageBackground']

describe('structural palette', () => {
  it('uses only theme keys', () => {
    for (const [name, key] of Object.entries(STRUCT)) assert.ok(THEME_KEYS.includes(key), `${name}: ${key}`)
    assert.ok(THEME_KEYS.includes(PANEL))
  })

  it('never borrows a semantic hue', () => {
    const semantic = new Set<string>(Object.values(COLOR))
    for (const [name, key] of Object.entries(STRUCT)) assert.ok(!semantic.has(key), `${name} reuses ${key}`)
  })

  it('keeps the brand orange off structure: it reads as a warning', () => {
    for (const [name, key] of Object.entries(STRUCT)) assert.notEqual(key, ACCENT, name)
    assert.ok(!Object.values(BADGE_HUE).includes(ACCENT as never))
  })

  it('is emphasis: one hue opens a block, the rest of the structure is gray', () => {
    const hues = new Set<string>(Object.values(STRUCT))
    // The block hue, default text, two grays, and RESULT's numbers.
    assert.ok(hues.size <= 5, [...hues].join(', '))
    assert.notEqual(STRUCT.verb, STRUCT.returns, '`return type` and `access` sit under their root')
    assert.equal(STRUCT.returns, STRUCT.access)
    // The bars, the summary box and the cards' outline are one hue.
    assert.equal(STRUCT.bar, BLOCK_HUE)
    assert.equal(STRUCT.box, BLOCK_HUE)
    assert.equal(STRUCT.card, BLOCK_HUE)
  })

  it('takes no blue: blue says a press opens it, so structure is violet and links keep the blue', () => {
    // The theme keys a terminal theme draws blue or blue-gray.
    const BLUES = ['ide', 'permission', 'suggestion']
    for (const [name, key] of Object.entries(STRUCT)) assert.ok(!BLUES.includes(key), `${name}: ${key}`)
    assert.equal(BLOCK_HUE, 'autoAccept')
    assert.ok(BLUES.includes(COLOR.link))
  })

  it('makes query syntax quiet and the values the call sets bold', () => {
    assert.equal(TONE.value.bold, true)
    assert.equal(TONE.op.color, STRUCT.operator)
    assert.equal(STRUCT.keyword, STRUCT.operator)
  })

  it('paints READ and WRITE differently, WRITE in its semantic color', () => {
    assert.notEqual(BADGE_HUE.query, BADGE_HUE.mutation)
    assert.equal(BADGE_HUE.mutation, COLOR.write)
    // No policy or risk color reads as READ; links share its blue on purpose (both say "go and read").
    assert.ok(!new Set<string>(Object.entries(COLOR).filter(([name]) => name !== 'link').map(([, hue]) => hue)).has(BADGE_HUE.query))
    assert.ok(THEME_KEYS.includes(PILL_TEXT))
  })
})

describe('tree guide', () => {
  it('takes the same cells at every level', () => {
    for (const cell of Object.values(TREE)) assert.equal([...cell].length, TREE_CELLS)
  })

  it('carries a branch on down a wrapped row and ends under the last one', () => {
    assert.equal(continuationOf(`${TREE.through}${TREE.branch}`), `${TREE.through}${TREE.through}`)
    assert.equal(continuationOf(`${TREE.through}${TREE.last}`), `${TREE.through}${TREE.blank}`)
    assert.equal(continuationOf(''), '')
  })
})
