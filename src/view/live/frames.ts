// The live line's frames and colors, pure and import-free: shared by the
// view (its static fallback) and the surface module (spinner.tsx), which
// runs on the drawing thread with no $.

import type { ThemeKey } from 'claude-code'

/** Claude Code's own spinner glyphs, in its order. */
export const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'] as const

/** The glyph a still line shows: where a surface has no Client, or it failed. */
export const STILL = '✻'

/**
 * One frame, about 10 fps as the engine's own spinner: the glyph turns and
 * the shimmer moves one character per frame.
 */
export const FRAME_MS = 100

/** How far past either end the sweep runs, so it enters and leaves the text. */
export const SWEEP_MARGIN = 3

/** Characters lit around the sweep's center on either side. */
export const SWEEP_HALF = 1

/**
 * `claude` is a ThemeKey, so it follows the person's theme. `claudeShimmer`
 * is not among the typed keys (Color admits any string, and a surface draws
 * one it does not know its own way); the terminal's themes all define it,
 * as the engine's spinner uses it.
 */
export const COLOR = {
  base: 'claude' satisfies ThemeKey,
  lit: 'claudeShimmer',
} as const

/** The glyph for frame `step`. */
export function glyphAt(step: number): string {
  return SPIN[step % SPIN.length] ?? STILL
}

/**
 * The text cut into the part before the sweep, the lit part and the rest,
 * for frame `step`. Cut by code point, so no glyph is split.
 */
export function sweepAt(text: string, step: number): { before: string; lit: string; after: string } {
  const chars = [...text]
  const center = (step % (chars.length + 2 * SWEEP_MARGIN)) - SWEEP_MARGIN
  const from = Math.max(0, Math.min(chars.length, center - SWEEP_HALF))
  const to = Math.max(from, Math.min(chars.length, center + SWEEP_HALF + 1))
  return { before: chars.slice(0, from).join(''), lit: chars.slice(from, to).join(''), after: chars.slice(to).join('') }
}

/** The glyph column of a note (theme.ts NOTE_GLYPH), so the line aligns with the notes strip. */
export const GLYPH_COLUMNS = 2
