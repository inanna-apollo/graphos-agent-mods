import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import { loadLinkConfig, previewLinkOf } from '../../src/links.ts'
import { normalize } from '../../src/normalize.ts'
import { NO_TEXT, outcomeOf, responseIn } from '../../src/result.ts'
import { indexSdl } from '../../src/schema.ts'
import { resultLines } from '../../src/view/outcome.ts'

const mcp = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: false })

const OPERATION =
  'query FindPages($cql: String!, $limit: Int) { pages: confluence_search(cql: $cql, limit: $limit) { results { title url } totalSize } }'
const IR = buildIR('t', normalize(OPERATION, { cql: 'type=page', limit: 10 }))

// Shapes as Agent Services returns them (trimmed).
const SEARCH_RESULT = {
  data: { pages: { results: Array.from({ length: 10 }, (_, i) => ({ title: `p${i}`, url: `/p${i}` })), totalSize: 3766 } },
}
const AUTH_REQUIRED = {
  data: null,
  errors: [
    { extensions: { code: 'SUBREQUEST_HTTP_ERROR', http: { status: 401 }, service: 'confluence' }, message: "HTTP fetch failed from 'confluence': 401: Unauthorized", path: [] },
    {
      extensions: {
        code: 'UPSTREAM_AUTH_REQUIRED',
        service: 'confluence',
        sources: [{ authorizationUrl: 'https://gas.example.com/auth/confluence/link', name: 'confluence' }],
      },
      message: 'Authorization required for source(s): confluence.',
      path: [],
    },
  ],
}

test('rows count the first list under a root, by real field name, with its sibling total', () => {
  const outcome = outcomeOf(IR, mcp(SEARCH_RESULT))
  // By the root's response key too: two roots' lists can share a field name.
  assert.deepEqual(outcome.rows, [{ field: 'results', count: 10, total: 3766, root: 'pages' }])
  assert.deepEqual(outcome.errors, [])
  assert.equal(outcome.hasData, true)
})

test('UPSTREAM_AUTH_REQUIRED becomes a link to follow, not an error line', () => {
  const outcome = outcomeOf(IR, mcp(AUTH_REQUIRED))
  assert.deepEqual(outcome.authLinks, [
    { service: 'confluence', url: 'https://gas.example.com/auth/confluence/link' },
  ])
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.errors[0]?.code, 'SUBREQUEST_HTTP_ERROR')
  assert.equal(outcome.hasData, false)
})

test('a non-https link is dropped', () => {
  const sneaky = structuredClone(AUTH_REQUIRED)
  sneaky.errors[1]!.extensions.sources![0]!.authorizationUrl = 'javascript:alert(1)'
  assert.deepEqual(outcomeOf(IR, mcp(sneaky)).authLinks, [])
})

test('a denied field error is marked as denied, with its path', () => {
  const outcome = outcomeOf(IR, mcp({ data: { pages: null }, errors: [{ message: 'denied', path: ['pages', 'results'], extensions: { denial_context: 'tok' } }] }))
  assert.deepEqual(outcome.errors, [{ message: 'denied', path: 'pages.results', field: 'results', isDenied: true, hasToken: true }])
})

test('anything that is not a GraphQL response is unreadable, never a throw', () => {
  assert.equal(outcomeOf(IR, mcp('not json')).isUnreadable, true)
  assert.equal(outcomeOf(IR, { content: [] }).isUnreadable, true)
  assert.equal(outcomeOf(IR, undefined).isUnreadable, true)
  assert.equal(outcomeOf(IR, mcp('[1,2]')).isUnreadable, true)
})

test('a result that is not a GraphQL response keeps its text, flat and bounded, as its one error line, and no data came back', () => {
  const timeout = outcomeOf(IR, mcp('upstream confluence\n  timed out after 30s'))
  assert.deepEqual(timeout.errors, [{ message: 'upstream confluence timed out after 30s' }])
  assert.equal(timeout.hasData, false)
  assert.equal(timeout.isTooLarge, undefined)
  const lines = resultLines(timeout, IR)
  assert.ok(lines.some(line => line.kind === 'error' && line.text === 'upstream confluence timed out after 30s'), JSON.stringify(lines))
  // JSON that is not an object says itself; a saved result's content blocks say the text inside them.
  assert.equal(outcomeOf(IR, mcp('[1,2]')).errors[0]?.message, '[1,2]')
  assert.equal(outcomeOf(IR, JSON.stringify([{ type: 'text', text: 'Bad gateway' }])).errors[0]?.message, 'Bad gateway')
  // Nothing to say is said as that.
  for (const empty of [undefined, { content: [] }, mcp(''), mcp('   ')]) assert.deepEqual(outcomeOf(IR, empty).errors, [{ message: NO_TEXT }], JSON.stringify(empty))
})

test('the text of an unreadable result is escaped and bounded: no control sequence, bidi override or invisible character survives, and a page of HTML is cut', () => {
  const hostile = outcomeOf(IR, mcp('\u001b[31mred\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 ‮evil‬ ​hidden \u0000nul'))
  const message = hostile.errors[0]?.message ?? ''
  assert.doesNotMatch(message, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮​-‏⁦-⁩]/)
  assert.match(message, /\\x1b\[31m/)
  assert.match(message, /\\u\{202e\}/)
  const page = outcomeOf(IR, mcp(`<html><body>${'<p>502 Bad Gateway</p>'.repeat(500)}</body></html>`)).errors[0]?.message ?? ''
  assert.ok(page.length <= 301, String(page.length))
  assert.ok(page.startsWith('<html><body><p>502 Bad Gateway'))
  // Cut between characters, never inside an emoji.
  const emoji = outcomeOf(IR, mcp('😀'.repeat(1_000))).errors[0]?.message ?? ''
  assert.doesNotThrow(() => encodeURIComponent(emoji))
})

test('a bare string result is read too', () => {
  assert.equal(outcomeOf(IR, JSON.stringify(SEARCH_RESULT)).rows[0]?.count, 10)
})

test('error messages are bounded, generously', () => {
  const outcome = outcomeOf(IR, mcp({ errors: [{ message: 'x'.repeat(5_000) }] }))
  const message = outcome.errors[0]?.message ?? ''
  assert.ok(message.length >= 300 && message.length < 1_000)
  assert.equal(outcomeOf(IR, mcp({ errors: [{ message: 'a short one' }] })).errors[0]?.message, 'a short one')
})

test('errors at no path are one line for each code and message, counted, and the lines an outcome keeps are bounded', () => {
  const same = Array.from({ length: 10_000 }, () => ({ message: 'Rate limited', extensions: { code: 'RATE_LIMITED' } }))
  const other = [{ message: 'Rate limited', extensions: { code: 'THROTTLED' } }, { message: 'Upstream down', extensions: { code: 'RATE_LIMITED' } }, { message: 'no code' }, { message: 'no code', path: [] }]
  const outcome = outcomeOf(IR, mcp({ data: null, errors: [...same, ...other] }))
  assert.deepEqual(
    outcome.errors.map(({ code, message, count }) => ({ code, message, count })),
    [
      { code: 'RATE_LIMITED', message: 'Rate limited', count: 10_000 },
      { code: 'THROTTLED', message: 'Rate limited', count: undefined },
      { code: 'RATE_LIMITED', message: 'Upstream down', count: undefined },
      { code: undefined, message: 'no code', count: 2 },
    ],
  )
  // Every message different: a safety bound on the lines kept, whatever a response says.
  const distinct = outcomeOf(IR, mcp({ data: null, errors: Array.from({ length: 5_000 }, (_, i) => ({ message: `Item ${i} not found` })) }))
  assert.ok(distinct.errors.length <= 50, String(distinct.errors.length))
  assert.equal(distinct.errors[0]?.message, 'Item 0 not found')
  // Errors at a path still group by their path, as before.
  const at = outcomeOf(IR, mcp({ data: { pages: null }, errors: [0, 1, 2].map(i => ({ message: `bad ${i}`, path: ['pages', 'results', String(i), 'title'] })) }))
  assert.equal(at.errors.length, 1)
  assert.equal(at.errors[0]?.count, 3)
})

test('a row keeps its label and text whole to a generous bound, then cuts them', () => {
  const ir = buildIR('p', normalize('query P { items { title body } }', {}))
  const [item] = outcomeOf(ir, mcp({ data: { items: [{ title: `${'t'.repeat(300)} end`, body: `${'word '.repeat(3_000)}` }] } })).preview?.[0]?.items ?? []
  assert.ok(item?.label.endsWith(' end'), item?.label)
  assert.ok((item?.text ?? '').length <= 1_000 && (item?.text ?? '').length >= 600, String(item?.text?.length))
})

test('the shape core relays for an MCP result: a bare array of content blocks', () => {
  const blocks = [{ type: 'text', text: JSON.stringify(SEARCH_RESULT) }]
  assert.deepEqual(outcomeOf(IR, blocks).rows, [{ field: 'results', count: 10, total: 3766, root: 'pages' }])
})

test('scalars keep counts and flags, and a cursor is never text worth a line', () => {
  const ir = buildIR('j', normalize('query C { jira_countIssues(jql: "x") { count } glean_search(query: "q") { hasMoreResults cursor } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { jira_countIssues: { count: '42' }, glean_search: { hasMoreResults: true, cursor: 'opaque-token' } } }))
  assert.deepEqual(
    outcome.scalars?.map(({ field, value, root, isOnly }) => ({ field, value, root, isOnly })),
    [
      { field: 'count', value: '42', root: 'jira_countIssues', isOnly: true },
      { field: 'hasMoreResults', value: true, root: 'glean_search', isOnly: undefined },
    ],
  )
})

test('preview: label is title, then name, then a nested document.title; extra is a second field', () => {
  const ir = buildIR('p', normalize('query P { items { id } }', {}))
  const outcome = outcomeOf(
    ir,
    mcp({
      data: {
        items: [
          { title: 'A page', name: 'ignored', id: '7', lastModified: '2026-10-01T00:00:00Z' },
          { name: 'Only a name', key: 'DEV-1' },
          { document: { title: 'Nested title' }, id: '9' },
          { url: 'https://x.test/u' },
          { count: 1 },
        ],
      },
    }),
  )
  // The card's selected fields ride along; this test is about label and extra.
  const bare = outcome.preview?.map(list => ({ ...list, items: list.items.map(({ fields: _fields, raw: _raw, ...rest }) => rest) }))
  assert.deepEqual(bare, [
    {
      field: 'items',
      root: 'items',
      // The response index of each item kept: the fifth, with no label, was skipped.
      at: [0, 1, 2, 3],
      items: [
        { label: 'A page', extra: 'Oct 1 2026' },
        // A short reference is the key; the name follows it.
        { label: 'DEV-1', text: 'Only a name' },
        { label: 'Nested title', extra: '9' },
        { label: 'https://x.test/u' },
      ],
      more: 1,
    },
  ])
})

test('preview: keeps up to 25 items (the pane shows 5 until opened out), bounds label and extra generously, collapses whitespace, and `more` is count minus kept', () => {
  const ir = buildIR('p', normalize('query P { items { id } }', {}))
  const list = Array.from({ length: 30 }, (_, i) => ({ title: `  t${i}\n  ${'x'.repeat(200)}`, status: 's'.repeat(100) }))
  const preview = outcomeOf(ir, mcp({ data: { items: list } })).preview!
  assert.equal(preview[0]!.items.length, 25)
  assert.equal(preview[0]!.more, 5)
  assert.ok(preview[0]!.items.every(one => one.label.length <= 256 && one.extra!.length <= 80))
  assert.ok(preview[0]!.items[0]!.label.startsWith('t0 xxx'))
  assert.ok(JSON.stringify(preview).length < 12_000)
})

test('preview: absent when no list, and non-object items are skipped', () => {
  assert.equal(outcomeOf(IR, mcp({ data: { pages: { totalSize: 0 } } })).preview, undefined)
  assert.equal(outcomeOf(IR, mcp({ data: { pages: { results: ['a', 1] } } })).preview, undefined)
})

test('a list three levels down is found (slack messages.matches), with its total', () => {
  const ir = buildIR('s', normalize('query S { slack_searchMessages(query: "q") { messages { total matches { text username } } } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { slack_searchMessages: { messages: { total: 42, matches: [{ text: 'hello', username: 'ada' }, { text: 'hi', username: 'bo' }] } } } }))
  assert.deepEqual(outcome.rows, [{ field: 'matches', count: 2, total: 42, root: 'slack_searchMessages' }])
  assert.equal(outcome.preview?.[0]?.items[0]?.label, 'hello')
})

test('preview dates read as short dates', async () => {
  const { shortDate } = await import('../../src/result.ts')
  assert.equal(shortDate('2026-10-01T19:17:11.000Z'), 'Oct 1 2026')
  assert.equal(shortDate('not a date'), 'not a date')
})

test('an opaque JSON field keeps what a reader can use: its top-level scalars and the name of each object, bounded', () => {
  const ir = buildIR('j', normalize('query J { open: jira_search(jql: "x") { issues { key fields } } }', {}))
  const fields = { summary: 'Fix the thing', status: { name: 'Open', statusCategory: { key: 'new' } }, priority: { id: '3' }, labels: ['a', 'b'], votes: 4, note: 'n'.repeat(200) }
  const item = outcomeOf(ir, mcp({ data: { open: { issues: [{ key: 'DEV-1', fields }] } } })).preview?.[0]?.items[0]
  assert.deepEqual(
    item?.fields?.map(one => one.name),
    ['key', 'fields.summary', 'fields.status.name', 'fields.votes', 'fields.note'],
  )
  assert.equal(item?.fields?.find(one => one.name === 'fields.status.name')?.value, 'Open')
  assert.ok((item?.fields ?? []).every(one => (one.value ?? '').length <= 256))
  // Never more than 12, however much the JSON holds.
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
  assert.equal(outcomeOf(ir, mcp({ data: { open: { issues: [{ key: 'DEV-1', fields: wide }] } } })).preview?.[0]?.items[0]?.fields?.length, 12)
})

test('two roots whose lists share a field name keep their own rows and previews', () => {
  const ir = buildIR('t', normalize('query T { open: jira_search(jql: "a") { issues { key } } closed: jira_search(jql: "b") { issues { key } } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { open: { issues: [{ key: 'DEV-1' }] }, closed: { issues: [{ key: 'DEV-2' }, { key: 'DEV-3' }] } } }))
  assert.deepEqual(outcome.rows.map(row => [row.root, row.count]), [['open', 1], ['closed', 2]])
  assert.deepEqual(outcome.preview?.map(list => [list.root, list.items.map(item => item.label)]), [['open', ['DEV-1']], ['closed', ['DEV-2', 'DEV-3']]])
})

// ---- What a total, a label and an error are taken to mean

const rowsLine = (ir: ReturnType<typeof buildIR>, response: unknown) => {
  const line = resultLines(outcomeOf(ir, mcp(response)), ir).find(one => one.kind === 'rows')
  return line?.kind === 'rows' ? line.text : undefined
}

test('only a sibling that says how many exist is a total: not a size or a count of what came back, nor one smaller than the rows', () => {
  const ir = buildIR('c', normalize('query C { confluence_search(cql: "x") { results { title } size limit } }', {}))
  const results = Array.from({ length: 25 }, (_, i) => ({ title: `t${i}` }))
  const text = rowsLine(ir, { data: { confluence_search: { results, size: 25, limit: 25, next: 'tok' } } })
  assert.ok(text !== undefined && /^25 /.test(text) && !/ of /.test(text), text)
  const jira = buildIR('j', normalize('query J { jira_search(jql: "x") { issues { key } total } }', {}))
  const three = [{ key: 'A-1' }, { key: 'A-2' }, { key: 'A-3' }]
  const smaller = rowsLine(jira, { data: { jira_search: { issues: three, total: 0 } } })
  assert.ok(smaller !== undefined && /^3 /.test(smaller) && !/ of /.test(smaller), smaller)
  assert.match(rowsLine(jira, { data: { jira_search: { issues: three, total: 412 } } }) ?? '', /^3 of 412 /)
})

test('an amount is never read as a row total: a fraction, a total beside a currency, or a total the schema types as anything but Int', () => {
  const op = 'query I { acme_invoice(id: "1") { number lineItems { sku } total currency } }'
  const ir = buildIR('i', normalize(op, {}))
  const items = [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }]
  const money = outcomeOf(ir, mcp({ data: { acme_invoice: { number: 'INV-77', lineItems: items, total: 1249.99, currency: 'USD' } } }))
  assert.deepEqual(money.rows, [{ field: 'lineItems', count: 3, root: 'acme_invoice' }])
  // The amount stays a value the pane shows, whole.
  const lines = resultLines(money, ir)
  assert.ok(lines.some(line => line.kind === 'scalar' && line.field === 'total' && line.text === '1249.99'), JSON.stringify(lines))
  assert.ok(!lines.some(line => line.kind === 'rows' && / of /.test(line.text)))
  // Whole cents beside a currency are money too.
  assert.equal(outcomeOf(ir, mcp({ data: { acme_invoice: { lineItems: items, total: 124999, currency: 'USD' } } })).rows[0]?.total, undefined)
  assert.equal(outcomeOf(ir, mcp({ data: { acme_invoice: { lineItems: items, total: 1250, amount: 1250 } } })).rows[0]?.total, undefined)
  // With no schema and no money beside it, a whole number is taken as the total, as before.
  assert.equal(outcomeOf(ir, mcp({ data: { acme_invoice: { lineItems: items, total: 40 } } })).rows[0]?.total, 40)
  for (const odd of [3.5, Number.NaN, Infinity, -1, 2, '40', null]) assert.equal(outcomeOf(ir, mcp({ data: { acme_invoice: { lineItems: items, total: odd } } })).rows[0]?.total, undefined, String(odd))
})

test('where the schema types the sibling, only an Int is a row total', () => {
  const sdl = (type: string) => indexSdl([`type Query { acme_orders: Acme_Orders }`, `type Acme_Orders { orders: [Acme_Order] totalCount: ${type} total: Int }`, 'type Acme_Order { id: ID }'])
  const op = 'query O { acme_orders { orders { id } totalCount total } }'
  const typed = (type: string) => annotate(buildIR('o', normalize(op, {})), { schema: sdl(type), isIncomplete: false })
  const orders = [{ id: '1' }, { id: '2' }]
  const read = (type: string, body: Record<string, unknown>) => outcomeOf(typed(type), mcp({ data: { acme_orders: { orders, ...body } } })).rows[0]?.total
  assert.equal(read('Int', { totalCount: 212 }), 212)
  assert.equal(read('Int!', { totalCount: 212 }), 212)
  assert.equal(read('Float', { totalCount: 212 }), undefined)
  assert.equal(read('Acme_Money', { totalCount: 212 }), undefined)
  assert.equal(read('[Int]', { totalCount: 212 }), undefined)
  // A sibling the schema rules out leaves room for the next one that says it.
  assert.equal(read('Float', { totalCount: 212, total: 40 }), 40)
})

test('a total a rows line already says is not a line of its own', () => {
  const ir = buildIR('j', normalize('query J { jira_search(jql: "x") { issues { key } total } }', {}))
  const lines = resultLines(outcomeOf(ir, mcp({ data: { jira_search: { issues: [{ key: 'A-1' }], total: 412 } } })), ir)
  assert.match(lines.find(line => line.kind === 'rows')?.text ?? '', /^1 of 412 /)
  assert.deepEqual(lines.filter(line => line.kind === 'scalar'), [])
})

test('a record\'s label is never another record\'s name: a manager or a creator does not title it', () => {
  const ir = buildIR('p', normalize('query P { items { id } }', {}))
  const item = (record: unknown) => outcomeOf(ir, mcp({ data: { items: [record] } })).preview?.[0]?.items[0]
  // Its own id names it, never its manager.
  const managed = item({ id: 'U1', manager: { name: 'Dana' } })
  assert.equal(managed?.label, 'U1')
  assert.ok(!JSON.stringify([managed?.label, managed?.text, managed?.extra]).includes('Dana'))
  assert.equal(item({ manager: { name: 'Dana' } }), undefined)
  const incident = item({ reference: 'INC-1055', creator: { name: 'Alice' } })
  assert.equal(incident?.label, 'INC-1055')
  assert.equal(incident?.text, undefined)
  // The record's own descriptive containers still speak for it.
  assert.equal(item({ id: 'U2', status: { name: 'Open' } })?.label, 'Open')
  assert.equal(item({ key: 'DEV-1', fields: { summary: 'Fix it' }, assignee: { name: 'Bob' } })?.text, 'Fix it')
})

// ---- Relay connections and records with nothing but an id

const RELAY_OP = 'query R { github_search(query: "is:open", first: 3) { totalCount edges { cursor node { title number updatedAt author { login email } } } pageInfo { hasNextPage endCursor } } }'
const edge = (title: string, number: number) => ({ cursor: `c${number}`, node: { title, number, updatedAt: '2026-10-01T19:17:11Z', author: { login: 'ada', email: null } } })

test('a Relay connection shows its nodes as rows: the edge is unwrapped, the card keeps the names the call selected', () => {
  const ir = buildIR('r', normalize(RELAY_OP, {}))
  const outcome = outcomeOf(ir, mcp({ data: { github_search: { totalCount: 212, edges: [edge('Fix the planner', 41), edge('Ship the router', 42)], pageInfo: { hasNextPage: true, endCursor: 'c42' } } } }))
  assert.deepEqual(outcome.rows, [{ field: 'edges', count: 2, total: 212, root: 'github_search' }])
  const [first] = outcome.preview?.[0]?.items ?? []
  assert.equal(first?.label, 'Fix the planner')
  assert.equal(first?.extra, 'Oct 1 2026')
  // The record's own scalars match link rules (`number`), not the edge's cursor.
  assert.equal(first?.raw?.number, '41')
  assert.equal(first?.raw?.cursor, undefined)
  assert.deepEqual(first?.fields?.map(one => one.name), ['cursor', 'node.title', 'node.number', 'node.updatedAt'])
  const lines = resultLines(outcome, ir)
  const preview = lines.find(line => line.kind === 'preview')
  assert.ok(preview?.kind === 'preview' && preview.items.map(item => item.label).join(',') === 'Fix the planner,Ship the router', JSON.stringify(preview))
})

test('a denial inside a Relay node is tagged on its row by real names, and its value is never kept', () => {
  const ir = buildIR('r', normalize('query R { github_search(query: "x") { edges { node { title email } } } }', {}))
  const denied = { message: 'denied', path: ['github_search', 'edges', '1', 'node', 'email'], extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: 'h.p.s' } }
  const outcome = outcomeOf(ir, mcp({ data: { github_search: { edges: [{ node: { title: 'a', email: 'a@x.test' } }, { node: { title: 'b', email: null } }] } }, errors: [denied] }))
  const row = outcome.preview?.[0]?.items[1]
  assert.equal(row?.label, 'b')
  assert.deepEqual(row?.denied?.map(one => one.field), ['node.email'])
  assert.deepEqual(row?.fields?.find(one => one.name === 'node.email'), { name: 'node.email' })
})

test('an edge that names itself is not relabelled by a node it holds, and a node that is not a record is not unwrapped', () => {
  const ir = buildIR('k', normalize('query K { k8s_pods { name node { name } } }', {}))
  const first = (item: unknown) => outcomeOf(ir, mcp({ data: { k8s_pods: [item] } })).preview?.[0]?.items[0]
  assert.equal(first({ name: 'api-7f9', node: { name: 'worker-3' } })?.label, 'api-7f9')
  assert.equal(first({ node: 'worker-3' }), undefined)
  assert.equal(first({ node: null, id: 'p1' })?.label, 'p1')
  assert.equal(first({ cursor: 'c', node: { id: 'n1', sku: 'SKU-1' } })?.label, 'n1')
})

test('a record that nothing names but its id is keyed by its id; one with no id either is skipped', () => {
  const ir = buildIR('u', normalize('query U { acme_users { id email } }', {}))
  const labels = (items: unknown[]) => outcomeOf(ir, mcp({ data: { acme_users: items } })).preview?.[0]?.items.map(item => item.label)
  assert.deepEqual(labels([{ id: 'u1', email: 'a@x.test' }, { id: 42, sku: 'S-1' }, { email: 'b@x.test' }, { id: '  ' }, { id: 1.5 }, { id: { nested: 'x' } }]), ['u1', '42'])
  // A name still wins over the id.
  assert.deepEqual(labels([{ id: 'u1', name: 'Ada' }]), ['Ada'])
  // The id is not said again beside itself.
  assert.equal(outcomeOf(ir, mcp({ data: { acme_users: [{ id: 'u1' }] } })).preview?.[0]?.items[0]?.extra, undefined)
})

test('an auth error with no https link is still an error; one link is said once per service and URL', () => {
  const error = (sources: unknown[]) => ({ message: 'Authorization required', path: [], extensions: { code: 'UPSTREAM_AUTH_REQUIRED', service: 'confluence', sources } })
  const link = { authorizationUrl: 'https://auth.example/link/confluence', name: 'confluence' }
  const unusable = outcomeOf(IR, mcp({ data: null, errors: [error([{ authorizationUrl: 'http://auth.example/plain', name: 'confluence' }]), error([])] }))
  assert.deepEqual(unusable.authLinks, [])
  // Two of one kind at no path: one line, counted twice.
  assert.equal(unusable.errors.length, 1)
  assert.equal(unusable.errors[0]?.code, 'UPSTREAM_AUTH_REQUIRED')
  assert.equal(unusable.errors[0]?.count, 2)
  const twice = outcomeOf(IR, mcp({ data: null, errors: [error([link]), error([link, { ...link, name: 'slack' }])] }))
  assert.deepEqual(twice.authLinks.map(one => one.service), ['confluence', 'slack'])
  assert.deepEqual(twice.errors, [])
})

test('a text cut for length is cut between characters, never inside an emoji', () => {
  const ir = buildIR('p', normalize('query P { items { id } }', {}))
  // Far past any safety cap, so it is cut; where doesn't matter, only that no emoji is split.
  const label = outcomeOf(ir, mcp({ data: { items: [{ title: '😀'.repeat(20_000) }] } })).preview?.[0]?.items[0]?.label ?? ''
  assert.ok(label.endsWith('…'))
  assert.doesNotThrow(() => encodeURIComponent(label))
})

// ---- Message-like records and long links

const CHAT = loadLinkConfig({ shipped: '[bases]\nchat = "https://acme.chat.example"\n' }).config

test('a message is keyed by its short author, its words are the row\'s text, and its permalink opens from the key', () => {
  const ir = buildIR('s', normalize('query S { slack_searchMessages(query: "q") { messages { matches { ts text username permalink } } } }', {}))
  const permalink = 'https://acme.chat.example/archives/C0123456789/p1791200000000100?thread_ts=1791200000.000100&cid=C0123456789'
  const match = { ts: '1791200000.000100', text: 'FYI the nightly build ran long and the alert did not trigger', username: 'pat.fakeuser1', permalink }
  const [item] = outcomeOf(ir, mcp({ data: { slack_searchMessages: { messages: { matches: [match] } } } }), CHAT).preview?.[0]?.items ?? []
  assert.equal(item?.label, 'pat.fakeuser1')
  assert.equal(item?.text, match.text)
  assert.equal(item?.url, permalink)
  // The link is worked out again at draw time from what the row kept, so the long permalink is kept whole.
  assert.equal(previewLinkOf('slack', item!, CHAT), permalink)
})

test('a message with no author (a bot post) or only one word keeps the text as its key', () => {
  const ir = buildIR('s', normalize('query S { slack_searchMessages(query: "q") { messages { matches { text username } } } }', {}))
  const first = (match: unknown) => outcomeOf(ir, mcp({ data: { slack_searchMessages: { messages: { matches: [match] } } } })).preview?.[0]?.items[0]
  assert.equal(first({ text: 'deploy finished for the thing', username: '' })?.label, 'deploy finished for the thing')
  assert.equal(first({ text: 'hello', username: 'ada' })?.label, 'hello')
})

test('responseIn reads the GraphQL response out of the shapes a tool result comes in, and is undefined for anything else', () => {
  const body = { data: { jira_getCurrentUser: { self: 'https://yourco.atlassian.net/rest/api/3/user' } } }
  assert.deepEqual(responseIn(JSON.stringify(body)), body)
  assert.deepEqual(responseIn(mcp(body)), body)
  assert.deepEqual(responseIn(mcp(body).content), body)
  // A saved tool result is a content-block array in text, unwrapped once more.
  assert.deepEqual(responseIn(JSON.stringify(mcp(body).content)), body)
  for (const nothing of [undefined, null, 5, {}, [], 'not json', mcp('not json'), mcp(''), { content: 'x' }, { content: [{ type: 'image' }] }]) assert.equal(responseIn(nothing), undefined, JSON.stringify(nothing))
})

test('a root that is one record shows its short text fields; a list wrapper keeps none, and text is bounded', () => {
  const ir = buildIR('w', normalize('query W { workspace: slack_authTest { team url } people: slack_users(limit: 2) { members { name } nextCursor } }', {}))
  const outcome = outcomeOf(ir, mcp({ data: { workspace: { team: 'Acme', url: 'https://yourco.slack.com/' }, people: { members: [{ name: 'ada' }], nextCursor: 'opaque' } } }))
  const texts = (outcome.scalars ?? []).map(one => `${one.root}.${one.field}=${String(one.value)}`)
  assert.deepEqual(texts, ['workspace.team=Acme', 'workspace.url=https://yourco.slack.com/'])
  const long = outcomeOf(buildIR('l', normalize('query L { thing { a } }', {})), mcp({ data: { thing: { a: 'x'.repeat(5_000) } } }))
  assert.ok(String(long.scalars?.[0]?.value).length <= 301)
})

test('a root that is an untyped map of many keys keeps its first scalars in order, each knowing whether it was all the root held', () => {
  const ir = buildIR('m', normalize('query M { acme_config other: acme_flag }', {}))
  const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, i]))
  const outcome = outcomeOf(ir, mcp({ data: { acme_config: wide, other: { only: true } } }))
  // At most 12, the first ones; the map fills them, so the second root gets none.
  assert.deepEqual(outcome.scalars?.map(one => one.path), Array.from({ length: 12 }, (_, i) => `acme_config.k${i}`))
  assert.ok(outcome.scalars?.every(one => one.isOnly === undefined))
  const texts = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, `value ${i}`]))
  const mixed = outcomeOf(ir, mcp({ data: { acme_config: texts, other: { only: true } } }))
  // A map of text keeps 8 lines of it; the other root's only value still has room, and says it was the only one.
  assert.equal(mixed.scalars?.filter(one => one.root === 'acme_config').length, 8)
  assert.deepEqual(mixed.scalars?.find(one => one.root === 'other'), { field: 'only', value: true, path: 'other.only', root: 'other', isOnly: true })
})
