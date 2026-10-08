// The PagerDuty OpenIncidents call (echo scalars, a "more" flag, conditional and opaque fields),
// pending and settled, through the text renderer.
import type { InspectedCall } from '../types'
import { expect, test } from 'claude-code/testing'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf } from '../src/result.ts'
import { shownScalars } from '../src/view/outcome.ts'
import { indexSdl } from '../src/schema.ts'
import { displayWidth, renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, viewOf } from '../src/view.tsx'
import { TREE } from '../src/view/ui/theme.ts'

const ROOT = 'pagerduty_listIncidents'
const OPERATION = `query OpenIncidents($statuses: String) {
  ${ROOT}(limit: 5, statuses: $statuses, sort_by: ["created_at:desc"]) {
    incidents { incident_number title status urgency created_at html_url service }
    more total limit offset
  }
}`
const DESCRIPTION =
  'List incidents\n\nList existing incidents.\n\nAn incident represents a problem or an issue that needs to be addressed and resolved.\n\nFor more information see the [API Concepts Document](../../api-reference/a47605517c19a-api-concepts#incidents)\n\nScoped OAuth requires: `incidents.read`'
const SERVICE_DESCRIPTION =
  'Polymorphic schema (oneOf/anyOf) -- not yet modeled as a GraphQL union.\n\nThe service the incident is on. If the `include[]=services` query parameter is provided, the full service definition will be returned.'
// Real newlines inside block strings, as the schema carries them.
const block = (text: string) => `"""${text}"""`
const SDL = [
  `type Query {
    ${block(DESCRIPTION)}
    ${ROOT}(limit: Int, offset: Int, total: Boolean, date_range: String, incident_key: String, service_ids: [String!], team_ids: [String!], user_ids: [String!], urgencies: String, time_zone: String, statuses: String, sort_by: [String!], include: String, since: String, until: String): Pagerduty_ListIncidentsResponse
  }`,
  `type Pagerduty_ListIncidentsResponse { """Echoes limit pagination property.""" limit: Int """Indicates if there are additional records to return""" more: Boolean """Echoes offset pagination property.""" offset: Int """The total number of records matching the given query.""" total: Int incidents: [Pagerduty_Incident!]! }`,
  `type Pagerduty_Incident {
    incident_number: Int
    title: String
    status: String
    urgency: String
    """The time the incident was first triggered."""
    created_at: String
    html_url: String
    ${block(SERVICE_DESCRIPTION)}
    service: Pagerduty_JSON
  }`,
]

function incidentsCall(status: InspectedCall['status']): InspectedCall {
  const fields = new Map<string, FieldDecision>()
  for (const path of [ROOT, `${ROOT}.incidents`, ...['incident_number', 'title', 'status', 'urgency', 'created_at', 'html_url', 'service'].map(name => `${ROOT}.incidents.${name}`), ...['more', 'total', 'limit', 'offset'].map(name => `${ROOT}.${name}`)]) {
    fields.set(path, { decision: 'allow' })
  }
  const ir = annotate(buildIR('toolu_pd', normalize(OPERATION, { statuses: 'triggered' })), {
    schema: indexSdl(SDL),
    access: { denyOperation: false, fields },
    validation: { valid: true, diagnostics: [] },
    scope: 'pagerduty',
    isIncomplete: false,
  })
  const titles = ['[staging] Checkout API: response time slow', 'prod Latency is high for operation A', 'prod Latency is high for operation B', 'prod Latency is high for operation C', '[prod] Example worker queue backlog']
  const incidents = titles.map((title, index) => ({
    incident_number: 100 + index,
    title,
    status: 'triggered',
    urgency: 'high',
    created_at: `2026-10-0${index + 1}T07:00:00Z`,
    html_url: `https://example.pagerduty.com/incidents/${index}`,
    service: { id: 'PSVC', type: 'service_reference' },
  }))
  const text = JSON.stringify({ data: { [ROOT]: { incidents, more: true, total: null, limit: 5, offset: 0 } } })
  return {
    id: 'toolu_pd',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation: OPERATION,
    variables: JSON.stringify({ statuses: 'triggered' }, null, 2),
    status,
    arrivedAt: Date.UTC(2026, 9, 6),
    ir,
    ...(status === 'ran' && { outcome: outcomeOf(ir, { content: [{ type: 'text', text }] }) }),
  }
}

for (const columns of [50, 64]) {
  for (const status of ['pending', 'ran'] as const) {
    test(`OpenIncidents, ${status}, at ${columns} columns`, () => {
      const text = renderText(viewOf(stubKit(), { call: incidentsCall(status), waiting: 0 }, columns, CLOSED, undefined, { surface: 'terminal' }), columns, { clip: false })
      for (const line of text.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
      const flat = text.replace(/\s+/g, ' ')
      expect(flat).toMatch(/access incidents\.read/)
      expect(flat).toMatch(/List existing incidents\./)
      expect(text).not.toMatch(/For more information|Scoped OAuth|List incidents List/)
      // Echoes and nulls are not scalars worth a line.
      expect(text).not.toMatch(/^\s*(limit|offset|total) {2}(5|0|null)\s*$/m)
      expect(text).not.toMatch(/ {2}(true|null)\s*$/m)
      // The conditional and opaque field, and the note that says so.
      expect(flat).toMatch(/service\s+untyped JSON/)
      expect(flat).toContain('include=services')
      expect(flat).toMatch(/reference only/)
      if (status === 'pending') return
      // One list: the count, then its items. At 50 columns `more available` is said shorter rather than wrapped.
      expect(flat).toMatch(/RESULT 5 incidents · first page · more( available)? /)
      expect(text).not.toMatch(/\bmore {2}true/)
      // The newest date rides on each preview row, not the status.
      expect(text).toMatch(/\S.*Oct 2 2026/)
    })
  }
}

// ---- The live shapes of the three fixes

const RESPONSE = JSON.stringify({ data: { [ROOT]: { incidents: [{ title: 'a' }], more: true, total: null, limit: 5, offset: 0 } } })
const SMALL_SDL = [
  `type Query { ${ROOT}(limit: Int, offset: Int, total: Boolean, statuses: String, sort_by: [String!], include: String): Pagerduty_ListIncidentsResponse }`,
  SDL[1] as string,
  `type Pagerduty_Incident { title: String }`,
]
const SMALL_OPERATION = `query OpenIncidents($statuses: String) { ${ROOT}(limit: 5, statuses: $statuses, sort_by: ["created_at:desc"]) { incidents { title } more total limit offset } }`
// Settled against `settled`, drawn against `now`: the filter reads the IR the pane has now.
const fieldsOf = (settled: ReturnType<typeof buildIR>, now = settled) => shownScalars(outcomeOf(settled, RESPONSE), now).map(one => one.field)

test('an unset offset of 0 and an Echoes… field are not scalars, enriched or not', () => {
  const arrival = buildIR('toolu_pd', normalize(SMALL_OPERATION, { statuses: 'triggered' }))
  const enriched = annotate(arrival, { schema: indexSdl(SMALL_SDL), access: { denyOperation: false, fields: new Map() }, validation: { valid: true, diagnostics: [] }, scope: 'pagerduty', isIncomplete: false })
  // Settled on the arrival IR (no schema yet), drawn against either: the offset is unset, and the echoes read once the schema lands.
  expect(fieldsOf(arrival)).toEqual(['more'])
  expect(fieldsOf(enriched)).toEqual(['more'])
  expect(fieldsOf(arrival, enriched)).toEqual(['more'])
})

test('a set offset of 0 is an echo, and a set offset that differs is kept', () => {
  const set = buildIR('t', normalize(SMALL_OPERATION.replace('limit: 5,', 'limit: 5, offset: 10,'), { statuses: 'triggered' }))
  const kept = fieldsOf(set)
  expect(kept).toContain('offset')
})

test('a wrapped RETURNS row keeps the tree guide, at 50 columns', () => {
  const text = renderText(viewOf(stubKit(), { call: incidentsCall('ran'), waiting: 0 }, 50, CLOSED, undefined, { surface: 'terminal' }), 50)
  const rows = text.split('\n')
  // The tree starts on the row after `return type` and ends at the `access` row.
  const at = rows.findIndex(row => /^ {2}return type /.test(row)) + 1
  const end = rows.findIndex((row, i) => i > at && /^ {2}access /.test(row))
  const column = (rows[at] ?? '').search(/\S/)
  const returns = rows.slice(at, end === -1 ? undefined : end).map(row => row.slice(column))
  const wrapped = returns.findIndex(row => /created_at|html_url/.test(row) && !/incident_number/.test(row))
  expect(wrapped).toBeGreaterThan(0)
  // The continuation carries the guides of its line's level, then its text.
  expect(returns[wrapped]).toMatch(new RegExp(`^${TREE.through}${TREE.through} ?\\S`))
  // No row below the first starts with blank where a guide belongs, except under a last branch.
  for (const row of returns.slice(1).filter(row => row !== '')) expect(row).toMatch(new RegExp(`^[${Object.values(TREE).join('')}]`))
})
