// The Claude Code release this mod needs, and what to say when the running
// one is older. Pure: no $.
//
// Mods load from 2.1.287; below that nothing of this plugin runs, so the
// README says to check before installing. From 2.1.287 up the mod loads and
// checks for itself (`$.session.version()` at session start), and says once
// when the engine is older than the release it was tested on.

/** The oldest release the mod was tested on: the pane, the verdict row, trust rules, large results. */
export const MIN_CLAUDE_CODE = '2.1.290'

/** `a` before `b`, as `2.1.288` is before `2.1.290`; undefined when either is not a dotted release. */
export function isOlder(a: string, b: string): boolean | undefined {
  const parts = (v: string) => (/^\d+(\.\d+){1,3}$/.test(v) ? v.split('.').map(Number) : undefined)
  const [x, y] = [parts(a), parts(b)]
  if (x === undefined || y === undefined) return undefined
  for (let at = 0; at < Math.max(x.length, y.length); at++) {
    const [p, q] = [x[at] ?? 0, y[at] ?? 0]
    if (p !== q) return p < q
  }
  return false
}

/** The line to log when the running release (`base`, as `$.session.version()` gives it) is older than the minimum; undefined otherwise. */
export function versionNote(base: string | undefined, plugin: string): string | undefined {
  if (base === undefined || isOlder(base, MIN_CLAUDE_CODE) !== true) return undefined
  return `${plugin} needs Claude Code ${MIN_CLAUDE_CODE} or later (this is ${base}): run \`claude update\`, then restart Claude Code.`
}
