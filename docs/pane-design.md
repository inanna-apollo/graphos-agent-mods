# Pane design (Oct 5 2026, with the changes since)

Layout and interaction decisions for the GraphOS Inspector pane.

## First design

The pane starts with a headline followed by a form. It requests 64 columns (`DOCK_COLUMNS` in `hooks/register.tsx`) and reduces detail at narrower widths. Use `e.props.bodyColumns` and `e.props.scroll.bodyRows` for the available space. The first sketch, at 50 columns, is a real Agent Services call:

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

- **Header (from the IR only):** the verb badge, the service, and policy counts (✓ allow, ◐ mask, ✕ deny). READ uses subdued styling; WRITE is emphasized. A mutation whose name sounds destructive (delete, remove, archive, revoke) gets its own warning color. *(Build-plan change: a destructive root name is flagged whatever the operation type, because GraphQL does not stop a query field's resolver from writing.)*
- **Summary:** the Haiku headline, the one thing Haiku writes (a single sentence; no per-argument notes). It sits in a rounded box with a lavender (`BLOCK_HUE`) border, drawn by hand from edge to edge; the box holds only the headline in normal text color. The credit is a dim `summary · Haiku` row directly above the box at its left edge (the `summary-credit` step sheds it; nothing else near the summary is shed). The headline is never cut; it wraps (in the view, to the box's inner width) to as many lines as it needs. While Haiku reads, the fallback shimmers inside the same box; if Haiku fails, the deterministic fallback shows dim in the box and there is no eyebrow.
- **The form:** four parts in a fixed order: the root field with its verb, the arguments, RETURNS, and ACCESS. Draw a tree only when the selection nests deeper than two levels, since most agent queries are shallow.
- **Annotations:** `10 ×` for a list with a limit; `◐ masked` from `dry_run`; scopes from directives and descriptions; `deprecated`. Plain fields stay as plain names.
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

- **Controls during a prompt.** Button presses do not arrive while a permission dialog is open. While `call.status === 'pending'` the pane must be fully readable with no interaction: nothing important may hide behind a drawer. Drawers, the history controls and `raw ↗` work once the call has settled (status `ran` / `denied` / `errored`), or when the pane is opened with `/gas` outside a prompt.
- **Queue.** The pane shows the oldest pending call ("1 of N" in the header when N > 1), else the last settled call, marked as such.
- **The dialog prints the operation and variables.** The pane adds policy, schema, and summary information.
- **Header carries the operation name** so the reader can match the pane to the dialog.
- **Trust:** every string from the call or schema is escaped (`escapeText` / the renderers) and descriptions are shown as quoted, dimmed text. The verb badge, counts and risk color never come from the summary.
- **Visible information.** Show only what helps someone understand the GraphQL call. No tool_use ids, server names, request ids, digests or other plumbing on screen; those belong in `timing.log` or tests.
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

Three reviewers critiqued the pane, and this pass followed. Each fact appears in one section. *Updated by the design pass below; the sample is the pane as it now draws (ReviewSample at 64 columns, settled).*

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

- **Header.** Row one: the badge, `!` for a destructive name, the services by the names the flags line uses (`Jira`, `incident.io`; one table, `productOf` in `src/view/flags.ts`, else the scope in sentence case, `Acme customer data`; its card names one service in its title and gives the scope id only where it adds something, never `Jira (jira)`), the operation name in default text, and the status word alone (`✓ ran`, `ran · 2 errors` for real failures; denials are never named here). The status never goes and the operation name is never cut: the services list becomes `N services` first, then the name takes rows of its own under row one, broken at punctuation or word boundaries (`headerPlan` in `src/view/plan.ts`, which counts them). Row two: the policy on the left, the history (`p: ◂ 20/20 n: ▸`, `earlier call` before it on a past call) and `r: raw ↗` grouped on the right; where they do not fit, the counts beside the meter go first, then `✓ all N allowed` says `✓ N`, then the `earlier call` words, then the position, and last the controls take a row of their own. The policy is the meter and terse counts (`✓ 7`, `◐ 1`, `DENIED 1`) only when something is masked or denied; when everything is allowed the meter is left out and the row says `✓ all N allowed` (the glyph green, the words dim; `✓ N allowed` when some fields were not checked), and those words light the policy card as the meter would. The rule under the header is one plain rule edge to edge: faint for a read, in the badge's hue for a write or a watch (the color identifies the operation type). Settled, the badge is the word bold in its hue with the pill's spacing; pending, the painted pill. (Claude Code supplies the close `×` control.)
- **Flags line** (`src/view/flags.ts`), directly under the box: computed from the operation and checks. Policy failures and risk indicators, highest priority first, ` · ` between them: the whole operation denied, destructive names, writes, auth required (`link Confluence to read it`), denied fields (`email denied for 4 members` once settled, counted per root against that root's rows, so two roots denying `email` are two flags; by path `members.email denied` while pending), masked fields, an unreadable or too-large response, more rows than the limit asked for (`Jira returned 50 (asked 3)`, by product, by alias when two roots share one), failed policy or schema checks. A requestable denial adds `access request can be filed` when a denial token came back (`hasToken` on the outcome), else `access requestable`. It wraps and is never cut (a flag's own spaces are non-breaking where it would split badly); its hover card says each flag in full. No line when nothing is unusual. It replaced the notes it covers: destructive name, writes data, policy unavailable, and RESULT's `asked for N` and `response too large` lines.
- **Notes strip.** Facts omitted from other sections. A restricted or personal field the form draws with its mark (a return-tree line, a root line) is not repeated here; one folded or cut out of its tree gets a line, policy first, merged with personal data: `✕ email  denied · pii.contact`, `◐ excerpt  masked`, `◆ email  personal data · creator.user`. Past three of a kind, one line lists the rest. The planner decides this per layout (the notes are planned after the roots), so collapsing a tree brings its fields' lines back. Limits, `include` gaps, deprecations and `access not checked` stay as they were. When no root names a scope, the policy card shows `no scopes required by the schema`.
- **One value column** for the whole form (`valueColumn`): max(10, the `return type` row, the longest argument name that fits + indent + two) capped at 16. Root verbs, arguments, `return type` and `access` all use it; a longer name (`statusCategory`) takes its own row and its value starts at the column on the next. RESULT's preview text starts at it too, where the key leaves a cell before it.
- **Blocks.** Only roots and RESULT open a block, with a bar `┃` (the structure hue) and the label bold in default text. Under a root, `return type` and `access` are lowercase dim labels at the argument names' indent, rows of its form with no blank row of their own. The tree always starts on the row after `return type`: a list root's own note (`list of members`) is the label row, any other root's type in words (italic) is. `access` is drawn only when it says something: the scopes, or `not checked` when other roots were checked. With several roots each root's header row runs out in a faint rule to the edge (no place marker). A root's description shows only when it fits whole on its row; otherwise it is left to the root's card, never cut.
- **RESULT.** Its lines sit two cells in under the label, a list's rows four; one list or value appears on the label row. One list reads count then noun, as group heads do: `┃ RESULT  5 issues · first page · more available` (`1 issue`, `no issues`, `none of 12 issues`). Group heads (several roots) are bold and say their noun once: `members  4` (the head is the noun, singular or plural), `open  5 issues`, `total  412` for a root's only scalar. Lists are kept and looked up by their root's response key, so two roots whose lists share a field name (`open` and `closed` both listing `issues`) keep their own rows, keys and hover scopes. Preview rows have no bullet; keys pad to the group's common column (by display cells, at most 45% of the row; a longer key wraps in it), and a record's key is bracketed and blue (a Markdown link whose label is inline code). The text after the key starts at the pane's value column when the key leaves a cell before it, else two cells after the key; it wraps under itself. Closed, a row's key and text hold to three rows, the last cut at a word with `…`, so its `▸` reads as more (a row cut so gets a `▸` even with no other field); opened (`▾`), the row says all of it, then its fields (`closedItem`; the planner counts both). The `✕ email` tag stays on each row that owns the denial, the `✕` red and the name dim, the tags padded into one column within a group. A rows note that would wrap says itself shorter (`more available` → `more`, then `first page` goes). An outcome stored before row attribution is re-attributed at view time (`attributed` in `src/view/outcome.ts`): a denied error at `list.<index>.field` inside a shown row becomes that row's tag, the response index mapped to the row through the stored `at`.
- **Links.** A deep link says what it opens and where: `↗ this search in Jira  yourco.atlassian.net`, settled with its size when the response said (`412 issues in Jira`), and the root after it when there are several (`· open`); its hover card shows the query and host. The host is omitted when it cannot fit in full; a label wider than its row wraps. Jira Cloud preserves the query with `{base}/issues/?jql=` (it answers 200; `/jira/search?jql=` redirects and drops the query). Auth links show their host beside the label where it fits whole, else not at all. While a prompt is up every link is the engine's Link (click or cmd-click). Once settled, deep links (the first on `o`), auth links and preview rows with a record link are plain Buttons (record keys Markdown links, where the kit has Markdown) that send `act({ openUrl })`; the host opens the URL (`$.process.run(['open', url])`), since a terminal click can fail (tmux strips OSC 8 links unless its hyperlinks feature is on).
- **Typography.** Bold only for the values the call sets, block openers and group heads; aliases and root names in default text; italic only for schema types (`untyped JSON`, `on Type`, the `return type` words); descriptions and policy reasons plain dim. Text after a glyph (`⚑`, `✕`, `↗`, notes) starts at column 2, as every other row's does (`NOTE_GLYPH` is the glyph and a space).
- **Return tree words.** Use plain words in the return tree. Omit nullability markers and result counts there; hover cards explain nullability and the flags line reports unexpected counts. An opaque JSON scalar (its type named `JSON` or `*_JSON`, or the schema saying it is opaque) is `untyped JSON` everywhere the pane names it, one way: a tree's tag, a root's `return type` row, a card's type in words (`Jira_JSON: untyped JSON, may be null`, never `a Jira_JSON`), and an argument's kind (`humanType` and `UNTYPED_JSON` in `src/view/kit.ts`). A restricted or personal name carries one note, one separator style and one classification (the schema's, else the one Agent Services gave the denial; the policy card and the flags card say it the same way, `classified pii.contact`): `╰ ✕ email  denied · pii.contact`, `◐ excerpt  masked`, `◆ email  personal data`.
- **Disclosure glyphs.** `❯ ▹ ▸` read as expandable, so nothing that does not expand uses them: blocks take `┃`, preview rows no bullet, chips `·`. `▸ ▾` stay on drawers and `full value ▸`.

The return tree marks each masked, denied, or personal field. The `access` section and flags omit these details when the tree already shows them.

## Design pass (Oct 6 2026): wording, deduplication, violet structure

The review pass above and the tables below are updated to match.

- **Wording.** `return type` for the form's `returns` row; `denied` everywhere a field is refused (`email denied for 4 members`, `members.email denied`); no `2/4` on root rules; `untyped JSON`; no `!`, `(each present)` or `(got N)` in the tree; the denied leaf `✕ email  denied · pii.contact`; a description only when it fits whole.
- **Duplicate information.** The notes strip shows facts omitted elsewhere; one glyph (`◆`) for personal data in the tree and the strip. Haiku is told access and policy are out of scope (the pane computes and shows them) and describes only what the call does.
- **Hierarchy and color.** Violet (`autoAccept`) marks bars, the summary box, and card outlines. Blue identifies clickable record keys and URL tips. The meter only when something is masked or denied; the header rule one plain rule; services by display name.
- **Alignment.** RESULT's preview text starts at the value column where the key leaves room; text after a glyph at column 2; one list reads count then noun; denial tags line up in a column.
- **Record card.** A preview row's card is titled by its key and place (`DEV-467 · issue 2 of 5`), then the summary wrapped, the fields the row kept (with the top-level scalars of an opaque JSON field, and the name of each object there, `fields.status.name`; at most 12, values at most 80 characters, escaped) except any that repeats the key or the summary, a denied field with its classification, and the URL the row opens.
- **Planner.** `textRows` wraps as the surface does (`wrapLines`: a run of spaces counts at its real length); a return-tree line and a root's header row are counted as the flex rows they are (`flowRows`: each Text moves whole to the next row when it does not fit); argument values are counted as drawn (layout spaces compacted); RESULT's errors and auth links are counted at the note column's width, a settled auth link as one row; an open field drawer as drawn (its title row, its rows indented under it, no border) and the open name's `▾`. From the same counts the plan anchors each hover card on its trigger's rows (`Plan.anchors`). `tests/parity.test.ts` holds the plan's RESULT rows to the drawn rows at every width from 16 to 100, and from 32 the whole pane's and every card's anchor.

## Glyphs and color (Oct 6 2026)

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
| Structure | `BLOCK_HUE` → `autoAccept` (violet) | the `┃` bars, summary border, and hover-card outline and title |
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

Cards appear beside their triggers. Earlier versions placed them at the pane's foot, where tall panes could put them off screen. `Plan.anchors` records trigger rows by `cardId` (`src/view/plan.ts`): field and argument names, default arguments, root verbs, fold markers, policy counts, flags, links, RESULT controls and values, the receipt, and header items including the Haiku credit.

Position cards against the visible window (`scroll.offset`, `scroll.bodyRows`), or the full pane when there is no window. Choose below the trigger when that side has at least as much space as above; otherwise choose above. Clip cards taller than the available space. Include every row of a wrapped trigger, including a flags button or root header, so the card does not cover it. Cards start two cells in and end inside the pane's blank last column, leaving block bars and `⚑` visible.

Cards are direct children of the pane's root Box, after the content rows, with `position: "absolute"`. Later siblings paint over earlier ones. Wrappers are unsuitable: the engine clips absolute Boxes to zero-height parents, and treats the pointer over an absolute Box as being over its parent. A card below its trigger uses `top = last trigger row + 1`; a card above uses `bottom` relative to the pane's last row, without requiring its height in advance.

Cards use `display: none` until their hover group activates. They have a block-colored outline and opaque `PANEL` (`userMessageBackground`) fill. Absolute positioning leaves content rows in place, and membership in the hover group keeps the card visible while the pointer rests on it. Omit cards for hidden triggers, such as fields removed from the tree or objects that are not folded.

A RESULT row opens its own URL tip over its summary. Its `▸` opens the full-text and fields card, positioned below the list's last row or above its header according to available space. This placement keeps sibling rows visible.

The policy card opens from the meter or its replacement text (`✓ all N allowed`, `✓ write allowed`). Its title includes the field count (`policy · 1 field`). For an allowed write it states the decision first, then lists policy counts, masked, denied, and unchecked paths, and `no scopes required by the schema` when applicable.

`src/view/card-facts.ts` derives card content from parsed operations, schema data, and results. Field cards include:

- The full description, or `no description in the schema`.
- The GraphQL type and its meaning, such as `[Jira_Issue!]!: a list, never null, of issues that are never null`, with an explanation of the notation.
- Paging roles (`pagingRole` in `src/view/paging.ts`): continuation tokens, last-page flags, offsets, totals, and page sizes. `nextPageToken` is passed back for the next page; `isLast` is true on the last page.
- Policy, classification, requestability, personal-data annotations, deprecation, and required scopes or `no scopes listed in the schema`.
- After execution, returned values, counts, and initial values from previewed rows.

Argument cards explain whether the input is a JQL or CQL query, cursor, offset, page size, or ID. Badge cards explain operation types and approval; service cards identify services and their roots. Operation-name cards explain that the agent chooses the name and that it does not affect execution. The Haiku credit card identifies the operation and schema as headline inputs. RESULT count cards explain totals, limits, `first page`, `more available`, and continuation.

**Wrapping.** The planner counts wrapped identifiers and content. `nameRows` breaks long names after `_ . - /` or before capitals and continues the tree guide. `seamRows` uses these break points when an alias or mark reduces the available width, keeping `members:` with its field name where possible. Scopes, types, drawer and card titles, RESULT keys and expanded fields, link labels, and RowTip URLs wrap too. Closed RESULT rows and URLs exceeding a tip's available rows use the documented truncation limits; descriptions and hosts are omitted when they cannot fit in full. Count two cells for wide emoji such as `✅ ✨ ⭐` and `✔️`.

## Provenance, the standing line and the transcript (Oct 6 2026)

**Call origin.** A call a subagent made has one line under the trust line, in the note column: `↳ from subagent · Explore: find naming pages` (the agent's type, a colon and the task it was given). It wraps and the planner counts it (`Plan.agent`, card `p:agent`); the task is a model's text, so it is escaped and bounded when recorded and escaped again when drawn. While the agent list has not answered, or does not know the agent, the line says `from subagent` alone. Its card says what a subagent is, gives the label whole, and says the call is checked like any other. The main loop's own calls draw nothing.

**Standing line and spinner.** `$.ui.status` carries `Agent Services · 5 calls · 212 KB read · 3 trust rules · 2 ran unasked`: session counts and sizes, hidden when there is nothing to count. The spinner reads a running call's headline in place of its word only while the call runs without a permission dialog (see docs/spikes.md).

**The transcript's RESULT** uses the pane's styling (`┃ RESULT`, the rows line on the label row, the first three records under it, keys as links, `… N more`) but is not drawn by the planner: it has no width to plan against, so nothing in it is cut and its text wraps. It carries no hover cards (a card is placed against the pane's own rows); the pane has them all.

## Context receipts (Oct 6 2026)

Receipts measure response size and identify its largest fields. `src/weight.ts` computes them from the response; `src/view/receipt.ts` formats the result. The token estimate is compact JSON UTF-8 bytes divided by four. It approximates response size; it does not measure Claude's actual context or tokenizer output.

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
│ bytes divided by four.                                     │
│ issues.fields.description                                   │
│ takes    41 KB · 89% of the response · 40 rows,             │
│          about 1 KB each                                    │
│ Without issues.fields.description this result would be      │
│ about 4.8 KB (about 1.2k tokens).                           │
│ inside untyped JSON: the schema does not describe it        │
╰─────────────────────────────────────────────────────────────╯
```

- **Measurement.** Count compact JSON (`JSON.stringify`, no added whitespace) encoded as UTF-8. One KB is 1,024 bytes, matching Claude Code's `Output too large (58.2KB)`. The total includes data, errors, and extensions. Compact serialization makes responses comparable but excludes any extra whitespace the service sent. Estimated tokens are bytes divided by four and displayed as `about`; content and tokenizer affect the actual count.
- **A field** is its path, list indices dropped (as the error grouping drops them), every row of a list summed: `issues.fields.description` is all fifty descriptions. Each is named by its real field name through the IR (an alias reads as the field it is); a key inside untyped JSON stays as the response wrote it. A field of a list item has `rows` (the nearest list on its path, its own included), so a row costs `bytes / rows`. The response's own `errors` and `extensions` are fields too, marked `isMeta`: denial tokens repeated on each row contribute to the size.
- **Field selection** (`explain` in `src/weight.ts`). Consider fields holding at least 10% of the response. Recurse into qualifying children when their combined size is at least half the parent's; otherwise report the parent. Keep at most five, ordered by size. Omit a call's sole root from the leading size annotation and dominant-field flag, since it represents the whole result.
- **The line** is RESULT's last, dim, one row and wrapping (the planner counts it as `weight`, and sheds it first of RESULT's lines: `result-weight`, after `summary-credit`, before the form is cut). `size · about N tokens`, then the heaviest field and its share when it holds at least 30% of a response of at least 1 KB, unless the flag below already names it (each fact once: the sample above is flagged, so its line ends at the tokens). A member of the response beside the data reads in plain words (`errors.extensions.denial_context` is `denial tokens`, `metaWords` in `src/view/receipt.ts`); its card keeps the path. Words that belong together do not break (`58 KB`, `about 14k tokens`). Its card (`cardId.weight`, `k:weight`) lists each named field: path, size, share, rows and what a row costs, what the result would be without it (`Without issues.fields.description this result would be about 17 KB`), and its schema description, or that it is inside untyped JSON (the schema does not describe it) or part of the GraphQL response beside the data.
- **The flag** (`src/view/flags.ts`, with the over-the-limit flags): one field over half of a result over 16 KB, `issues.fields.description is 71% of a 58 KB result`; the card says what it would be without it.
- **A result Claude Code kept out of the context** (`<persisted-output>`, `isTooLarge`): the flag says it in the unit RESULT does, `response kept out of Claude's context · about 58 KB`, never characters. Claude saw only a short preview and the file's path, so the line says `58 KB saved to a file · Claude saw only a short preview and its path`, sized from the saved file when the mod read it back (the weight is `isPersisted`, and the rows and fields are the file's), else `about 58 KB` from Claude Code's own figure with no fields. RESULT then has this line and nothing else when nothing was read back. Such a response is not counted as read in the standing line.
- **The transcript's first line** carries the size after what came back (`5 issues · first page · 58 KB`), only where there is a first line to carry it. **The standing line** adds the bytes of the responses read, `Agent Services · 5 calls · 212 KB read`, after the calls; a call whose response was not read (an error, an oversized result kept out of the context) adds none.
- **Storage bounds.** The weight on the outcome is at most five fields (names cut at generous bounds), because the response itself is not kept. The walk tracks at most 2,000 distinct paths and 10 levels; past those a value's bytes stay in the field above it (`isCapped`), and the total stays exact.

## Write preview, v1 (Oct 7 2026)

For a mutation, CHANGES previews the proposed values before RESULT and the form, after the flags, trust, and subagent lines. `src/preview/` derives it from the call's arguments and schema. It does not read current records or call `execute`. The shapes it reads are the Agent Services schema as read on Oct 7 2026. A read of the current state would be a separate decision that would first change the hard rule that the mod never calls `execute`.

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
- **Bodies.** A body that is one short line is a value (`+ text  Deploy done`). Any other is its row (`+ body  11 lines · page markup`, the count and format held together with non-breaking spaces; the format in plain words, `rich text`, `page markup`, `Slack markup`, `plain text`, its technical name on the row's card) and its first lines under it, each with its sign, the text two cells further in (column 6) so the lines read as their row's, wrapped and never cut, up to a budget of rows (8, shed to 3, then none: `BODY_ROWS`), at least one line when the budget is not none; then `N more lines` dim. Display a final line that fits one row. When body lines are hidden, the row still shows their count.
- **Notes.** Dim, at the block's foot: `new values only · current state not read` for a change, `not read first · its contents are not shown` for a delete, what a recoverable delete leaves (`Confluence moves a deleted page to its space's trash, where it can be restored`), what an edit keeps (Slack's blocks and attachments). A create has none: there is no current state.
- **Flags** go on the flags line (computed, `previewFlags`): `@channel` / `@here` / `@everyone` (`<!…>` tokens and blocks' broadcast elements), `replyBroadcast` on a reply, another name or icon, `notifyUsers: false`, Jira's admin overrides, `deleteSubtasks`, and `cannot be undone` for a delete with no trash. The flags card says each in full. A mutation the table does not know reads its `notify…` and `override…` switches as the table reads Jira's: no CHANGES row (they steer the write; the form keeps them), a flag when one tells nobody or overrides, described using the argument name and schema (`notifyIncidentChannel false: the incident channel is not told`).
- **Duplicate annotations.** A root with a CHANGES block says that it writes there: the flags line drops `writes data` for it, and the name-guessed `destructive: <root>` when the block is a delete (its own `cannot be undone` and `also deletes its subtasks` stay); the root's `▴` stays, with no words after it (`rootReason` in `src/attention.ts`). A root with no block (a query named for a change, a write the preview could not read) keeps both.
- **Policy on a write.** The header's second row says the decision on the write, `✓ write allowed` (`✓ allowed` short of room), when Agent Services allows its roots and nothing it returns is masked or denied (`isWriteAllowed` in `src/view/outcome.ts`; a root with no decision of its own counts as allowed when every field in it is). The counts and the meter come back only when a returned field is masked or denied; the words light the policy card as the meter would. The transcript line says no `✓ … allowed` for such a write: policy shows there only as a flag.
- **Arguments shown in CHANGES.** Under a root with a CHANGES block, the arguments its rows show (each row's `card.arg`) are not rows of the form: one dim `in CHANGES` row, in the `return type` row's style, names them ` · ` apart, each name lighting its own argument's card (`RootPlan.inChanges`, counted as the flow it is). The arguments that name the target (`issueIdOrKey`, `id`) and those that steer the change rather than being part of it (`notifyUsers`, `bodyRepresentation`, `deleteSubtasks`, the overrides) stay rows of their own.

  ```text
  ┃ UPDATE        ▴ jira_editIssue
  issueIdOrKey  DEV-634
  notifyUsers   false
  in CHANGES    fields · update
  return type   untyped JSON
  ```
- **Cards** (`src/view/diff.tsx`): the section (`x:`): what the block is and how it was read, in the reader's words with no internals (`Read with a built-in mapping for jira_doTransition: issueIdOrKey names the issue; each row's card says what its argument means.`, or read from the call and the schema), what the signs mean; the target (`y:`): each argument that names it with its type and description, and what that kind of id is (a Jira key, a Confluence id, a Slack channel and ts); each row (`z:`, the whole row and its lines): what the new value means, the sign, where it is in the call, the argument's type in notation and words (`arg type` for a field inside it), the schema's description or that it sits in untyped JSON or an input object, and for a body its format, line count, links and mentions. The notes light the section's card too.
- **The planner** (`changesPlanOf` in `src/view/plan.ts`) counts every row (header, label rows, value rows, body lines, counts, notes) and anchors every card; `tests/parity.test.ts` holds planned rows to drawn rows from 32 to 100 columns, and each anchor to its trigger's rows, on a Jira transition, a field edit with ADF, a Confluence page update with a storage body (pending and settled), a Slack post with `@channel`, a delete and an unmapped mutation. Shedding: `change-lines` (after `soft-notes`) cuts the body budget to 3 rows; `change-lines-all` (after `returns-lines`) to none. The rows themselves never go.
- **Preview computation.** `previewOf(ir)` is memoized on the IR's roots, so the pane, the flags line and the transcript line read one model; a 300 KB storage body flattens in under 20 ms. Everything in it is escaped except `ChangeRow.back`, the raw value RESULT compares with, never drawn. Bounds: 24 rows a block (`N more` counts the rest), 256 KB, 20,000 ADF nodes and depth 64 per body, 5,000 lines kept, 4,000 characters a line, 20 links and mentions.
- **Stored read mappings.** Each hand-mapped write stores the read that would fetch its current state (`Mapping.read`: one named query built from the schema, the call's values only as variables, with a value transform for `bodyFormat ← bodyRepresentation` and a projection for Jira's `fields`), and before/after pairs; unit tests hold every stored read to the read-only floor. `ChangeRow.before` and `ChangeBlock.current` are where a read's result would go. These reads are never executed. Running them would require an explicit change to the rule prohibiting inspector `execute` calls.

**The transcript line** (`src/view/notice.ts`) leads a write with its change in a few words, `✎` and the mapping's phrase (`DEV-634 → transition 31`, `edits page 123456789: title, body, version, version note`: four changed labels are named, past four three and `+N more`, `posts to C0123`), from the call's arguments alone, so it is there while the policy is still being checked (`✎ posts to C0123 · writes Slack`). Then the policy part, then what it writes; no root name and no `writes data` (the change leads and the line ends in `writes Jira`): `✎ deletes DEV-634 · ⚑ cannot be undone · also deletes its subtasks · writes Jira`.

**Response confirmation.** `src/preview/confirm.ts` records returned values corresponding to proposed changes (`confirms`, at most 12, escaped): the same (`version 13 ✓`), different (`title came back as …`, with what was sent for the card; a body that differs is not quoted, since a service normalizes markup), or the record a create made (`created message 1728.0001`). RESULT leads with it on a line of its own (`v:` card), drawn as CHANGES says its rows: the labels dim, the values bold, `✓` in the allow hue and a difference in the mask hue; it drops a scalar it already says; the transcript's RESULT block leads with it too. Only what the model selected can be compared, under its aliases; inside opaque JSON (an edit with `returnIssue`) the response's own keys are read.
