# Pane design (Oct 5 2026, with the changes since)

How the GraphOS Inspector pane lays out a GraphOS Agent Services call, and why.

## First design

The pane reads first as a sentence, then as a short form. It asks the dock for 64 columns (`DOCK_COLUMNS` in `hooks/register.tsx`) and sheds detail below that; read `e.props.bodyColumns` and `e.props.scroll.bodyRows` rather than assuming. The first sketch, at 50 columns, is a real Agent Services call:

```text
 READ  confluence                      ✓ 9  ◐ 1
──────────────────────────────────────────────────
Search Confluence for pages mentioning "query
plan", newest first, and return up to 10 hits
with their title, excerpt and link.
                                   summary · Haiku
──────────────────────────────────────────────────
SEARCH   confluence_search
  cql    type=page
         AND text ~ "query plan"
         ORDER BY lastmodified DESC
  limit  10

RETURNS  up to 10 × search hit
         title · excerpt · url · modified
         content: id · type
         totalSize

ACCESS   ◐ excerpt  masked for your role
         needs  search:confluence
                read:confluence-content.summary
```

### Layout rules

- **Header (from the IR only):** the verb badge, the service, and policy counts (✓ allow, ◐ mask, ✕ deny). READ is quiet. WRITE is loud. A mutation whose name sounds destructive (delete, remove, archive, revoke) gets its own warning color. *(Build-plan change: a destructive root name is flagged whatever the operation type, because GraphQL does not stop a query field's resolver from writing.)*
- **Summary:** the Haiku headline, the one thing Haiku writes (a single sentence; no per-argument notes). It sits in a rounded box with a lavender (`BLOCK_HUE`) border, drawn by hand from edge to edge, so it cannot be missed; the box holds only the headline at full strength. The credit is an eyebrow: a dim `summary · Haiku` row directly above the box at its left edge (the `summary-credit` step sheds it; nothing else near the summary is shed). The headline is never cut; it wraps (in the view, to the box's inner width) to as many lines as it needs. While Haiku reads, the fallback shimmers inside the same box; if Haiku fails, the deterministic fallback shows dim in the box and there is no eyebrow.
- **The form:** four parts in a fixed order: the root field with its verb, the arguments, RETURNS, and ACCESS. Draw a tree only when the selection nests deeper than two levels, since most agent queries are shallow.
- **Annotate only when it says something:** `10 ×` for a list with a limit; `◐ masked` from `dry_run`; scopes from directives and descriptions; `deprecated`. Plain fields stay as plain names.
- **Real names always:** show the field's real name, never its alias. Show the alias dimmed only in the raw view.

### Argument renderers

Already built in `src/format/` (`renderArg(arg, rootField, now)` → `{ lines: Segment[][], isFallback, isTruncated?, more? }`, segments toned `key | op | value | dim | emph | warn`, every text already escaped).

The plain-text fallback (`src/format/fallback.ts`) never breaks a word or ends in `…`: a long line breaks into pieces of about 140 characters at the last space at or before the width (cut hard only inside a run with no space, never inside a surrogate pair), the first two pieces are drawn, those of one source line joined into one line the surface wraps at its spaces, and the rest are counted (`more`). Under the value the form says `N more lines` dim, the planner's own cut and the renderer's count together, as CHANGES does (`argCutText` in `src/view/plan.ts`, which counts its rows); settled, that is the Button that opens the full value.

### Interactions

Clickable items are `plain` Buttons, which render as styled text instead of bracketed labels. Each one is also reachable by keyboard (`tab` to move, `enter` to press), because buttons need pane focus.

| Target | Opens |
| --- | --- |
| An argument value | Full value, escaped but not truncated; for CQL and JQL, the parsed structure |
| `r: raw ↗` (header, second row, right) | Opens the raw operation and variables in their own docked pane (`gas-raw`), titled with the operation name; `r` again closes it |

Desktop gets the same tree.

### Pane states

1. **Analyzing:** header and raw root field right away, with a dim "checking policy…" line while the call waits at its prompt (never once it has run: a call trust rules let through can settle before its checks land, and RESULT says what came back), and `type not read yet` dim on a root's `return type` row, never a blank row.
2. **Ready:** the full form. The summary fills in when Haiku returns.
3. **Partial:** some enrichment failed or is still out. Show what arrived and mark the rest "still checking" / unknown.
4. **Will fail:** `validate` returned diagnostics. Show them at the top in red, above the form.
5. **Unparseable:** the raw operation with a note. The pane never goes blank.

## Build-plan changes that affect the pane (from the spike, see docs/spikes.md)

- **Passive during a prompt.** Button presses do not arrive while a permission dialog is open. While `call.status === 'pending'` the pane must be fully readable with no interaction: nothing important may hide behind a drawer. Drawers, the history controls and `raw ↗` work once the call has settled (status `ran` / `denied` / `errored`), or when the pane is opened with `/gas` outside a prompt.
- **Queue.** The pane shows the oldest pending call ("1 of N" in the header when N > 1), else the last settled call, marked as such.
- **The dialog already prints the operation and variables**, so the pane's value is the policy/schema/summary layer, not reformatting the raw text.
- **Header carries the operation name** so the reader can match the pane to the dialog.
- **Trust:** every string from the call or schema is escaped (`escapeText` / the renderers) and descriptions are shown as quoted, dimmed text. The verb badge, counts and risk color never come from the summary.
- **An info pane, not a debug log.** Show only what helps someone understand the GraphQL call. No tool_use ids, server names, request ids, digests or other plumbing on screen; those belong in `timing.log` or tests.
- **Tests:** behavioral only (text appears, state changes). Do not assert exact layout.

## Integration pass (Oct 5 2026)

- Header: badge, service, operation, and `ran` / `denied` / `failed` once settled (no status word while pending, only `1 of N` when queued); a second row with the policy meter (`▰▱`, ten cells) and `✓ all N fields allowed` or `✓ N allowed`, `MASKED n`, `DENIED n` (counted over data-bearing leaf fields), omitted while no policy is known.
- Fill, shed first: the root's description, argument hints (`· max 100`), type facts (`!` after never-null names, `(each present)` on lists of non-null items), defaults under the set arguments (`pageSize  10  (default)`), the paging line, the results preview.
- Objects read as objects: `content { id! · type! }`.
- ACCESS never goes empty: `needs  no scopes listed`. Unchecked access says why, from `ir.checks`.
- RESULT: rows (`5 of 3,766 · first page`), up to 5 preview rows `▹ label  extra`, scalars (`count  42`).
- Deep links (`↗ Open in Jira`) under the form, pending or settled.
- History: in the header, right of the status row: `p: ◂ ◦◦◦◦◦◦◉◦ n: ▸ l: live` (p older, n newer, l live; dots up to 8 calls and 60+ columns, else `7/8`), only with more than one settled call; a pending call shows the position as plain text. A past call is marked `── earlier call ──`. There is no footer. Button hotkeys must be a digit or a lowercase letter, so `[` and `]` are not available.
- While Haiku reads a pending call, the fallback headline shimmers (`ir.isSummarizing`).

## Live-call fixes (Oct 6 2026)

- `on Type` shows only for a real branch: a type condition equal to the parent type is dropped at annotation.
- Hints: a `max N` counts only when it describes the value itself; defaults never show on set arguments.
- Status: `! errors` when the response has errors and no data, `ran · N error(s)` (warning) when it has both.
- Object and list arguments draw as a key/value tree (`src/format/structure.ts`); the full JSON stays behind `full value` and raw.
- Paging: the continuation is the token field; the boolean flag follows as `(while hasMoreResults)` or `(until isLast)`. Where the argument and the field share a name the line says it once: `first page · more: pass nextPageToken back (until isLast)`.

## Review pass (Oct 6 2026): cut repeats, one column, flags

Three reviewers critiqued the pane, and this pass followed. Each fact is said once, in the place that owns it. *Updated by the design pass below; the sample is the pane as it now draws (ReviewSample at 64 columns, settled).*

```text
 READ   Jira · customer data  ReviewSample                ✓ ran
▰▰▰▰▰▰▰▰▰▰  ✓ 7  DENIED 1                              r: raw ↗
───────────────────────────────────────────────────────────────
summary · Haiku
╭─────────────────────────────────────────────────────────────╮
│ Search Jira for open DEV issues and list the demo-org-01    │
│ org members (email blocked).                                │
╰─────────────────────────────────────────────────────────────╯
⚑ email denied for 4 members · access request can be filed

┃ RESULT
  open  5 issues · more available
    [DEV-634]  Add CSV export to the reports page
    [DEV-467]  Research: Connect the Acme exporter with other
               storage vendors
  members  4
    Leo Marsh    mem_leo     ✕ email
    Jordan Lee   mem_jordan  ✕ email

┃ SEARCH       open: jira_searchAndReconsileIssuesUsingJql ───
  jql          project = DEV
               AND statusCategory != Done
               ORDER BY updated DESC
  maxResults   5  · max 5000
  fields       summary · status
  return type  search and reconcile results
               ├ issues  up to 5 issues
               │ ├ key
               │ ╰ fields  untyped JSON
               ╰ isLast · nextPageToken

┃ LIST         members: acme_customer_data_listOrganization…
               “List organization members.”
  orgId        demo-org-01
  return type  list of members
               ├ id · name · role
               ╰ ✕ email  denied · pii.contact

↗ o: this search in Jira  yourco.atlassian.net
```

- **Header.** Row one: the badge, `!` for a destructive name, the services by the names the flags line uses (`Jira`, `incident.io`; one table, `productOf` in `src/view/flags.ts`, else the scope in sentence case, `Acme customer data`; its card names one service in its title and gives the scope id only where it adds something, never `Jira (jira)`), the operation name in default text, and the status word alone (`✓ ran`, `ran · 2 errors` for real failures; denials are never named here). The status never goes and the operation name is never cut: the services list becomes `N services` first, then the name takes rows of its own under row one, broken at its seams (`headerPlan` in `src/view/plan.ts`, which counts them). Row two: the policy on the left, the history (`p: ◂ 20/20 n: ▸`, `earlier call` before it on a past call) and `r: raw ↗` grouped on the right; where they do not fit, the counts beside the meter go first, then `✓ all N allowed` says `✓ N`, then the `earlier call` words, then the position, and last the controls take a row of their own. The policy is the meter and terse counts (`✓ 7`, `◐ 1`, `DENIED 1`, the one loud word) only when something is masked or denied; when everything is allowed the meter is left out and the row says `✓ all N allowed` (the glyph green, the words dim; `✓ N allowed` when some fields were not checked), and those words light the policy card as the meter would. The rule under the header is one plain rule edge to edge: faint for a read, in the badge's hue for a write or a watch (the hue is the signal). Settled, the badge is the word bold in its hue with the pill's spacing; pending, the painted pill. (The close `×` is the engine's pane chrome, not the mod's.)
- **Flags line** (`src/view/flags.ts`), directly under the box: computed, never Haiku's. The surprises and risks, most important first, ` · ` between them: the whole operation denied, destructive names, writes, auth required (`link Confluence to read it`), denied fields (`email denied for 4 members` once settled, counted per root against that root's rows, so two roots denying `email` are two flags; by path `members.email denied` while pending), masked fields, an unreadable or too-large response, more rows than the limit asked for (`Jira returned 50 (asked 3)`, by product, by alias when two roots share one), failed policy or schema checks. A requestable denial adds `access request can be filed` when a denial token came back (`hasToken` on the outcome), else `access requestable`. It wraps and is never cut (a flag's own spaces are non-breaking where it would split badly); its hover card says each flag in full. No line when nothing is unusual. It replaced the notes it covers: destructive name, writes data, policy unavailable, and RESULT's `asked for N` and `response too large` lines.
- **Notes strip.** Only facts with no other home on the pane. A restricted or personal field the form draws with its mark (a return-tree line, a root line) is not repeated here; one folded or cut out of its tree gets a line, policy first, merged with personal data: `✕ email  denied · pii.contact`, `◐ excerpt  masked`, `◆ email  personal data · creator.user`. Past three of a kind, one line lists the rest. The planner decides this per layout (the notes are planned after the roots), so collapsing a tree brings its fields' lines back. Limits, `include` gaps, deprecations and `access not checked` stay as they were. That no root names a scope is the policy card's line (`no scopes required by the schema`), not the strip's.
- **One value column** for the whole form (`valueColumn`): max(10, the `return type` row, the longest argument name that fits + indent + two) capped at 16. Root verbs, arguments, `return type` and `access` all use it; a longer name (`statusCategory`) takes its own row and its value starts at the column on the next. RESULT's preview text starts at it too, where the key leaves a cell before it.
- **Blocks.** Only roots and RESULT open a block, with a bar `┃` (the structure hue) and the label bold in default text. Under a root, `return type` and `access` are lowercase dim labels at the argument names' indent, rows of its form with no blank row of their own. The tree always starts on the row after `return type`: a list root's own note (`list of members`) is the label row, any other root's type in words (italic) is. `access` is drawn only when it says something: the scopes, or `not checked` when other roots were checked. With several roots each root's header row runs out in a faint rule to the edge (no place marker). A root's description shows only when it fits whole on its row; otherwise it is left to the root's card, never cut.
- **RESULT.** Its lines sit two cells in under the label, a list's rows four; one list or value rides on the label row itself. One list reads count then noun, as group heads do: `┃ RESULT  5 issues · first page · more available` (`1 issue`, `no issues`, `none of 12 issues`). Group heads (several roots) are bold and say their noun once: `members  4` (the head is the noun, singular or plural), `open  5 issues`, `total  412` for a root's only scalar. Lists are kept and looked up by their root's response key, so two roots whose lists share a field name (`open` and `closed` both listing `issues`) keep their own rows, keys and hover scopes. Preview rows have no bullet; keys pad to the group's common column (by display cells, at most 45% of the row; a longer key wraps in it), and a record's key is bracketed and blue (a Markdown link whose label is inline code). The text after the key starts at the pane's value column when the key leaves a cell before it, else two cells after the key; it wraps under itself. Closed, a row's key and text hold to three rows, the last cut at a word with `…`, so its `▸` reads as more (a row cut so gets a `▸` even with no other field); opened (`▾`), the row says all of it, then its fields (`closedItem`; the planner counts both). The `✕ email` tag stays on each row that owns the denial, the `✕` red and the name dim, the tags padded into one column within a group. A rows note that would wrap says itself shorter (`more available` → `more`, then `first page` goes). An outcome stored before row attribution is re-attributed at view time (`attributed` in `src/view/outcome.ts`): a denied error at `list.<index>.field` inside a shown row becomes that row's tag, the response index mapped to the row through the stored `at`.
- **Links.** A deep link says what it opens and where: `↗ this search in Jira  yourco.atlassian.net`, settled with its size when the response said (`412 issues in Jira`), and the root after it when there are several (`· open`); its hover card shows the query and host. The host gives way whole rather than being cut; a label wider than its row wraps. Jira's search URL `{base}/issues/?jql=` is right for Jira Cloud (it answers 200; `/jira/search?jql=` redirects and drops the query). Auth links show their host beside the label where it fits whole, else not at all. While a prompt is up every link is the engine's Link (click or cmd-click). Once settled, deep links (the first on `o`), auth links and preview rows with a record link are plain Buttons (record keys Markdown links, where the kit has Markdown) that send `act({ openUrl })`; the host opens the URL (`$.process.run(['open', url])`), since a terminal click can fail (tmux strips OSC 8 links unless its hyperlinks feature is on).
- **Typography.** Bold only for the values the call sets, block openers and group heads; aliases and root names in default text; italic only for schema types (`untyped JSON`, `on Type`, the `return type` words); descriptions and policy reasons plain dim. Text after a glyph (`⚑`, `✕`, `↗`, notes) starts at column 2, as every other row's does (`NOTE_GLYPH` is the glyph and a space).
- **Return tree words.** No type jargon: no `!` after never-null names, no `(each present)`, no `(got 50)` (the flags line says what came back). An opaque JSON scalar (its type named `JSON` or `*_JSON`, or the schema saying it is opaque) is `untyped JSON` everywhere the pane names it, one way: a tree's tag, a root's `return type` row, a card's type in words (`Jira_JSON: untyped JSON, may be null`, never `a Jira_JSON`), and an argument's kind (`humanType` and `UNTYPED_JSON` in `src/view/kit.ts`). A restricted or personal name carries one note, one separator style and one classification (the schema's, else the one Agent Services gave the denial; the policy card and the flags card say it the same way, `classified pii.contact`): `╰ ✕ email  denied · pii.contact`, `◐ excerpt  masked`, `◆ email  personal data`.
- **Disclosure glyphs.** `❯ ▹ ▸` read as expandable, so nothing that does not expand uses them: blocks take `┃`, preview rows no bullet, chips `·`. `▸ ▾` stay on drawers and `full value ▸`.

Not done, by design: `access` does not list a root's masks and denials (the names in the return tree carry them); personal data that is allowed is marked on its name, not a flag (the flag would repeat it).

## Design pass (Oct 6 2026): wording, one home per fact, violet structure

The review pass above and the tables below are updated to match.

- **Wording.** `return type` for the form's `returns` row; `denied` everywhere a field is refused (`email denied for 4 members`, `members.email denied`); no `2/4` on root rules; `untyped JSON`; no `!`, `(each present)` or `(got N)` in the tree; the denied leaf `✕ email  denied · pii.contact`; a description only when it fits whole.
- **Each fact once.** The notes strip keeps only facts with no other home; one glyph (`◆`) for personal data in the tree and the strip. Haiku is told access and policy are out of scope (the pane computes and shows them) and describes only what the call does.
- **Hierarchy and color.** Structure is violet (`autoAccept`), never blue: the bars, the summary box and the card outlines. Blue is for what a press opens (record keys, the URL tip). The meter only when something is masked or denied; the header rule one plain rule; services by display name.
- **Alignment.** RESULT's preview text starts at the value column where the key leaves room; text after a glyph at column 2; one list reads count then noun; denial tags line up in a column.
- **Record card.** A preview row's card is titled by its key and place (`DEV-467 · issue 2 of 5`), then the summary wrapped, the fields the row kept (with the top-level scalars of an opaque JSON field, and the name of each object there, `fields.status.name`; at most 12, values at most 80 characters, escaped) except any that repeats the key or the summary, a denied field with its classification, and the URL the row opens.
- **Planner.** `textRows` wraps as the surface does (`wrapLines`: a run of spaces counts at its real length); a return-tree line and a root's header row are counted as the flex rows they are (`flowRows`: each Text moves whole to the next row when it does not fit); argument values are counted as drawn (layout spaces compacted); RESULT's errors and auth links are counted at the note column's width, a settled auth link as one row; an open field drawer as drawn (its title row, its rows indented under it, no border) and the open name's `▾`. From the same counts the plan anchors each hover card on its trigger's rows (`Plan.anchors`). `tests/parity.test.ts` holds the plan's RESULT rows to the drawn rows at every width from 16 to 100, and from 32 the whole pane's and every card's anchor.

## Glyphs and color (Oct 6 2026: a color pass, then a restraint pass)

*Superseded where the passes above say otherwise (`┃` for `❯`, no preview bullet, `◆` gray, the verb default text, the settled badge without brackets); the tables below are current.*

All tokens live in `src/view/ui/theme.ts` (`GLYPH`, `TREE`, `STRUCT`,
`BLOCK_HUE`, `QUIET`, `FAINT`, `PANEL`, `BADGE_HUE`, `COLOR`, `pill`).
Components never name a color or a glyph. Colors are theme keys (never raw
ANSI), so they follow light and dark.

### Glyphs

| Role | Glyph | Notes |
| --- | --- | --- |
| Block marker | `┃ SEARCH`, `┃ RESULT` | the bar in the block hue, the word bold default text |
| Sub-row label | `return type`, `access` | gray, not bold: rows of their root's form |
| Root rule | `┃ SEARCH  jira_search ─────` | multi-root panes: the root's line runs out in a faint rule, so each root reads as a block |
| Tree guide | `├ ` branch, `╰ ` last (rounded), `│ ` through | two cells a level, faint |
| Object braces | `content { id · type }` | faint |
| Chip | `·` | |
| Policy on a name | `✕ email`, `◐ excerpt` | bold, policy color, settled or not; takes the place of a marker |
| Personal data | `◆` | gray, before the name in the tree and in the notes strip |
| Attention | `▴` | warning hue, before a root that writes (a mutation, a destructive name); words after it (`writes data`) only when no CHANGES block says it |
| Limit | `↯` | notes strip, gray |
| Header rule | `────────` | one plain rule edge to edge: faint for a read, the badge hue for a write or watch |
| Policy meter | `▰▱` | allow / mask / deny colors; only when something is masked or denied |
| History | `p: ◂ ◦◦◉◦ n: ▸` | the shown dot in the brand orange |
| Drawer | `▸` closed, `▾` open | |

Glyphs in fixed-width or right-aligned slots are East Asian narrow (`✓ ✕ ▸
▾ ◂ ▴ ↯ ◌ ◉ ◦ ▰ ▱`). Ambiguous ones (`◐ ◆ ⚑ · … ─`) appear only in flowing
text, rules, or the note column (`NOTE_GLYPH`, the glyph and a space), which
the terminals the engine targets draw one cell wide. The tree guides and the
block bar are box drawing, drawn one cell wide too. No emoji.

### Palette: color as emphasis

The color pass colored every piece by kind; on a tall multi-root pane nothing
stood out, and the orange verbs, root names and JQL keywords read as
warnings. Color now marks what matters, in three layers:

| Layer | Token → theme key | Used for |
| --- | --- | --- |
| Content | default text | field names, argument names, scopes, root names (bold), RESULT field names |
| | `TONE.value` → bold | argument values: what the call sets (JQL/CQL values included) |
| Structure | `BLOCK_HUE` → `autoAccept` (violet) | the one structural hue: the `┃` bars, the summary box's border, the hover cards' outline and title. Violet, not blue: blue says a press opens it |
| | `QUIET` → `inactive` (gray) | `return type` / `access`, query keywords and operators (`AND`, `ORDER BY`, `=`, `~`), types and tags, preview dates, `◆`, `↯`, card labels |
| | `FAINT` → `subtle` (lightest gray) | tree guides, braces, the root rule, a read's header rule |
| Meaning | `COLOR` → `success` / `warning` / `error` | policy (✓ allow, ◐ mask, ✕ deny), WRITE, destructive names, failures |
| | `COLOR.link` → `ide` (blue) | what a press opens: record keys (fixed blue, inline code inside the link), the URL tip |
| | `STRUCT.number` → `planMode` (teal), bold | RESULT's key numbers (`20 of 412`, `count  412`) |
| Brand | `ACCENT` → `claude` (orange) | the shown history dot and `/gas` in the empty state only: it sits too close to the error red for anything else |

The verb badge is a painted pill (`backgroundColor` + `inverseText`, bold):
READ blue (`ide`), WRITE red, WATCH teal; the rule under the header
carries the hue for WRITE and WATCH only, so a read's header has one blue spot. MASKED and DENIED chips are pills in their policy color.
Settled panes keep every color (the surface draws `dimColor` as flat gray);
the badge becomes `[READ]`, chips become colored words.

Field names are default text both while pending (Text) and settled (plain
Buttons, which take no color), so the two states read alike; a restricted
name's policy mark carries its color, and a pending restricted name is
drawn in it too.

### Section gaps

The blank rows are the pane's structure, so `planOf` sheds them late:
`inner-gaps` (above RETURNS and ACCESS inside a root) right after the soft notes,
while the root's header line and the section labels
still mark its parts; `section-gaps` (between blocks and between roots) only
after RETURNS is cut to a line and the deep links are gone.

### Folds

When `returns-collapse` folds a root's RETURNS to its first level, an object
whose fields are all leaves draws them inline (`severity { name · rank }`)
whenever that still takes one row; only a nested selection, or one too wide,
folds to `… N fields`. The fold marker is a hover trigger: its card lists
every field under the object, indented by depth, with its type, its policy
(colored only when masked or denied) and its classification.

### Hover cards

A card pops up beside what lit it, so it is always in view (it used to sit
at the foot of the pane, off screen on a tall one). The plan says on which
rows each trigger is drawn (`Plan.anchors`, by card id, `cardId` in
`src/view/plan.ts`): a field name in a tree or a root's header row, an
argument name (a default one's too), a root's verb, a fold's `… N fields`,
the meter or `✓ all N allowed`, the flags line, a deep link, a RESULT row's
`▸`, a RESULT rows or value line, its context line, and in the header the badge, the services, the
operation name, the status word and the `summary · Haiku` eyebrow. The card opens under the
trigger's rows when there is at least as much room under them as above in the
rows in view (`scroll.offset`, `scroll.bodyRows`; without a window, the pane
as drawn), else over them; a card taller than that side is clipped. A trigger
that spans rows is passed whole (the flags line with its button row, a
wrapped root header), so the card covers none of it. The card spans from two
cells in (the form's indent, so the block bars and `⚑` stay in sight beside
it) to the pane's right edge, inside its blank last column.

Each card is a direct child of the pane's root Box, after every row, so a
lit card paints over them (one nested in its trigger's row would be painted
over by the rows after it), and `position: "absolute"` against the pane: no
wrapper, since the engine clips an absolute Box to a parent no rows tall and
the pointer over an absolute Box counts as on its parent. A card under its
trigger sits at `top` = the trigger's last row + 1; one over it at `bottom`
counted from the pane's last row, so its height need not be known. Each card is `display: none`
until its hover group is lit, outlined in the block hue on an opaque `PANEL`
(`userMessageBackground`) background so the rows beneath do not show
through. Absolute, so showing a card moves no row. Lit, a card is one of its
group, so it stays lit while the pointer rests on it. A card whose trigger is
not drawn (a field cut from its tree, an object that did not fold) is left
out.

A RESULT row lights only its own URL tip, over its summary; its `▸` lights a
card saying what a press opens (its full text where a closed row cuts it, and
the fields it kept), placed by the row's whole list: under the list's last
row, or over its head line when there is more room above, never over a
sibling row.

The policy card (lit by the meter, or by `✓ all N allowed` or `✓ write
allowed` in its place) is titled by its count (`policy · 1 field`); a write
Agent Services allows says so first; then one `fields` line of counts per policy, every
masked, denied and unchecked field by path, and `no scopes required by the
schema` when no selected field names a scope.

Everything the pane names teaches (the pane is partly a learning tool),
computed, never the model's words (`src/view/card-facts.ts`). A field's card
gives its description whole, or `no description in the schema`; its type in
GraphQL's notation and in words (`[Jira_Issue!]!: a list, never null, of
issues that are never null`) with a dim line on what the marks mean; what it
does in its list's paging (`nextPageToken`: pass it back as nextPageToken to
get the next page; `isLast`: true on the last page; offsets, totals, page
sizes; `pagingRole` in `src/view/paging.ts`); policy with classification and
requestability; personal data; deprecation; its scopes or `no scopes listed in
the schema`; and once settled what came back (a value, a count, the first
values in the rows shown). An argument's card adds what kind of value it
takes (a JQL or CQL query, a cursor, an offset, a page size, an ID). The
badge's card says what a query, mutation or subscription is and what
approving does; the services', each service and the roots it serves; the
operation name's, that the agent wrote it and GraphQL runs it the same under
any name; the eyebrow's, in one line, that it is a one-line headline Haiku
wrote from the operation and the schema. Cards say plain facts: no
reassurance (Haiku is not a trust boundary, and a card does not spend room
saying what the pane is not). A RESULT rows line's card says what each
part of it means (the count against the total and the limit, `first page`,
`more available` from the response's own flag) and how the list goes on.

**Never cut what the reader needs.** Identifiers and content wrap rather than
end in `…`, and the planner counts the rows: a name wider than its row moves
whole to the next or breaks at its seams (`nameRows`: after `_ . - /` or
before a capital), the tree guide carried down; a name that fits its row but
not beside its alias or mark breaks at a seam beside it (`seamRows`), so
`members:` is never left alone on its row, and moves whole only when no seam
falls in the room; scopes, the `return type`
words, drawer and card titles, RESULT keys and opened-row names, link labels
and the RowTip URL across its row's rows. Truncation is left to decorative
text, a description that shows only when it fits whole, a host that gives
way whole, and the stated last resorts (a closed RESULT row's text; a RowTip
URL longer than its row's rows). Emoji a terminal draws two cells wide (`✅
✨ ⭐`, `✔️`) count two.

## Provenance, the standing line and the transcript (Oct 6 2026)

**Who made the call.** A call a subagent made has one line under the trust line, in the note column: `↳ from subagent · Explore: find naming pages` (the agent's type, a colon and the task it was given). It wraps and the planner counts it (`Plan.agent`, card `p:agent`); the task is a model's text, so it is escaped and bounded when recorded and escaped again when drawn. While the agent list has not answered, or does not know the agent, the line says `from subagent` alone. Its card says what a subagent is, gives the label whole, and says the call is checked like any other. The main loop's own calls draw nothing.

**The standing line and the spinner are not the pane.** `$.ui.status` carries `Agent Services · 5 calls · 212 KB read · 3 trust rules · 2 ran unasked`: counts and sizes only, nothing a call said, nothing when there is nothing to count. The spinner reads a running call's headline in place of its word only while the call runs without a permission dialog (see docs/spikes.md).

**The transcript's RESULT** borrows the pane's look (`┃ RESULT`, the rows line riding on the label, the first three records under it, keys as links, `… N more`) but is not drawn by the planner: it has no width to plan against, so nothing in it is cut and its text wraps. It carries no hover cards (a card is placed against the pane's own rows); the pane has them all.

## Context receipts (Oct 6 2026)

How much of Claude's context an Agent Services response used, and which fields used it: GraphQL's pitch against tools that return whole records, proven per call. Computed from the response alone (`src/weight.ts`), said by `src/view/receipt.ts`; no model text in it.

```text
┃ RESULT  40 issues · first page · more available
  ▸ [DEV-900]  Issue 0: the plan cache misses after a schema
               change
    … 35 more
  45 KB · about 12k tokens                          (dim; the card's trigger)

╭─────────────────────────────────────────────────────────────╮
│ context · 45 KB · about 12k tokens                          │
│ Claude read this whole response: 45 KB, or                  │
│ about 12k tokens. The fields below took most of it.         │
│ Sizes are the response's JSON written compactly, in UTF-8   │
│ bytes (1 KB is 1,024 bytes). Tokens are an estimate at      │
│ about 4 characters each, not a count.                       │
│ issues.fields.description                                   │
│ takes    41 KB · 89% of the response · 40 rows,             │
│          about 1 KB each                                    │
│ Without issues.fields.description this result would be      │
│ about 4.8 KB (about 1.2k tokens).                           │
│ inside untyped JSON: the schema does not describe it        │
╰─────────────────────────────────────────────────────────────╯
```

- **The measure.** The response's JSON written compactly (`JSON.stringify`, no spaces), in UTF-8 bytes; a KB is 1,024 bytes, as Claude Code counts them in its own `Output too large (58.2KB)`. It does not move with a service's whitespace, so two calls compare; a service that pretty-prints cost the context a little more than it says. The total is the whole response: data, errors and extensions. A token is estimated at about 4 characters, counted in bytes (the same for ASCII, which JSON mostly is), and always said as `about`.
- **A field** is its path, list indices dropped (as the error grouping drops them), every row of a list summed: `issues.fields.description` is all fifty descriptions. Each is named by its real field name through the IR (an alias reads as the field it is); a key inside untyped JSON stays as the response wrote it. A field of a list item has `rows` (the nearest list on its path, its own included), so a row costs `bytes / rows`. The response's own `errors` and `extensions` are fields too, marked `isMeta`: a denial token on every row is real weight.
- **Which fields are named** (`explain` in `src/weight.ts`): the ones a person would drop or narrow, so not just the root. A field is named when it holds at least a tenth of the response. From each such member of the response the walk goes down into the fields that hold a tenth of the response while they together hold most (half) of their parent; where they do not, because the weight is spread over many small fields or the parent is a leaf, the parent is the answer: narrowing it is the only lever. At most five, heaviest first. A field that is the whole of a call's one root says nothing (every response is its root), so it never leads the line or raises the flag.
- **The line** is RESULT's last, dim, one row and wrapping (the planner counts it as `weight`, and sheds it first of RESULT's lines: `result-weight`, after `summary-credit`, before the form is cut). `size · about N tokens`, then the heaviest field and its share when it holds at least 30% of a response of at least 1 KB, unless the flag below already names it (each fact once: the sample above is flagged, so its line ends at the tokens). A member of the response beside the data reads in plain words (`errors.extensions.denial_context` is `denial tokens`, `metaWords` in `src/view/receipt.ts`); its card keeps the path. Words that belong together do not break (`58 KB`, `about 14k tokens`). Its card (`cardId.weight`, `k:weight`) lists each named field: path, size, share, rows and what a row costs, what the result would be without it (`Without issues.fields.description this result would be about 17 KB`), and its schema description, or that it is inside untyped JSON (the schema does not describe it) or part of the GraphQL response beside the data.
- **The flag** (`src/view/flags.ts`, with the over-the-limit flags): one field over half of a result over 16 KB, `issues.fields.description is 71% of a 58 KB result`; the card says what it would be without it.
- **A result Claude Code kept out of the context** (`<persisted-output>`, `isTooLarge`): the flag says it in the unit RESULT does, `response kept out of Claude's context · about 58 KB`, never characters. Claude saw only a short preview and the file's path, so the line says `58 KB saved to a file · Claude saw only a short preview and its path`, sized from the saved file when the mod read it back (the weight is `isPersisted`, and the rows and fields are the file's), else `about 58 KB` from Claude Code's own figure with no fields. RESULT then has this line and nothing else when nothing was read back. Such a response is not counted as read in the standing line.
- **The transcript's first line** carries the size after what came back (`5 issues · first page · 58 KB`), only where there is a first line to carry it. **The standing line** adds the bytes of the responses read, `Agent Services · 5 calls · 212 KB read`, after the calls; a call whose response was not read (an error, an oversized result kept out of the context) adds none.
- **Kept small.** The weight on the outcome is at most five fields (names cut at generous bounds), because the response itself is not kept. The walk tracks at most 2,000 distinct paths and 10 levels; past those a value's bytes stay in the field above it (`isCapped`), and the total stays exact.

## Write preview, v1 (Oct 7 2026)

For a mutation, a CHANGES section says what approving it changes, as a diff, first among the blocks (after the flags, the trust and subagent lines; above RESULT and the form). v1 computes it from the call's own arguments and the schema only (`src/preview/`): it reads no record, so the mod's hard rule (never `execute`) stands. The shapes it reads are the Agent Services schema as read on Oct 7 2026. A read of the current state would be a separate decision that would first change the hard rule that the mod never calls `execute`.

```text
┃ CHANGES  page 123456789
    status        current
  + title         On-call runbook
  + body          11 lines · page markup
  +   ## Escalation
  +   Page the primary on-call through incident.io.
  +   If nobody answers within 10 minutes, page the secondary
      on-call and then the engineering manager for the service.
      8 more lines
  + version       13
  + version note  Escalation through incident.io
  new values only · current state not read
```

- **One block per write root**, keyed by the root's path. Every root gets one (`WritePreview.all`), so every root's flags are raised; the first 8 are drawn, the last of them noting `2 more writes not shown`, and the transcript phrase ends `+2 more`. A root whose reading throws is never dropped: its block says `what this call changes could not be read` and raises `change not read`. A value's lists are read 16 deep for its one-line words (`[nested list]` past that). The header is `┃ CHANGES` and the target in words (`issue DEV-634`, `comment 10042 · on DEV-634`, `message 1728.0001 · in C0123`); a create says what it makes and where (`┃ NEW MESSAGE  in C0123`, `┃ NEW REPLY`, `┃ NEW COMMENT  on DEV-634`). The target wraps beside the label.
- **Rows.** The sign in the form's mark column (column 2), the label at column 4, the value at the CHANGES column: the form's value column, widened for the longest label that fits up to `CHANGE_MAX` (20) and at most half a narrow pane; a longer label stacks on rows of its own (broken by `nameRows`), its value on the next row at the column. `+` and its value in the allow hue, `-` in the deny hue, `±` (Jira's `edit`) in the mask hue; the label default text, a hover trigger. A value the API needs on every call and almost always unchanged (Confluence's `status: current`) is restated dim, with no sign.
- **Bodies.** A body that is one short line is a value (`+ text  Deploy done`). Any other is its row (`+ body  11 lines · page markup`, the count and format held together with non-breaking spaces; the format in plain words, `rich text`, `page markup`, `Slack markup`, `plain text`, its technical name on the row's card) and its first lines under it, each with its sign, the text two cells further in (column 6) so the lines read as their row's, wrapped and never cut, up to a budget of rows (8, shed to 3, then none: `BODY_ROWS`), at least one line when the budget is not none; then `N more lines` dim. A last line that fits one row is drawn rather than counted. With no lines drawn the row's own count says it.
- **Notes.** Dim, at the block's foot: `new values only · current state not read` for a change, `not read first · its contents are not shown` for a delete, what a recoverable delete leaves (`Confluence moves a deleted page to its space's trash, where it can be restored`), what an edit keeps (Slack's blocks and attachments). A create has none: there is no current state.
- **Flags** go on the flags line (computed, `previewFlags`): `@channel` / `@here` / `@everyone` (`<!…>` tokens and blocks' broadcast elements), `replyBroadcast` on a reply, another name or icon, `notifyUsers: false`, Jira's admin overrides, `deleteSubtasks`, and `cannot be undone` for a delete with no trash. The flags card says each in full. A mutation the table does not know reads its `notify…` and `override…` switches as the table reads Jira's: no CHANGES row (they steer the write; the form keeps them), a flag when one tells nobody or overrides, worded from the name and the schema only (`notifyIncidentChannel false: the incident channel is not told`).
- **Said once.** A root with a CHANGES block says that it writes there: the flags line drops `writes data` for it, and the name-guessed `destructive: <root>` when the block is a delete (its own `cannot be undone` and `also deletes its subtasks` stay); the root's `▴` stays, with no words after it (`rootReason` in `src/attention.ts`). A root with no block (a query named for a change, a write the preview could not read) keeps both.
- **Policy on a write.** The header's second row says the decision on the write, `✓ write allowed` (`✓ allowed` short of room), when Agent Services allows its roots and nothing it returns is masked or denied (`isWriteAllowed` in `src/view/outcome.ts`; a root with no decision of its own counts as allowed when every field in it is). The counts and the meter come back only when a returned field is masked or denied; the words light the policy card as the meter would. The transcript line says no `✓ … allowed` for such a write: policy shows there only as a flag.
- **The form says each value once.** Under a root with a CHANGES block, the arguments its rows show (each row's `card.arg`) are not rows of the form: one dim `in CHANGES` row, in the `return type` row's style, names them ` · ` apart, each name lighting its own argument's card (`RootPlan.inChanges`, counted as the flow it is). The arguments that name the target (`issueIdOrKey`, `id`) and those that steer the change rather than being part of it (`notifyUsers`, `bodyRepresentation`, `deleteSubtasks`, the overrides) stay rows of their own.

  ```text
  ┃ UPDATE        ▴ jira_editIssue
  issueIdOrKey  DEV-634
  notifyUsers   false
  in CHANGES    fields · update
  return type   untyped JSON
  ```
- **Cards** (`src/view/diff.tsx`): the section (`x:`): what the block is and how it was read, in the reader's words with no internals (`Read with a built-in mapping for jira_doTransition: issueIdOrKey names the issue; each row's card says what its argument means.`, or read from the call and the schema), what the signs mean; the target (`y:`): each argument that names it with its type and description, and what that kind of id is (a Jira key, a Confluence id, a Slack channel and ts); each row (`z:`, the whole row and its lines): what the new value means, the sign, where it is in the call, the argument's type in notation and words (`arg type` for a field inside it), the schema's description or that it sits in untyped JSON or an input object, and for a body its format, line count, links and mentions. The notes light the section's card too.
- **The planner** (`changesPlanOf` in `src/view/plan.ts`) counts every row (header, label rows, value rows, body lines, counts, notes) and anchors every card; `tests/parity.test.ts` holds planned rows to drawn rows from 32 to 100 columns, and each anchor to its trigger's rows, on a Jira transition, a field edit with ADF, a Confluence page update with a storage body (pending and settled), a Slack post with `@channel`, a delete and an unmapped mutation. Shedding: `change-lines` (after `soft-notes`) cuts the body budget to 3 rows; `change-lines-all` (after `returns-lines`) to none. The rows themselves never go.
- **The model is computed, not stored.** `previewOf(ir)` is memoized on the IR's roots, so the pane, the flags line and the transcript line read one model; a 300 KB storage body flattens in under 20 ms. Everything in it is escaped except `ChangeRow.back`, the raw value RESULT compares with, never drawn. Bounds: 24 rows a block (`N more` counts the rest), 256 KB, 20,000 ADF nodes and depth 64 per body, 5,000 lines kept, 4,000 characters a line, 20 links and mentions.
- **Shaped for a read, not promised.** Each hand-mapped write stores the read that would fetch its current state (`Mapping.read`: one named query built from the schema, the call's values only as variables, with a value transform for `bodyFormat ← bodyRepresentation` and a projection for Jira's `fields`), and before/after pairs; unit tests hold every stored read to the read-only floor. `ChangeRow.before` and `ChangeBlock.current` are where a read's result would go. Nothing runs these reads, and a v2 that did would be a separate decision that would first change the hard rule that the mod never calls `execute`.

**The transcript line** (`src/view/notice.ts`) leads a write with its change in a few words, `✎` and the mapping's phrase (`DEV-634 → transition 31`, `edits page 123456789: title, body, version, version note`: four changed labels are named, past four three and `+N more`, `posts to C0123`), from the call's arguments alone, so it is there while the policy is still being checked (`✎ posts to C0123 · writes Slack`). Then the policy part, then what it writes; no root name and no `writes data` (the change leads and the line ends in `writes Jira`): `✎ deletes DEV-634 · ⚑ cannot be undone · also deletes its subtasks · writes Jira`.

**After it ran** (`src/preview/confirm.ts`), the outcome keeps what the response said back of each new value (`confirms`, at most 12, escaped): the same (`version 13 ✓`), different (`title came back as …`, with what was sent for the card; a body that differs is not quoted, since a service normalizes markup), or the record a create made (`created message 1728.0001`). RESULT leads with it on a line of its own (`v:` card), drawn as CHANGES says its rows: the labels dim, the values bold, `✓` in the allow hue and a difference in the mask hue; it drops a scalar it already says; the transcript's RESULT block leads with it too. Only what the model selected can be compared, under its aliases; inside opaque JSON (an edit with `returnIssue`) the response's own keys are read.
