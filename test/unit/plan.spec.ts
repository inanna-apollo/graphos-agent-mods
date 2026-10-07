import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { accessOf } from '../../src/gas.ts'
import type { CallIR } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { indexSdl } from '../../src/schema.ts'
import { annotationIndex } from '../../src/view/annotations.ts'
import { CLOSED } from '../../src/view/kit.ts'
import { cellWidth, isNeverShed, moreLabel, nameRows, planOf, returnLines, shedOrder, textRows } from '../../src/view/plan.ts'
import type { Plan, PlanOptions } from '../../src/view/plan.ts'

// ---- Fixtures, built as the pipeline builds them

const CONFLUENCE_OP = `query SearchQueryPlanPages($cql: String!, $limit: Int) { confluence_search(cql: $cql, limit: $limit) { results { title excerpt url lastModified content { id type } } totalSize } }`
const CONFLUENCE_VARS = { cql: 'type=page AND text ~ "query plan" ORDER BY lastmodified DESC', limit: 10 }
const CONFLUENCE_SDL = [
  'type Query {\n  """\n  Search. Requires the search:confluence and read:confluence-content.summary scopes.\n  """\n  confluence_search(cql: String!, cursor: String, limit: Int): Confluence_SearchResult\n}\n',
  'type Confluence_SearchContent {\n  id: ID\n  type: String\n}\n',
  'type Confluence_SearchResultItem {\n  title: String\n  excerpt: String\n  url: String\n  lastModified: String\n  content: Confluence_SearchContent\n}\n',
  'type Confluence_SearchResult {\n  results: [Confluence_SearchResultItem!]\n  totalSize: Int\n}\n',
]
const CONFLUENCE_DRY = {
  denyOperation: false,
  fields: [
    { decision: 'allow', path: 'confluence_search' },
    { decision: 'allow', path: 'confluence_search.results' },
    { decision: 'allow', path: 'confluence_search.results.title' },
    { decision: 'mask', path: 'confluence_search.results.excerpt' },
    { decision: 'allow', path: 'confluence_search.results.url' },
    { decision: 'allow', path: 'confluence_search.results.lastModified' },
    { decision: 'allow', path: 'confluence_search.results.content' },
    { decision: 'allow', path: 'confluence_search.results.content.id' },
    { decision: 'allow', path: 'confluence_search.results.content.type' },
    { decision: 'allow', path: 'confluence_search.totalSize' },
  ],
}

function confluence(withSummary = true): CallIR {
  const ir = annotate(buildIR('t1', normalize(CONFLUENCE_OP, CONFLUENCE_VARS)), {
    schema: indexSdl(CONFLUENCE_SDL),
    access: accessOf(CONFLUENCE_DRY),
    validation: { valid: true, diagnostics: [] },
    scope: 'confluence',
    isIncomplete: false,
  })
  if (!withSummary) return ir
  return {
    ...ir,
    summary: {
      headline:
        'Searches Confluence for pages mentioning "query plan", newest first, up to ten [[Confluence_SearchResultItem.title]] hits.',
      details: [],
      concerns: [],
    },
  }
}

// Three roots, deep nesting, personal data, masked and denied fields, no limit
// on two lists, a large limit on a third, many scopes and a will-fail diagnostic.
const JIRA_OP = `query TriageBoard($jql: String!) {
  jira_searchIssues(jql: $jql, first: 500) {
    issues {
      key summary
      status { name category { key colorName } }
      assignee { displayName emailAddress accountId timeZone }
      reporter { displayName emailAddress }
      fields {
        labels priority { name iconUrl }
        comments { body created author { displayName emailAddress } }
        components { name lead { displayName } }
      }
    }
    total
  }
  jira_listProjects { projects { key name lead { displayName emailAddress } } }
  jira_listBoards { boards { id name } }
}`
const JIRA_VARS = {
  jql: 'project in (DEV, OPS, CORE) AND status not in (Done, Closed) AND assignee was currentUser() AND labels in (triage, release) AND updated >= -14d ORDER BY priority DESC, updated DESC',
}
const SCOPES = 'Requires the read:jira-work, read:jira-user, read:issue-details:jira, read:comment:jira, read:project:jira and read:board-scope:jira-software scopes.'
const JIRA_SDL = [
  `type Query {\n  """\n  Search issues with JQL. ${SCOPES}\n  """\n  jira_searchIssues(jql: String!, first: Int): Jira_IssueConnection\n  """\n  List projects. Requires the read:project:jira scope.\n  """\n  jira_listProjects(limit: Int): Jira_ProjectList\n  jira_listBoards(limit: Int): Jira_BoardList\n}\n`,
  'type Jira_IssueConnection {\n  issues: [Jira_Issue!]\n  total: Int\n}\n',
  'type Jira_Issue {\n  key: String\n  summary: String\n  status: Jira_Status\n  assignee: Jira_User\n  reporter: Jira_User\n  fields: Jira_Fields\n}\n',
  'type Jira_Status {\n  name: String\n  category: Jira_StatusCategory\n}\n',
  'type Jira_StatusCategory {\n  key: String\n  colorName: String @deprecated(reason: "use color")\n}\n',
  'type Jira_User {\n  displayName: String\n  emailAddress: String\n  accountId: ID\n  timeZone: String\n}\n',
  'type Jira_Fields {\n  labels: [String]\n  priority: Jira_Priority\n  comments: [Jira_Comment!]\n  components: [Jira_Component!]\n}\n',
  'type Jira_Priority {\n  name: String\n  iconUrl: String\n}\n',
  'type Jira_Comment {\n  body: String\n  created: String\n  author: Jira_User\n}\n',
  'type Jira_Component {\n  name: String\n  lead: Jira_User\n}\n',
  'type Jira_ProjectList {\n  projects: [Jira_Project!]\n}\n',
  'type Jira_Project {\n  key: String\n  name: String\n  lead: Jira_User\n}\n',
  'type Jira_BoardList {\n  boards: [Jira_Board!]\n}\n',
  'type Jira_Board {\n  id: ID\n  name: String\n}\n',
]
const JIRA_DRY = {
  denyOperation: false,
  fields: [
    { decision: 'allow', path: 'jira_searchIssues' },
    { decision: 'allow', path: 'jira_searchIssues.issues' },
    { decision: 'allow', path: 'jira_searchIssues.issues.key' },
    { decision: 'mask', path: 'jira_searchIssues.issues.assignee.emailAddress' },
    { decision: 'mask', path: 'jira_searchIssues.issues.reporter.emailAddress' },
    { decision: 'deny', path: 'jira_searchIssues.issues.assignee.accountId' },
    { decision: 'deny', path: 'jira_searchIssues.issues.fields.comments.author.emailAddress' },
    { decision: 'allow', path: 'jira_listProjects' },
    { decision: 'allow', path: 'jira_listBoards' },
  ],
}

function jira(): CallIR {
  const ir = annotate(buildIR('t2', normalize(JIRA_OP, JIRA_VARS)), {
    schema: indexSdl(JIRA_SDL),
    access: accessOf(JIRA_DRY),
    validation: { valid: false, diagnostics: ['Error: type `Jira_Board` does not have a field `owner`'] },
    scope: 'jira',
    isIncomplete: false,
  })
  return {
    ...ir,
    summary: {
      headline:
        'Searches up to 500 Jira issues in DEV, OPS and CORE that are open, assigned to you and labelled for triage, with their status, people, comments and components, and also lists every project and board.',
      details: [],
      concerns: [],
    },
  }
}

const COLUMNS = 50
const options = (rows: number, extra: Partial<PlanOptions> = {}): PlanOptions => ({ rows, columns: COLUMNS, isPending: true, open: CLOSED, now: 0, ...extra })
const ROWS = [40, 25, 15, 10] as const
const FIXTURES = { confluence, jira } as const

// ---- Invariants

function assertNeverShed(ir: CallIR, plan: Plan) {
  assert.ok(plan.header >= 1 && plan.header <= 2, 'the header is a row, and a second for the policy')
  assert.equal(plan.rule, 1)
  assert.ok(plan.summary.lines >= 1, 'the summary keeps its first line')
  assert.equal(plan.roots.length, ir.roots.length, 'every root is drawn')
  for (const root of plan.roots) assert.ok(root.rootRows >= 1, `root ${root.path} keeps its name`)
  const shown = new Set(plan.notes.shown.map(note => note.index))
  plan.notes.all.forEach((note, index) => {
    if (isNeverShed(note)) assert.ok(shown.has(index), `never-shed note kept: ${note.text}`)
  })
}

function assertOrdered(plan: Plan) {
  const order = shedOrder(plan.result.lines.length > 0)
  const ranks = plan.shed.map(kind => order.indexOf(kind))
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok((ranks[i] ?? 0) >= (ranks[i - 1] ?? 0), `shed out of order: ${plan.shed.join(', ')}`)
  }
}

function assertCounts(ir: CallIR, plan: Plan) {
  const notes = plan.notes.all
  assert.equal(plan.notes.more, notes.length - plan.notes.shown.length, 'notes +N more')
  const last = plan.notes.shown.at(-1)
  if (plan.notes.more > 0) assert.equal(last?.more, plan.notes.more, 'the last note carries the +N more')
  for (const shown of plan.notes.shown) {
    const names = notes[shown.index]?.names?.length ?? 0
    assert.ok(shown.names <= names, 'never lists more names than there are')
  }
  plan.roots.forEach((root, r) => {
    const field = ir.roots[r]!
    for (const arg of root.args) assert.equal(arg.more, arg.lines - arg.maxLines, `${arg.name}: … N more lines`)
    assert.equal(root.access.more, root.access.scopes.length - root.access.needs, 'ACCESS +N')
    const pins = annotationIndex(ir, plan.annotations)
    const all = returnLines(field, root.returns.isCollapsed, Infinity, one => pins.field(one.coordinate))
    assert.equal(root.returns.more, all.length - root.returns.lines.length, 'RETURNS … N more')
  })
}

for (const [name, fixture] of Object.entries(FIXTURES)) {
  const ir = fixture()
  const floor = planOf(ir, options(0)).total

  for (const rows of ROWS) {
    test(`${name} at ${rows} rows: never-shed items stay, shedding is ordered, counts are right`, () => {
      const plan = planOf(ir, options(rows))
      assertNeverShed(ir, plan)
      assertOrdered(plan)
      assertCounts(ir, plan)
      // Fits whenever the fully shed pane does.
      assert.ok(plan.total <= Math.max(rows, floor), `${plan.total} rows planned for ${rows} (floor ${floor})`)
      if (floor <= rows) assert.ok(plan.fits)
    })
  }

  test(`${name}: fewer rows shed a longer prefix of the same ladder`, () => {
    const plans = ROWS.map(rows => planOf(ir, options(rows)))
    for (let i = 1; i < plans.length; i += 1) {
      const wide = plans[i - 1]!.shed
      const narrow = plans[i]!.shed
      assert.deepEqual(narrow.slice(0, wide.length), wide)
    }
  })
}

test('confluence: a tall pane sheds nothing and shows everything', () => {
  const ir = confluence()
  const plan = planOf(ir, options(Infinity))
  assert.deepEqual(plan.shed, [])
  assert.equal(plan.summary.hasCredit, true)
  assert.equal(plan.roots[0]!.returns.isCollapsed, false)
  assert.equal(plan.roots[0]!.access.needs, 2)
  assert.equal(plan.summary.rows, plan.summary.lines + 3, 'the box counts its two border rows and the eyebrow above it')
})

test('confluence: what only fills room goes first, then the rest of the ladder', () => {
  const ir = confluence()
  const tall = planOf(ir, options(Infinity))
  // What only fills spare room (descriptions, hints, defaults, paging, preview) goes before the credit.
  const FILL = ['root-description', 'arg-hints', 'result-preview', 'default-args', 'paging-line']
  const one = planOf(ir, options(tall.total - 1))
  assert.ok(one.shed.length > 0 && one.shed.every(kind => FILL.includes(kind)), one.shed.join(', '))
})

const OUTCOME = {
  rows: [{ field: 'results', count: 10, total: 3766 }],
  errors: [{ message: 'Field excerpt is masked', code: 'FORBIDDEN', path: 'confluence_search.results.excerpt', isDenied: true }],
  authLinks: [{ service: 'confluence', url: 'https://example.atlassian.net/link' }],
}

test('a settled call gets RESULT, and keeps all of it however short the pane: the form is trimmed, the rest scrolls', () => {
  const ir = confluence()
  const settled = (rows: number) => planOf(ir, options(rows, { isPending: false, outcome: OUTCOME }))
  const kinds = (rows: number) => settled(rows).result.lines.map(line => line.kind)
  assert.deepEqual(kinds(Infinity), ['error', 'auth', 'rows'])
  assert.deepEqual(kinds(8), kinds(Infinity))
  const pending = planOf(ir, options(Infinity, { outcome: OUTCOME }))
  assert.equal(pending.result.rows, 0, 'no RESULT while the call waits')
})

test('jira at 25 rows: ACCESS shows one scope and +N; the JQL is cut to three lines', () => {
  const plan = planOf(jira(), options(25))
  const search = plan.roots[0]!
  assert.ok(plan.shed.includes('access-needs'))
  // Roots on one service share one ACCESS, drawn after the last root with the union of scopes.
  const last = plan.roots.at(-1)!
  assert.equal(search.access.isMerged, true)
  assert.equal(search.access.rows, 0)
  assert.equal(last.access.isMerged, undefined)
  assert.equal(last.access.needs, 1)
  assert.equal(last.access.more, last.access.scopes.length - 1)
  assert.equal(new Set(last.access.scopes).size, last.access.scopes.length, 'de-duplicated')
  const jql = search.args.find(arg => arg.name === 'jql')!
  assert.ok(jql.lines > 3)
  assert.equal(jql.maxLines <= 3, true)
  assert.equal(jql.more, jql.lines - jql.maxLines)
})

test('jira: soft notes past the second go; the headline is never cut', () => {
  const ir = jira()
  const tall = planOf(ir, options(Infinity))
  const isSoftNote = (plan: Plan, index: number) => ['◆', '↯'].includes(plan.notes.all[index]!.glyph)
  const soft = (plan: Plan) => plan.notes.all.filter((_, index) => isSoftNote(plan, index)).length
  const kept = (plan: Plan) => plan.notes.shown.filter(shown => isSoftNote(plan, shown.index)).length
  const plans = Array.from({ length: 70 }, (_, at) => planOf(ir, options(20 + at)))
  for (const plan of plans) {
    // Until the last resort, two soft notes stay.
    if (!plan.shed.includes('soft-notes-all')) assert.ok(kept(plan) >= Math.min(2, soft(plan)), plan.shed.join(', '))
    // Near the summary only the eyebrow may go; the headline keeps every line.
    assert.ok(!plan.shed.some(kind => kind.startsWith('summary-') && kind !== 'summary-credit'))
    assert.equal(plan.summary.lines, tall.summary.lines)
  }
  // Somewhere the strip is cut to two soft notes and says how many more there were.
  const cut = plans.find(plan => plan.shed.includes('soft-notes') && !plan.shed.includes('soft-notes-all') && soft(plan) > 2)
  assert.ok(cut !== undefined, 'a height where the soft notes are cut to two')
  assert.equal(kept(cut), 2)
  assert.equal(cut.notes.more, soft(cut) - 2)
})

test('jira: a marked field has its line in the strip only while no return tree draws it', () => {
  const ir = jira()
  const tall = planOf(ir, options(Infinity))
  // Every masked, denied and personal field is on a tree line with its mark: the strip says none of them.
  assert.ok(!tall.notes.all.some(note => ['✕', '◐', '◆'].includes(note.glyph)), tall.notes.all.map(note => note.text).join(', '))
  // Folded away, they have no other home: the strip says each once.
  const folded = planOf(ir, options(60))
  assert.ok(folded.roots.some(root => root.returns.isCollapsed))
  assert.ok(folded.notes.all.some(note => note.glyph === '✕' && note.text === 'accountId'))
})

test('confluence fits down to the rows its shed form needs; blank rows between sections are the last to close up', () => {
  const at25 = planOf(confluence(), options(25))
  assert.ok(at25.fits)
  assert.equal(at25.gap, 1)
  const at22 = planOf(confluence(), options(22))
  assert.ok(at22.fits)
  assert.equal(at22.summary.lines, planOf(confluence(), options(Infinity)).summary.lines, 'the headline keeps every line')
  // With every row shed that can be, the pane still fits what it needs: the blocks have closed up, and stay closed.
  const least = planOf(confluence(), options(1)).total
  assert.ok(least <= 22)
  const atLeast = planOf(confluence(), options(least))
  assert.ok(atLeast.fits)
  assert.equal(atLeast.gap, 0)
  assert.ok(at25.gap >= at22.gap && at22.gap >= atLeast.gap)
})

test('jira at 10 rows: the will-fail, denied and masked notes and every root survive', () => {
  const ir = jira()
  const plan = planOf(ir, options(10))
  const texts = plan.notes.shown.map(shown => `${plan.notes.all[shown.index]!.text}  ${plan.notes.all[shown.index]!.detail ?? ''}`)
  assert.ok(texts.some(text => /^will fail/.test(text)))
  assert.ok(texts.some(text => /denied/.test(text)))
  assert.deepEqual(
    plan.roots.map(root => root.path),
    ['jira_searchIssues', 'jira_listProjects', 'jira_listBoards'],
  )
  assert.ok(plan.summary.lines >= 1)
})

test('no footer or drawers in the plan: the rows go to the form', () => {
  const settled = planOf(confluence(), options(Infinity, { isPending: false }))
  assert.equal('footer' in settled, false)
  assert.equal('drawers' in settled, false)
})

test('access takes a row only when it says something: no placeholder while analyzing', () => {
  const ir = buildIR('t3', normalize(CONFLUENCE_OP, CONFLUENCE_VARS))
  assert.equal(planOf(ir, options(Infinity)).roots[0]!.access.rows, 0)
  assert.ok(planOf(confluence(), options(Infinity)).roots[0]!.access.rows > 0)
})

test('sectionGap widens every section gap, and the plan still fits', () => {
  const terminal = planOf(confluence(), options(Infinity))
  const desktop = planOf(confluence(), options(Infinity, { sectionGap: 1 }))
  assert.equal(desktop.gap, 2)
  assert.ok(desktop.total > terminal.total)
  assert.ok(planOf(confluence(), options(25, { sectionGap: 1 })).fits)
})

test('an annotated leaf breaks out onto its own row; the leaves around it stay joined', () => {
  const root = confluence().roots[0]!
  const plain = returnLines(root)
  const notes = new Map([['Confluence_SearchResultItem.url', { note: 'link to the page', isAttention: false }]])
  const lines = returnLines(root, false, Infinity, field => notes.get(field.coordinate))
  const url = lines.find(line => line.fields.length === 1 && line.fields[0]!.name === 'url')
  assert.equal(url?.annotation?.note, 'link to the page')
  const joined = lines.filter(line => line.fields.length > 1).map(line => line.fields.map(field => field.name))
  assert.ok(joined.some(names => names.includes('title') && names.includes('excerpt') && !names.includes('url')))
  assert.ok(lines.length > plain.length)
  // The same tree: totalSize stays a sibling of results.
  const results = lines.find(line => line.head?.name === 'results')!
  const total = lines.find(line => line.fields.some(field => field.name === 'totalSize'))!
  assert.equal(total.prefix.length, results.prefix.length)
})

test('the headline keeps all its lines at every height; only its credit may drop', () => {
  for (const make of [confluence, jira]) {
    const ir = make()
    const full = planOf(ir, options(Infinity)).summary
    assert.ok(full.lines > 2, 'a long headline wraps to several lines')
    for (const rows of [30, 20, 15, 10, 6, 1]) {
      const plan = planOf(ir, options(rows))
      assert.equal(plan.summary.lines, full.lines, `${rows} rows`)
      assert.ok(!plan.shed.includes('summary-lines' as never) && !plan.shed.includes('summary-first-line' as never))
      // The eyebrow row is the only part that may go.
      assert.equal(plan.summary.rows, plan.summary.lines + 2 + (plan.summary.hasCredit ? 1 : 0))
    }
  }
})

test('the headline slot is never empty: with no schema, summary or limit it is the root field name', async () => {
  const { buildIR } = await import('../../src/build.ts')
  const { normalize } = await import('../../src/normalize.ts')
  const { fallbackLine } = await import('../../src/view/kit.ts')
  const bare = buildIR('t', normalize('{ slack_searchMessages(query: "a") { messages { total } } }', {}))
  assert.equal(fallbackLine(bare), 'slack_searchMessages')
  const limited = buildIR('t', normalize('{ slack_searchMessages(query: "a", count: 4) { messages { total } } }', {}))
  assert.match(fallbackLine(limited), /^slack_searchMessages · asks for 4$/)
})

test('a pending call with no summary and no limit still plans a headline row, at every height', () => {
  const ir = buildIR('t', normalize('{ slack_searchMessages(query: "a") { messages { total } } }', {}))
  for (const rows of [40, 15, 6, 1]) assert.ok(planOf(ir, options(rows)).summary.lines >= 1, `${rows} rows`)
  const reading = { ...ir, isSummarizing: true }
  for (const rows of [40, 6, 1]) assert.ok(planOf(reading, options(rows)).summary.lines >= 1, `${rows} rows, summarizing`)
})

test('a collapsed object draws its fields inline when they fit, and folds only when they do not', () => {
  const boards = jira().roots.find(root => root.name === 'jira_listBoards')!
  const [wide] = returnLines(boards, true, Infinity, undefined, 'jira', 60)
  assert.deepEqual(wide!.fields.map(field => field.name), ['id', 'name'])
  assert.equal(wide!.fold, undefined)
  // Too narrow for `boards { id · name }` and its list note on one row: folded.
  const [narrow] = returnLines(boards, true, Infinity, undefined, 'jira', 14)
  assert.equal(narrow!.fields.length, 0)
  assert.match(narrow!.fold ?? '', /2 fields/)
  // A nested selection never inlines: it folds, its fields left to the fold card.
  const results = returnLines(confluence().roots[0]!, true, Infinity, undefined, 'confluence', 80).find(line => line.head?.name === 'results')!
  assert.match(results.fold ?? '', /\d fields/)
})

test('cells: emoji a terminal draws wide count two, the pane’s own glyphs one', () => {
  for (const wide of ['✅', '❌', '✨', '⚡', '⭐', '✔️', '⚠️']) assert.equal(cellWidth(wide), 2, wide)
  for (const narrow of ['✓', '✕', '◐', '◆', '⚑', '↗', '▰', 'a']) assert.equal(cellWidth(narrow), 1, narrow)
})

test('a name wider than its row breaks at its own seams, never cut, every row within the width', () => {
  const rows = nameRows('acme_customer_data_listOrganizationMembers', 30)
  assert.equal(rows.join(''), 'acme_customer_data_listOrganizationMembers')
  for (const row of rows) assert.ok(cellWidth(row) <= 30, row)
  assert.deepEqual(nameRows('nextPageToken', 20), ['nextPageToken'])
  assert.deepEqual(nameRows('nextPageToken', 10), ['nextPage', 'Token'])
})

test('the count under a long list is grouped as the list count is: `… 9,995 more` under `10,000 of 12,000`', () => {
  assert.equal(moreLabel({ more: 9995 }), '… 9,995 more')
  assert.equal(moreLabel({ more: 9995, expand: 'less' }), '… 9,995 more · show fewer')
  assert.equal(moreLabel({ more: 3 }), '… 3 more')
})
