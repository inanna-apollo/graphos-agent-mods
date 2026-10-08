// The OrgAdmins call (a list whose email field is denied once per item), through the text renderer.
import type { InspectedCall } from '../types'
import { expect, test } from 'claude-code/testing'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf } from '../src/result.ts'
import { indexSdl } from '../src/schema.ts'
import { displayWidth, renderText, stubKit } from '../src/snapshot/text.ts'
import { CLOSED, viewOf } from '../src/view.tsx'

const ROOT = 'acme_customer_data_listOrganizationMembers'
const OPERATION = `query OrgAdmins($org: ID!) { ${ROOT}(orgId: $org) { id name role email } }`
const SDL = [
  `type Query { ${ROOT}(orgId: ID!): [Acme_Customer_Data_Member] }`,
  'type Acme_Customer_Data_Member { id: ID name: String role: Acme_Customer_Data_Role """Personal contact data (x-data-classification: pii.contact in the source).""" email: String }',
]

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const TOKEN = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({
  app_id: 'app-secret',
  principal_id: 'principal-secret',
  service_name: 'acme-customer-data',
  blocked_fields: [{ coord: 'Acme_Customer_Data_Member.email', classification: 'pii-high', reason: '', rule_id: 'rule-secret' }],
  request_id: 'request-secret',
})}.${b64('signature')}`

function orgCall(status: InspectedCall['status']): InspectedCall {
  const fields = new Map<string, FieldDecision>()
  for (const path of [ROOT, `${ROOT}.id`, `${ROOT}.name`, `${ROOT}.role`]) fields.set(path, { decision: 'allow' })
  fields.set(`${ROOT}.email`, { decision: 'deny' })
  const ir = annotate(buildIR('toolu_org', normalize(OPERATION, { org: 'demo-org-01' })), {
    schema: indexSdl(SDL),
    access: { denyOperation: false, fields },
    validation: { valid: true, diagnostics: [] },
    scope: 'acme-customer-data',
    isIncomplete: false,
  })
  const errors = [0, 1, 2, 3].map(index => ({
    extensions: { code: 'CONSTELLATION_ACCESS_DENIED', denial_context: TOKEN, visibility: 'requestable', reason: '' },
    message: '',
    path: [ROOT, String(index), 'email'],
  }))
  const members = ['Leo Marsh', 'Sam Ito', 'Dana Okafor', 'Jordan Lee'].map((name, index) => ({ id: `mem_${index}`, name, role: 'ADMIN', email: null }))
  const text = JSON.stringify({ data: { [ROOT]: members }, errors })
  return {
    id: 'toolu_org',
    server: 'claude_ai_GraphOS_Agent_Services',
    operation: OPERATION,
    variables: JSON.stringify({ org: 'demo-org-01' }, null, 2),
    status,
    arrivedAt: Date.UTC(2026, 9, 6),
    ir,
    ...(status === 'ran' && { outcome: outcomeOf(ir, { content: [{ type: 'text', text }] }) }),
  }
}

for (const columns of [50, 64]) {
  for (const status of ['pending', 'ran'] as const) {
    test(`OrgAdmins, ${status}, at ${columns} columns`, () => {
      const text = renderText(viewOf(stubKit(), { call: orgCall(status), waiting: 0 }, columns, CLOSED, undefined, { surface: 'terminal' }), columns, { clip: false })
      const lines = text.split('\n')
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
      // No plumbing, and no limit note: the root takes only orgId.
      expect(text).not.toMatch(/secret|eyJ|rule-|request-/)
      expect(text).not.toMatch(/no limit/)
      // The list is named by its items; the type prefix is gone.
      expect(text).toMatch(/list of members/)
      expect(text).not.toMatch(/customer data member/)
      // The field's policy and its one classification together, on its name in the tree, said once.
      expect(text.replace(/\s+/g, ' ')).toMatch(/email\s+denied\s*·\s*pii\.contact/)
      expect(text.match(/pii\.contact/g)).toHaveLength(1)
      expect(text).not.toMatch(/1 field denied|personal data: email/)
      // The flags line says what the denial costs: the field while pending, the rows once it ran.
      expect(text.replace(/\s+/g, ' ')).toMatch(status === 'pending' ? /email denied\b/ : /email denied for 4 members/)
      if (status === 'pending') return
      // Each member row carries its own tag; no standalone line says it again.
      const rows = lines.filter(line => line.includes('mem_'))
      expect(rows).toHaveLength(4)
      for (const row of rows) expect(row).toMatch(/✕ email/)
      // No RESULT line says the denial a fourth time.
      expect(lines.filter(line => /^ *✕ +email denied/.test(line))).toHaveLength(0)
      // Words may wrap, identifiers may not.
      const flat = text.replace(/\s+/g, ' ')
      // A denied field carries its policy mark, not a marker, and one classification: the schema's.
      expect(flat).toMatch(/✕ email denied · pii\.contact/)
      expect(flat).not.toMatch(/pii-high/)
      expect(text).toMatch(/4 members/)
      // The status is the word alone: the counts and the flags carry the denial.
      expect(text).toMatch(/\bran\b/)
      expect(lines[0]).not.toMatch(/denied/i)
      expect(text).not.toMatch(/4 errors/)
      // Nothing of a path on screen, so nothing wraps mid-identifier.
      expect(text).not.toMatch(/\.\d\.email|\.\*\./)
    })
  }
}
