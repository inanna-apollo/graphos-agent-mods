import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACCENT, BACKGROUND, BADGE_HUE, BLOCK_HUE, COLOR, DATA, PANEL, QUIET, SELECTED, STRUCT, TEXT, TREE, TREE_CELLS, pill, struct } from '../../src/view/ui/theme.ts'
import { continuationOf } from '../../src/view/plan.ts'

// WCAG relative luminance of the declared sRGB palette. This checks token
// contrast, not the terminal's color conversion or display calibration.
function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i)
  const channels = [1, 3, 5].map(at => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// Model the runtime's Chalk-style 256-color fallback, decoded with the
// standard xterm palette. Live capture confirms 235/208/251/231/157 for
// canvas/accent/quiet/white/allow; custom terminal palettes remain external.
function indexedColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]
  const cube = [0, 95, 135, 175, 215, 255]
  const rgb = r === g && g === b
    ? Array<number>(3).fill(r < 8 ? 0 : r > 248 ? 255 : 8 + 10 * Math.round(((r - 8) / 247) * 24))
    : [r, g, b].map(value => cube[Math.round(value / 255 * 5)]!)
  return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

describe('owned canvas palette', () => {
  it('keeps body, quiet, accent and semantic text readable on charcoal', () => {
    for (const [name, hue] of Object.entries({ TEXT, QUIET, ACCENT, DATA, ...COLOR })) {
      assert.ok(contrast(hue, BACKGROUND) >= 4.5, `${name}: text contrast ${contrast(hue, BACKGROUND)}`)
    }
    assert.equal(PANEL, BACKGROUND)
  })

  it('retains text and pill contrast through the indexed-color fallback', () => {
    for (const hue of [TEXT, QUIET, ACCENT, DATA, ...Object.values(COLOR)]) {
      assert.ok(contrast(indexedColor(hue), indexedColor(BACKGROUND)) >= 4.5, `indexed text ${hue}`)
    }
    for (const hue of [SELECTED, ...Object.values(COLOR)]) {
      const props = pill(hue)
      assert.ok(contrast(indexedColor(props.color), indexedColor(props.backgroundColor)) >= 4.5, `indexed pill ${hue}`)
    }
  })

  it('keeps structural foregrounds distinguishable from the canvas', () => {
    for (const [name, hue] of Object.entries({ BLOCK_HUE, ...STRUCT })) {
      assert.ok(contrast(hue, BACKGROUND) >= 3, `${name}: UI contrast ${contrast(hue, BACKGROUND)}`)
    }
  })

  it('preserves readable text on both selection and semantic pill fills', () => {
    assert.equal(pill(SELECTED).color, TEXT)
    for (const hue of new Set([SELECTED, ...Object.values(BADGE_HUE), ...Object.values(COLOR)])) {
      const props = pill(hue)
      assert.ok(contrast(props.color, props.backgroundColor) >= 4.5, `pill ${hue}`)
    }
    for (const hue of [COLOR.allow, COLOR.mask, COLOR.deny, COLOR.pending]) {
      assert.equal(pill(hue).color, BACKGROUND)
    }
  })

  it('keeps identity and interaction colors separate from safety meaning', () => {
    // Links carry context color; result numbers use the general foreground.
    const safety = new Set<string>(Object.entries(COLOR).filter(([name]) => name !== 'link').map(([, hue]) => hue))
    for (const [name, hue] of Object.entries({ ACCENT, SELECTED, ...STRUCT })) {
      assert.ok(!safety.has(hue), `${name} reuses safety hue ${hue}`)
    }
    assert.notEqual(BADGE_HUE.query, BADGE_HUE.mutation)
    assert.equal(BADGE_HUE.mutation, COLOR.write)
    assert.equal(COLOR.link, DATA)
    assert.equal(STRUCT.number, TEXT)
  })

  it('does not change semantic meaning when a call settles', () => {
    for (const hue of Object.values(COLOR)) {
      assert.deepEqual(struct(hue, true, { bold: true }), struct(hue, false, { bold: true }))
      assert.deepEqual(struct(hue, true), { color: hue })
    }
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
