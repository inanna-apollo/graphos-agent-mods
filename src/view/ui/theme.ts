// Shared colors, glyphs and fixed sizes for pane components.
// Inspector owns its charcoal canvas. Neutral colors survive 256-color rendering;
// warm orange and status hues are chosen for readable terminal approximations.
// Fixed-width slots use narrow glyphs
// (✓ ✕ ▸ ▾ ◂ ▴ ↯ ◌ ◉ ◦ ▰ ▱). Ambiguous-width glyphs (◐ ◆ ⚑ · … ─)
// are used in flowing text, rules or the note column; the supported terminals
// render them and the box-drawing guides as one cell.

/**
 * Warm orange, used for sparse category accents, the history dot
 * and the empty state's `/gas` command. Keep policy hues separate.
 */
export const ACCENT = '#FF7F00'
export const BACKGROUND = '#262626'
export const SELECTED = '#444444'
/** Muted teal for service/schema context; renders as xterm 109 (#87AFAF). */
export const DATA = '#5FAFAF'

/**
 * Palette roles (docs/pane-design.md): white text for names and values;
 * ACCENT for section bars; BLOCK_HUE for card outlines; QUIET for labels
 * and syntax. Policy and outcome colors remain separate from structure.
 */
export const BLOCK_HUE = '#D0D0D0'
/** Subdued labels, keywords, types and tags. */
export const QUIET = '#D0D0D0'
/** Structural neutral: hierarchy comes from geometry rather than low-contrast dimming. */
export const FAINT = '#D0D0D0'
/** Full-contrast foreground on the owned charcoal canvas. */
export const TEXT = '#FFFFFF'
/** An opaque raised panel behind a hover card, so the rows under it do not show through. */
export const PANEL = BACKGROUND

/** Structural colors; safety and outcomes use the separate semantic extension below. */
export const STRUCT = {
  /** A block's bar (`┃ SEARCH`, `┃ RESULT`): the bar alone takes the hue, the word is bold default text. */
  bar: ACCENT,
  verb: TEXT,
  result: TEXT,
  /** Neutral outline role, retained for callers that draw framed content. */
  box: BLOCK_HUE,
  /** Rows of a root's form that label a part of it, lowercase and dim: `return type`, `access`. */
  returns: QUIET,
  access: QUIET,
  /** The rule a root's header line runs out in (multi-root panes). */
  rootRule: FAINT,
  /** Tree guides (`├ ╰ │`) and an object's `{ }`. */
  guide: FAINT,
  /** Schema types and tags after a name (`untyped JSON`, `on Issue`). */
  type: DATA,
  /** Query keywords (AND, ORDER BY, in) and operators (=, ~): syntax, quieter than the values. */
  keyword: QUIET,
  operator: QUIET,
  /** A record's date or other extra. */
  date: QUIET,
  /** Gray personal-data marker, distinct from policy colors. */
  personal: QUIET,
  /** The ↯ of a limit note. */
  limit: QUIET,
  /** RESULT's key numbers (`5 of 3,766`, `count  42`): what came back. */
  number: TEXT,
  /** A hover card's outline and title. */
  card: BLOCK_HUE,
  /** Labels inside a hover card (`type`, `args`, `needs`). */
  cardLabel: QUIET,
} as const

/** Props for structural color. Settled panes keep it whole: the surface draws `dimColor` as a flat gray. */
export const struct = (key: string, _isSettled = false, extra: { bold?: boolean; italic?: boolean } = {}) => ({
  color: key,
  ...extra,
})

/** Accessible terminal status extension, not official Apollo brand tokens. */
export const COLOR = {
  allow: '#86EFAC',
  mask: '#FDE68A',
  deny: '#FCA5A5',
  write: '#FCA5A5',
  fail: '#FCA5A5',
  destructive: '#FCA5A5',
  pending: '#FDE68A',
  /** Links use muted teal plus their existing brackets/arrow affordances. */
  link: DATA,
} as const

export type SemanticColor = (typeof COLOR)[keyof typeof COLOR]

/**
 * The verb badge's hue: READ/WATCH neutral, WRITE the failure hue (it changes
 * data). The rule under the header carries it for a write or a
 * watch; a read's rule is faint.
 */
export const BADGE_HUE = { query: SELECTED, mutation: COLOR.write, subscription: SELECTED, unknown: COLOR.fail } as const

/**
 * Dark text on the light semantic fills. Dark selection fills instead use white.
 */
export const PILL_TEXT = BACKGROUND

/** Props for a pill: `hue` painted behind bold inverse text. */
export const pill = (hue: string) => ({ backgroundColor: hue, color: hue === SELECTED ? TEXT : PILL_TEXT, bold: true })

export const GLYPH = {
  allow: '✓',
  mask: '◐',
  deny: '✕',
  unknown: '?',
  pending: '◌',
  ran: '✓',
  denied: '✕',
  failed: '!',
  /** In the header, a destructive root name: narrow, where ⚠ can draw two cells wide. */
  destructiveNarrow: '!',
  /** Personal data, wherever the pane marks it: before a name in the tree, and in the notes strip. */
  personal: '◆',
  limit: '↯',
  bullet: '·',
  /** Warning marker before a mutation or destructive root name. */
  attention: '▴',
  /** An action that leaves the pane: a link to open. */
  link: '↗',
  deprecated: '·',
  checking: '…',
  concern: '!',
  /** Before a block's label (`┃ SEARCH`, `┃ RESULT`), in the block hue: a bar, not an arrow, since nothing here folds. */
  section: '┃',
  /** A chip naming a field. */
  chip: '·',
  /** The flags line under the summary: the surprises and risks, computed. */
  flag: '⚑',
  /** A call a subagent made: it branches off the main conversation. In the note column, where an ambiguous-width glyph is safe. */
  agent: '↳',
  /** The summary box, drawn by hand so its credit can sit in the border. */
  boxTop: '╭',
  boxTopEnd: '╮',
  boxBottom: '╰',
  boxBottomEnd: '╯',
  boxSide: '│',

  closed: '▸',
  open: '▾',
  separator: ' · ',
  /** The rules: the one under the header, a root's run-out, the summary box. */
  rule: '─',
  /** The policy meter's cells (U+25B0 / U+25B1: East Asian narrow). */
  meterOn: '▰',
  meterOff: '▱',
  /** The history position (narrow: U+25C9 / U+25E6): the shown call, and the others. */
  dotOn: '◉',
  dotOff: '◦',
  older: '◂',
  newer: '▸',
} as const

/**
 * The tree guide's cells, two per level: a branch, the last branch (rounded),
 * a level that carries on past this row, and one that has ended.
 */
export const TREE = { branch: '├ ', last: '╰ ', through: '│ ', blank: '  ' } as const

/** Cells one level of the tree guide takes. */
export const TREE_CELLS = 2

/** Cells in the policy meter. */
export const METER_CELLS = 10

/** The most history entries that read as dots; more say `3 of 12`. */
export const MAX_DOTS = 8

/** The verb badge's word for each operation type. */
export const BADGE = { query: 'READ', mutation: 'WRITE', subscription: 'WATCH' } as const

/** Cells the badge takes: the word and a space each side. */
export const badgeCells = (opType: keyof typeof BADGE | undefined) => (opType === undefined ? 1 : BADGE[opType].length) + 2

/** Words a policy chip says, as well as its color. */
export const CHIP_WORD = { mask: 'MASKED', deny: 'DENIED' } as const

/** The least label gutter (`┃ RESULT  `): the bar, a space, the label, two spaces. The pane's value column (plan.ts valueColumn) is never narrower. */
export const GUTTER = 10
/** The widest the pane's value column grows for argument names; a longer name stacks its value on the next row. */
export const VALUE_MAX = 16

/** The label column inside a drawer (`deprecated  `). */
export const DRAWER_GUTTER = 12

/** A drawer's body indent under its title. */
export const DRAWER_INDENT = 2

/** The least room a Row's spacer keeps between its two sides. */
export const ROW_GAP = 2

/** The mark column ahead of an argument's name: ` $cql`. */
export const MARK = 2
/** Most cells an argument name takes in the form, by pane width (12 at 50 columns, 16 at 64); a longer one is cut with `…`. */
export const argNameMax = (columns: number) => Math.min(18, Math.max(10, Math.floor(columns / 4)))
/** A note's glyph column (⚑, ✕, ↗): the glyph and a space, so the text after it starts where every other row's does. */
export const NOTE_GLYPH = 2

/** A bullet's column (a drawer's list). */
export const BULLET = 2

/**
 * The blank column the docked pane keeps at its right edge, as the built-in
 * sidebar does (its paddingX); the /diff mod's PANE_RIGHT_PAD_COLUMNS.
 */
export const RIGHT_PAD = 1

/** How the argument renderers' tones draw. */
export const TONE = {
  key: {},
  op: { color: STRUCT.operator },
  value: { bold: true },
  dim: { color: QUIET },
  emph: { bold: true },
  warn: { color: COLOR.fail, bold: true },
} as const satisfies Record<string, { color?: string; bold?: boolean; dimColor?: boolean }>
