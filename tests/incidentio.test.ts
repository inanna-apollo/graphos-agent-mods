// The incident.io RecentIncidents call, settled, through the text renderer at 50 and 64 columns.
import type { InspectedCall } from '../types'
import { expect, test } from 'claude-code/testing'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf } from '../src/result.ts'
import { indexSdl } from '../src/schema.ts'
import { displayWidth, renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, viewOf } from '../src/view.tsx'
import { GLYPH } from '../src/view/ui/theme.ts'

const OPERATION = `query RecentIncidents($size: Int) {
  incidentio_incidents(pageSize: $size, statusCategory: ["live","closed"]) {
    reference name createdAt severity { name rank } incidentStatus { name category }
    creator { user { name email } } incidentRoleAssignments { role { name } assignee { name email } }
  }
}`
const SDL = [
  `type Query { "List all incidents for an organisation." incidentio_incidents(pageSize: Int, statusCategory: [String]): [IncidentIO_Incident] }`,
  `type IncidentIO_Incident { reference: String! name: String! createdAt: String! severity: IncidentIO_Severity incidentStatus: IncidentIO_Status creator: IncidentIO_Actor incidentRoleAssignments: [IncidentIO_IncidentRoleAssignment] }`,
  `type IncidentIO_Severity { name: String! rank: Int! } type IncidentIO_Status { name: String! category: String! }`,
  `type IncidentIO_Actor { user: IncidentIO_UserSlim } type IncidentIO_UserSlim { id: ID! name: String! email: String }`,
  `type IncidentIO_IncidentRoleAssignment { role: IncidentIO_IncidentRoleEmbed assignee: IncidentIO_UserSlim } type IncidentIO_IncidentRoleEmbed { name: String! }`,
]

function call(): InspectedCall {
  const ir = annotate(buildIR('toolu_inc', normalize(OPERATION, { size: 4 })), {
    schema: indexSdl(SDL),
    access: { denyOperation: false, fields: new Map() },
    validation: { valid: true, diagnostics: [] },
    scope: 'incidentio',
    isIncomplete: false,
  })
  const incidents = ['Checkout latency above target', 'Search results delayed', 'High error rate on the example service', 'Example outage drill'].map((name, index) => ({
    reference: `INC-${index}`,
    name,
    createdAt: `2026-10-0${index + 1}T07:00:00Z`,
  }))
  const text = JSON.stringify({ data: { incidentio_incidents: incidents } })
  return {
    id: 'toolu_inc',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation: OPERATION,
    variables: JSON.stringify({ size: 4 }, null, 2),
    status: 'ran',
    arrivedAt: Date.UTC(2026, 9, 6),
    ir,
    outcome: outcomeOf(ir, { content: [{ type: 'text', text }] }),
  }
}

for (const columns of [50, 64]) {
  test(`incident.io, settled, at ${columns} columns`, () => {
    const text = renderText(viewOf(stubKit(), { call: call(), waiting: 0 }, columns, CLOSED, undefined, { surface: 'terminal' }), columns, { clip: false })
    const rows = text.split('\n')
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    // The verb gutter is never blank.
    expect(text.replace(/\s+/g, ' ')).toMatch(/LIST\s+incidentio_incidents/)
    // Exactly the two email leaves are marked, with the one personal-data glyph the pane uses everywhere.
    expect(rows.filter(row => row.includes(GLYPH.personal)).length).toBe(2)
    // People carry a quiet tag, once.
    expect(text).toMatch(/creator\s+person/)
    expect(text).toMatch(/user\s+person/)
    expect(text).toMatch(/assignee\s+person/)
    // The tree says it where each email sits; the notes strip does not say it again, and the person objects are never marked.
    expect(text.match(/personal data/g)).toHaveLength(2)
    expect(text).not.toMatch(/creator\s+personal data/)
    expect(text.replace(/\s+/g, ' ')).toMatch(/statusCategory\s+live\s*·\s*closed/)
    expect(text).not.toMatch(/undefined|\[object|null/)
  })
}
