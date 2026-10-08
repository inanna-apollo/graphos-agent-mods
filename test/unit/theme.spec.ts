import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BADGE_HUE, COLOR, PANEL, PILL_TEXT, STRUCT, TREE, TREE_CELLS } from '../../src/view/ui/theme.ts'
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
