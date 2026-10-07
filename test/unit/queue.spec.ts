import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY, arrive, isFinal, newer, older, patchOutcome, settle, settleOrphans, shown, shownAt, statusOf } from '../../src/queue.ts'
import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { PREVIEW_SHOWN, compactOutcome, outcomeOf } from '../../src/result.ts'
import type { InspectedCall } from '../../types/index.d.ts'

const call = (id: string): InspectedCall => ({ id, server: 'gas', operation: `query ${id} { a }`, variables: '{}', status: 'pending', arrivedAt: 0, ir: { id, state: 'ready', roots: [] } as unknown as InspectedCall['ir'] })

test('arrive appends in order', () => {
  const state = arrive(arrive(arrive(EMPTY, call('a')), call('b')), call('c'))
  assert.deepEqual(state.queue.map(one => one.id), ['a', 'b', 'c'])
  assert.equal(state.last, null)
})

test('arrive dedupes by id and returns the same state', () => {
  const state = arrive(arrive(EMPTY, call('a')), call('b'))
  assert.equal(arrive(state, { ...call('a'), operation: 'mutation { evil }' }), state)
})

test('arrive does not mutate its input', () => {
  const before = arrive(EMPTY, call('a'))
  arrive(before, call('b'))
  assert.equal(before.queue.length, 1)
  assert.equal(EMPTY.queue.length, 0)
})

test('settle removes the call and sets last with the status', () => {
  const state = settle(arrive(arrive(EMPTY, call('a')), call('b')), 'a', 'ran')
  assert.deepEqual(state.queue.map(one => one.id), ['b'])
  assert.deepEqual(state.last, { ...call('a'), status: 'ran' })
})

test('settle can remove from the middle', () => {
  const state = settle(arrive(arrive(arrive(EMPTY, call('a')), call('b')), call('c')), 'b', 'denied')
  assert.deepEqual(state.queue.map(one => one.id), ['a', 'c'])
  assert.equal(state.last?.status, 'denied')
})

test('settle replaces an earlier last', () => {
  const state = settle(settle(arrive(arrive(EMPTY, call('a')), call('b')), 'a', 'ran'), 'b', 'errored')
  assert.equal(state.last?.id, 'b')
  assert.equal(state.last?.status, 'errored')
})

test('settle of an unknown id is a no-op returning the same state', () => {
  const state = arrive(EMPTY, call('a'))
  assert.equal(settle(state, 'nope', 'ran'), state)
  assert.equal(settle(EMPTY, 'nope', 'ran'), EMPTY)
})

test('settling twice is a no-op the second time', () => {
  const once = settle(arrive(EMPTY, call('a')), 'a', 'ran')
  assert.equal(settle(once, 'a', 'denied'), once)
})

test('a result that arrives after an interruption replaces it; nothing replaces a real ending', () => {
  const cut = settle(arrive(EMPTY, call('a')), 'a', 'interrupted')
  const late = settle(cut, 'a', 'ran')
  assert.equal(late.history[0]!.status, 'ran')
  assert.equal(late.last?.status, 'ran')
  assert.equal(settle(late, 'a', 'interrupted'), late)
  assert.equal(settle(cut, 'a', 'interrupted'), cut)
})

test('isFinal: settled for good, analysed, and a call that ran has its outcome', () => {
  const with_ = (status: InspectedCall['status'], state = 'ready', outcome = false): InspectedCall => ({
    ...call('a'),
    status,
    ir: { ...call('a').ir, state } as InspectedCall['ir'],
    ...(outcome && { outcome: { rows: [], errors: [], authLinks: [] } }),
  })
  assert.equal(isFinal(with_('pending')), false)
  assert.equal(isFinal(with_('interrupted')), false)
  assert.equal(isFinal(with_('denied', 'analyzing')), false)
  assert.equal(isFinal(with_('ran')), false)
  assert.equal(isFinal(with_('ran', 'ready', true)), true)
  assert.equal(isFinal(with_('denied', 'partial')), true)
  assert.equal(isFinal(with_('errored', 'unparseable')), true)
})

test('settleOrphans settles the calls another instance owns, or every pending call at the end of a session', () => {
  const owned = (id: string, owner?: string): InspectedCall => ({ ...call(id), ...(owner !== undefined && { owner }) })
  const state = arrive(arrive(arrive(EMPTY, owned('ghost', 'old')), owned('legacy')), owned('live', 'me'))
  const swept = settleOrphans(state, 'me')
  assert.deepEqual(swept.queue.map(one => one.id), ['live'])
  assert.deepEqual(swept.history.map(one => [one.id, one.status]), [['legacy', 'interrupted'], ['ghost', 'interrupted']])
  assert.equal(settleOrphans(swept, 'me'), swept)
  assert.deepEqual(settleOrphans(state).queue, [])
})

test('shown returns the oldest pending call and the count', () => {
  const state = arrive(arrive(EMPTY, call('a')), call('b'))
  assert.deepEqual(shown(state), { call: call('a'), waiting: 2 })
})

test('shown falls back to last when the queue is empty', () => {
  const state = settle(arrive(EMPTY, call('a')), 'a', 'ran')
  assert.deepEqual(shown(state), { call: { ...call('a'), status: 'ran' }, waiting: 0 })
})

test('shown prefers pending over last', () => {
  const state = arrive(settle(arrive(EMPTY, call('a')), 'a', 'ran'), call('b'))
  assert.deepEqual(shown(state), { call: call('b'), waiting: 1 })
})

test('shown is null when nothing has happened', () => {
  assert.deepEqual(shown(EMPTY), { call: null, waiting: 0 })
})

test('statusOf: deny wins, then isError, else ran', () => {
  assert.equal(statusOf({ deny: { reason: 'no' } }), 'denied')
  assert.equal(statusOf({ deny: '' }), 'denied')
  assert.equal(statusOf({ deny: {}, isError: true }), 'denied')
  assert.equal(statusOf({ isError: true }), 'errored')
  assert.equal(statusOf({ isError: false }), 'ran')
  assert.equal(statusOf({}), 'ran')
})

test('statusOf: only a true isError counts as an error', () => {
  assert.equal(statusOf({ isError: 'true' }), 'ran')
  assert.equal(statusOf({ isError: 1 }), 'ran')
})

test('a refusal at the permission dialog reads as denied, not failed', () => {
  const refused = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
  assert.equal(statusOf({ isError: true, result: refused }), 'denied')
  assert.equal(statusOf({ isError: true, text: refused }), 'denied')
  assert.equal(statusOf({ isError: true, result: 'upstream exploded' }), 'errored')
  assert.equal(statusOf({ isError: false, result: '{"data":{}}' }), 'ran')
})

const settled = (n: number) => {
  let state = EMPTY
  for (let i = 0; i < n; i++) state = settle(arrive(state, call(`c${i}`)), `c${i}`, 'ran')
  return state
}

test('history holds settled calls newest first, and last is its head', () => {
  const state = settled(3)
  assert.deepEqual(state.history.map(one => one.id), ['c2', 'c1', 'c0'])
  assert.equal(state.last?.id, 'c2')
})

test('history is capped at 20 and old entries drop their heavy fields', () => {
  const heavy = (id: string): InspectedCall => ({ ...call(id), ir: { toolCallId: id, state: 'ready', roots: [], printed: 'query { a }' } as InspectedCall['ir'] })
  let state = EMPTY
  for (let i = 0; i < 25; i++) state = settle(arrive(state, heavy(`c${i}`)), `c${i}`, 'ran')
  assert.equal(state.history.length, 20)
  assert.equal(state.history[0]!.id, 'c24')
  assert.equal(state.history[19]!.id, 'c5')
  assert.equal(state.history[4]!.ir.printed, 'query { a }')
  assert.equal(state.history[5]!.ir.printed, undefined)
})

test('old history entries keep that a denied field had a token, never the token', () => {
  const token = 'x'.repeat(16_000)
  const denied = { name: 'email', coordinate: 'User.email', path: 'me.email', args: [], policy: 'deny', denialContext: token, children: [] }
  const root = { name: 'me', coordinate: 'Query.me', path: 'me', args: [], policy: 'allow', children: [denied] }
  const withToken = (id: string): InspectedCall => ({ ...call(id), ir: { toolCallId: id, state: 'ready', roots: [root] } as unknown as InspectedCall['ir'] })
  let state = EMPTY
  for (let i = 0; i < 10; i++) state = settle(arrive(state, withToken(`c${i}`)), `c${i}`, 'ran')
  assert.equal(state.history[0]!.ir.roots[0]!.children[0]!.denialContext, token)
  const old = state.history[9]!.ir.roots[0]!.children[0]!
  assert.notEqual(old.denialContext, undefined)
  assert.equal(old.denialContext!.length, 0)
  // Only the newest five carry it (and `last`, the newest again).
  assert.equal(state.history.filter(one => one.ir.roots[0]!.children[0]!.denialContext === token).length, 5)
})

test('patches reach history too', () => {
  const state = patchOutcome(settled(2), 'c0', { rows: [], errors: [], authLinks: [] })
  assert.deepEqual(state.history[1]!.outcome, { rows: [], errors: [], authLinks: [] })
})

// ---- What a history entry keeps of what came back

const MATCHES = '{ messages { total matches { text username permalink ts channel { name } user team iid } } }'
const SLACK = buildIR('s', normalize(`query S { a: slack_searchMessages(query: "x") ${MATCHES} b: slack_searchMessages(query: "y") ${MATCHES} c: slack_searchMessages(query: "z") ${MATCHES} }`, {}))
/** A three-root Slack search, 40 long messages a root: the heaviest preview an outcome keeps. */
const slackOutcome = (chars = 2_000) => {
  const match = (i: number) => ({
    text: `${'word '.repeat(chars / 5)}${i}`,
    username: `user.name${i}`,
    permalink: `https://acme.slack.com/archives/C0123456789/p17912000000${i}?thread_ts=1791200000.000100&cid=C0123456789`,
    ts: `1791200000.0001${i}`,
    channel: { name: `channel-${i}` },
    user: `U0${i}ABCDEF`,
    team: 'T012345',
    iid: `iid-${i}-${'x'.repeat(20)}`,
  })
  const data = Object.fromEntries(['a', 'b', 'c'].map(key => [key, { messages: { total: 400, matches: Array.from({ length: 40 }, (_, i) => match(i)) } }]))
  return outcomeOf(SLACK, { content: [{ type: 'text', text: JSON.stringify({ data }) }] })
}
const ranWith = (state: ReturnType<typeof settled>, id: string, outcome: NonNullable<InspectedCall['outcome']>) => patchOutcome(settle(arrive(state, call(id)), id, 'ran'), id, outcome)

test('the newest settled call keeps 25 rows a list to open out to; older entries keep the rows shown before a press, the rest counted', () => {
  const full = slackOutcome()
  let state = ranWith(EMPTY, 'a', full)
  assert.deepEqual(state.history[0]!.outcome, full)
  assert.equal(state.last?.outcome, full)
  state = ranWith(state, 'b', full)
  assert.equal(state.history[0]!.outcome?.preview?.[0]?.items.length, 25)
  const older = state.history[1]!.outcome!
  for (const [at, list] of (older.preview ?? []).entries()) {
    const was = full.preview![at]!
    assert.equal(list.items.length, PREVIEW_SHOWN)
    // Every row still counted: shown, or `… N more`.
    assert.equal(list.items.length + list.more, was.items.length + was.more)
    assert.deepEqual(list.at, was.at?.slice(0, PREVIEW_SHOWN))
    assert.deepEqual(list.items.map(item => item.label), was.items.slice(0, PREVIEW_SHOWN).map(item => item.label))
    // Links still match from what the rows kept.
    assert.deepEqual(list.items.map(item => item.raw), was.items.slice(0, PREVIEW_SHOWN).map(item => item.raw))
    for (const item of list.items) {
      assert.ok([...(item.text ?? '')].length <= 400)
      assert.ok((item.fields ?? []).every(field => [...(field.value ?? '')].length <= 80))
    }
  }
  // Counts, errors and totals are the outcome's as it was.
  assert.deepEqual(older.rows, full.rows)
  assert.deepEqual(older.errors, full.errors)
})

test('an older entry of the heaviest preview stays in the low tens of KB, and trimming it again changes nothing', () => {
  const state = ranWith(ranWith(EMPTY, 'a', slackOutcome()), 'b', slackOutcome())
  const older = state.history[1]!.outcome!
  assert.ok(JSON.stringify(older).length < 30_000, String(JSON.stringify(older).length))
  assert.equal(compactOutcome(older), older)
  // Twenty of them, the newest whole: a fraction of twenty whole ones.
  let many = EMPTY
  for (let i = 0; i < 25; i++) many = ranWith(many, `c${i}`, slackOutcome())
  const size = JSON.stringify(many).length
  assert.ok(size < 1_000_000, String(size))
  assert.ok(many.history.slice(1).every(one => JSON.stringify(one.outcome).length < 30_000))
})

test('an outcome that lands on an older entry (it answered after a later call settled) is kept as that place keeps it', () => {
  let state = settle(arrive(arrive(EMPTY, call('a')), call('b')), 'a', 'ran')
  state = settle(state, 'b', 'ran')
  state = patchOutcome(state, 'a', slackOutcome())
  assert.equal(state.history[1]!.id, 'a')
  assert.equal(state.history[1]!.outcome?.preview?.[0]?.items.length, PREVIEW_SHOWN)
  state = patchOutcome(state, 'b', slackOutcome())
  assert.equal(state.history[0]!.outcome?.preview?.[0]?.items.length, 25)
})

test('an outcome with no preview, or one already small, is kept as it is', () => {
  const small = outcomeOf(SLACK, JSON.stringify({ data: { a: { messages: { matches: [{ text: 'hello there', username: 'ada' }] } } } }))
  assert.equal(compactOutcome(small), small)
  const bare = { rows: [], errors: [], authLinks: [] }
  assert.equal(compactOutcome(bare), bare)
})

test('older and newer clamp at the ends', () => {
  const state = settled(3)
  assert.equal(older(null, state), 1)
  assert.equal(older(1, state), 2)
  assert.equal(older(2, state), 2)
  assert.equal(newer(2), 1)
  assert.equal(newer(0), null)
  assert.equal(newer(null), null)
  assert.equal(older(null, EMPTY), null)
  // With a pending call live, the first step back is the newest settled one.
  assert.equal(older(null, arrive(state, call('p'))), 0)
})

test('shownAt follows live at null and picks history[N] otherwise; an arrival is live at null', () => {
  const state = settled(3)
  assert.equal(shownAt(state, null).call?.id, 'c2')
  assert.equal(shownAt(state, 2).call?.id, 'c0')
  assert.equal(shownAt(state, 99).call?.id, 'c0')
  const live = arrive(state, call('p'))
  assert.deepEqual([shownAt(live, null).call?.id, shownAt(live, null).waiting], ['p', 1])
  assert.equal(shownAt(live, 1).call?.id, 'c1')
  assert.equal(shownAt(EMPTY, 3).call, null)
})

test('state written by an older version of the mod is normalized, never crashes', async () => {
  const { normalizeCalls, shownAt, settle: settleCall } = await import('../../src/queue.ts')
  // Before history existed: { queue, last } only, plus an entry that is not a call.
  const old = { queue: [{ operation: 'no id' }], last: { id: 'y', ir: { roots: [] }, operation: 'q', variables: '', status: 'ran' } }
  const state = normalizeCalls(old)
  assert.equal(state.queue.length, 0)
  assert.equal(state.history.length, 1)
  assert.equal(shownAt(old as never, null).call?.id, 'y')
  assert.doesNotThrow(() => settleCall(old as never, 'nope', 'ran'))
  assert.deepEqual(normalizeCalls(undefined), { queue: [], last: null, history: [] })
})

test('navOf: buttons only with a history, cursors step through it, newer steps back onto live', async () => {
  const { navOf } = await import('../../src/queue.ts')
  const call = (id: string) => ({ id, status: 'ran', ir: { roots: [] } }) as never
  const history = [call('c'), call('b'), call('a')]
  const state = { queue: [], last: history[0] ?? null, history } as never
  assert.equal(navOf({ queue: [], last: null, history: [call('a')] } as never, null), undefined)
  const live = navOf(state, null)
  assert.deepEqual(live, { count: 3, position: 3, isLive: true, older: 1 })
  const past = navOf(state, 1)
  assert.deepEqual(past, { count: 3, position: 2, isLive: false, older: 2, newer: null })
  const oldest = navOf(state, 2)
  assert.deepEqual(oldest, { count: 3, position: 1, isLive: false, newer: 1 })
})
