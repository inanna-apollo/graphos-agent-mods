import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIR } from '../../src/build.ts'
import { normalize } from '../../src/normalize.ts'
import { previewOf } from '../../src/preview/changes.ts'
import { CLOSED } from '../../src/view/kit.ts'
import { BODY_ROWS, CHANGE_INDENT, CHANGE_MAX, cardId, changeColumn, changesPlanOf, planOf, SHED_ORDER } from '../../src/view/plan.ts'
import { deleteCall, editCall, pageCall, postCall, transitionCall, unmappedCall } from '../../tests/write-fixtures.ts'
import { reviewCall } from '../../tests/review-fixtures.ts'

const plan = (call: ReturnType<typeof editCall>, rows = Infinity, columns = 64) =>
  planOf(call.ir, { rows, columns, isPending: call.status === 'pending', open: CLOSED, now: call.arrivedAt, sectionGap: 0, ...(call.outcome !== undefined && { outcome: call.outcome }) })

test('a write plans one CHANGES block per root; a read plans none', () => {
  for (const make of [transitionCall, editCall, () => pageCall(), postCall, deleteCall, unmappedCall]) {
    const call = make()
    assert.equal(plan(call).changes.blocks.length, 1, call.ir.opName)
    assert.ok(plan(call).changes.rows > 0)
  }
  assert.equal(plan(reviewCall('ran')).changes.blocks.length, 0)
  assert.equal(plan(reviewCall('ran')).changes.rows, 0)
})

test("a block's rows add up: its header, each row with a body's lines and its count, the notes", () => {
  const one = plan(editCall()).changes.blocks[0]
  assert.ok(one !== undefined)
  const sum = one.headRows + one.rows.reduce((total, row) => total + row.rows, 0) + one.moreRows + one.notes.reduce((total, note) => total + note.rows, 0)
  assert.equal(one.total, sum)
  const description = one.rows.find(row => row.row.label === 'description')
  assert.ok(description !== undefined && description.lines.length > 0)
  assert.equal(description.rows, description.valueRows + description.lineRows.reduce((total, rows) => total + rows, 0) + (description.rest > 0 ? 1 : 0))
})

test('every CHANGES card is anchored: the section and the target on the header, each row on its own rows, top down', () => {
  const planned = plan(editCall())
  const block = planned.changes.blocks[0]?.block
  assert.ok(block !== undefined)
  const section = planned.anchors.get(cardId.section(block.path))
  const target = planned.anchors.get(cardId.target(block.path))
  assert.ok(section !== undefined && target !== undefined)
  assert.equal(section.row, target.row)
  let last = section.row
  block.rows.forEach((_, index) => {
    const at = planned.anchors.get(cardId.change(block.path, index))
    assert.ok(at !== undefined && at.row > last, `row ${index}`)
    last = at.row
  })
})

test('CHANGES comes first for a write: above RESULT once it ran', () => {
  const planned = plan(pageCall('ran'))
  const block = planned.changes.blocks[0]?.block
  const confirm = planned.anchors.get(cardId.confirm())
  const section = block === undefined ? undefined : planned.anchors.get(cardId.section(block.path))
  assert.ok(confirm !== undefined && section !== undefined)
  assert.ok(section.row < confirm.row)
})

test("short of rows, a body's first lines shed before the block does: fewer lines, then the count alone; the rows themselves never go", () => {
  const full = plan(editCall())
  const fewer = plan(editCall(), full.total - 6)
  assert.ok(fewer.shed.includes('change-lines'), fewer.shed.join(','))
  const tight = plan(editCall(), 10)
  assert.ok(tight.shed.includes('change-lines-all'), tight.shed.join(','))
  const rows = tight.changes.blocks[0]?.rows ?? []
  assert.equal(rows.length, full.changes.blocks[0]?.rows.length)
  const description = rows.find(row => row.row.label === 'description')
  assert.equal(description?.lines.length, 0)
  assert.equal(description?.rest, 0)
  // The count still says how big the body is.
  assert.match(description?.row.text ?? '', /^8 lines/)
  assert.ok(SHED_ORDER.indexOf('change-lines') > SHED_ORDER.indexOf('arg-lines'))
})

test('a body shows its first lines within the budget, at least one, then a count; a last line that fits one row is shown rather than counted', () => {
  const preview = previewOf(pageCall().ir)
  const [first] = changesPlanOf(preview, 63, 18, BODY_ROWS[0], 1).blocks
  const body = first?.rows.find(row => row.row.label === 'body')
  assert.ok(body !== undefined)
  assert.ok(body.lineRows.reduce((total, rows) => total + rows, 0) <= BODY_ROWS[0])
  assert.equal(body.lines.length + body.rest, body.row.body?.total)
  // A budget smaller than the first line still shows that line.
  const [narrow] = changesPlanOf(preview, 30, 14, 1, 1).blocks
  assert.equal(narrow?.rows.find(row => row.row.label === 'body')?.lines.length, 1)
  // Two lines and room for one row: the second fits one row, so it is drawn instead of `1 more line`.
  const two = previewOf(editCall().ir)
  const [planned] = changesPlanOf(two, 200, 18, 7, 1).blocks
  const description = planned?.rows.find(row => row.row.label === 'description')
  assert.equal(description?.rest, 0)
  assert.equal(description?.lines.length, 8)
})

test('the CHANGES column fits the longest label that fits, at least the form column, at most CHANGE_MAX and half a narrow pane; a longer label stacks', () => {
  const preview = previewOf(unmappedCall().ir)
  const column = changeColumn(preview, 63, 12)
  assert.ok(column >= 12 && column <= CHANGE_MAX)
  const [block] = changesPlanOf(preview, 63, column, BODY_ROWS[0], 1).blocks
  const stacked = changesPlanOf(previewOf(buildIR('t', normalize('mutation E { incidentio_editIncident(id: "1", customFieldEntriesWithALongName: "x", name: "n") { id } }', {}))), 63, column, BODY_ROWS[0], 1).blocks[0]?.rows.find(row => row.row.label === 'customFieldEntriesWithALongName')
  assert.ok(stacked?.labelRows !== undefined)
  const plain = block?.rows.find(row => row.row.label === 'name')
  assert.equal(plain?.labelRows, undefined)
  assert.ok(changeColumn(preview, 20, 10) <= Math.max(CHANGE_INDENT + 2, 10))
})
