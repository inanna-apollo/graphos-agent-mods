// Writes the pane previews, for the text renderer and the pane tests: a Jira
// transition, a Jira field edit with a rich-text description, a Confluence
// page update with a storage-format body (pending, and settled with the
// response confirming its title and version), a Slack post with @channel, an
// issue delete, and a mutation the hand-mapped table does not know. Shapes
// from the Agent Services schema as read on Oct 7 2026, on the neutral DEV key,
// with every field allowed.
import type { InspectedCall } from '../types'

import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import type { CallIR, Summary } from '../src/ir.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf } from '../src/result.ts'
import { indexSdl } from '../src/schema.ts'
import { LINKS } from '../test/unit/link-fixture.ts'

const SDL = [
  `type Mutation {
    "Performs an issue transition and, if the transition has a screen, updates the fields from the transition screen."
    jira_doTransition("The ID or key of the issue." issueIdOrKey: String!, "Details of a transition. Required when performing a transition, optional when creating or editing an issue." transition: Jira_JSON, fields: Jira_JSON, update: Jira_JSON, historyMetadata: Jira_JSON, properties: Jira_JSON): Jira_JSON
    "Edits an issue. Either fields or update can be used to set a field."
    jira_editIssue("The ID or key of the issue." issueIdOrKey: String!, "Whether a notification email about the issue update is sent to all watchers." notifyUsers: Boolean, overrideScreenSecurity: Boolean, overrideEditableFlag: Boolean, returnIssue: Boolean, expand: String, "List of issue screen fields to update, specifying the sub-field to update and its value for each field." fields: Jira_JSON, historyMetadata: Jira_JSON, properties: Jira_JSON, transition: Jira_JSON, "A Map containing the field field name and a list of operations to perform on the issue screen field." update: Jira_JSON): Jira_JSON
    "Deletes an issue. An issue cannot be deleted if it has one or more subtasks unless deleteSubtasks is true."
    jira_deleteIssue("The ID or key of the issue." issueIdOrKey: String!, "Whether the issue's subtasks are deleted when the issue is deleted." deleteSubtasks: String): Jira_JSON
    "Update a page by id."
    confluence_updatePage(id: ID!, "The updated status of the page." status: String!, "Title of the page." title: String!, spaceId: String, parentId: String, bodyRepresentation: String!, "Body of the page, in the format found in representation." bodyValue: String!, "The new version number: the current one plus one." versionNumber: Int!, versionMessage: String): Confluence_Page
    "Sends a message to a channel."
    slack_sendMessage("Channel, private group, or IM channel to send message to." channel: ID!, "The formatted text of the message to be published." text: String, threadTs: String, blocks: String, attachments: String, replyBroadcast: Boolean, mrkdwn: Boolean, unfurlLinks: Boolean, unfurlMedia: Boolean, username: String, iconEmoji: String, iconUrl: String): Slack_SendMessageResult
    "Edit an incident."
    incidentio_editIncident("The incident's ID." id: ID!, "Whether the incident channel hears about this edit." notifyIncidentChannel: Boolean!, "Explanation of the incident." name: String, summary: String, severityId: ID, incidentStatusId: ID): IncidentIO_Incident
  }`,
  'scalar Jira_JSON',
  'type Confluence_Page { id: ID! status: String title: String version: Confluence_Version }',
  'type Confluence_Version { number: Int message: String }',
  'type Slack_SendMessageResult { channel: String! ts: String! message: Slack_SentMessage! }',
  'type Slack_SentMessage { text: String ts: String }',
  'type IncidentIO_Incident { id: ID name: String }',
]

const SCOPES: Record<string, string> = { jira: 'jira', confluence: 'confluence', slack: 'slack', incidentio: 'incidentio' }

/** A mutation's IR as enrichment leaves it: the schema read, every field allowed. */
function irOf(operation: string, variables: Record<string, unknown> = {}): CallIR {
  const ir = buildIR('toolu_write', normalize(operation, variables))
  const fields = new Map<string, FieldDecision>()
  const visit = (field: CallIR['roots'][number]) => {
    fields.set(field.path, { decision: 'allow' })
    field.children.forEach(visit)
  }
  ir.roots.forEach(visit)
  const scope = SCOPES[ir.roots[0]?.name.split('_')[0] ?? ''] ?? 'jira'
  const annotated = annotate(ir, { schema: indexSdl(SDL), access: { denyOperation: false, fields }, validation: { valid: true, diagnostics: [] }, scope, isIncomplete: false })
  for (const root of annotated.roots) root.service = SCOPES[root.name.split('_')[0] ?? ''] ?? scope
  return { ...annotated, services: [...new Set(annotated.roots.map(root => root.service ?? ''))] }
}

function callOf(id: string, operation: string, variables: Record<string, unknown>, headline: string, ran?: unknown): InspectedCall {
  const ir: CallIR = { ...irOf(operation, variables), summary: { headline } as Summary }
  return {
    id,
    server: 'claude_ai_GraphOS_Agent_Services',
    operation,
    variables: JSON.stringify(variables, null, 2),
    status: ran === undefined ? 'pending' : 'ran',
    arrivedAt: Date.UTC(2026, 9, 7),
    ir,
    ...(ran !== undefined && { outcome: outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify(ran) }] }, LINKS) }),
  }
}

/** A Jira transition: DEV-634 through transition 31, a comment added on the way. */
export function transitionCall(): InspectedCall {
  const operation = `mutation CloseDev634($comment: Jira_JSON) {
  jira_doTransition(issueIdOrKey: "DEV-634", transition: { id: "31" }, update: $comment)
}`
  const comment = { comment: [{ add: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shipped in 2.4; closing.' }] }] } } }] }
  return callOf('toolu_transition', operation, { comment }, 'Move DEV-634 through transition 31 with a closing comment.')
}

/** A Jira field edit: a new summary, a rich-text description of headings, a list and code, labels added and removed, watchers not told. */
export function editCall(): InspectedCall {
  const operation = `mutation EditDev634($fields: Jira_JSON, $update: Jira_JSON) {
  jira_editIssue(issueIdOrKey: "DEV-634", notifyUsers: false, fields: $fields, update: $update)
}`
  const description = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Add CSV export to the reports page, so a report can be downloaded and shared before anyone reviews it.' }] },
      { type: 'bulletList', content: ['export first', 'then download', 'then share the link'].map(text => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) },
      { type: 'codeBlock', content: [{ type: 'text', text: 'reports export --all\nreports open' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the design', marks: [{ type: 'link', attrs: { href: 'https://example.atlassian.net/wiki/spaces/DEV/pages/42' } }] }, { type: 'text', text: '.' }] },
    ],
  }
  return callOf(
    'toolu_edit',
    operation,
    { fields: { summary: 'Add CSV export to the reports page', description, priority: { id: '2' } }, update: { labels: [{ add: 'backend' }, { remove: 'frontend' }] } },
    'Retitle DEV-634, rewrite its description and swap the frontend label for backend.',
  )
}

const RUNBOOK = [
  '<h2>Escalation</h2>',
  '<p>Page the primary on-call through incident.io.</p>',
  '<p>If nobody answers within 10 minutes, page the secondary on-call and then the engineering manager for the service.</p>',
  '<ul><li><p>Do not page the whole team channel.</p></li><li><p>Post a summary in <ac:link><ri:page ri:content-title="Ops channel guide"/></ac:link> once it is resolved.</p></li></ul>',
  '<h2>Contacts</h2>',
  '<table><tbody><tr><th>Team</th><th>Channel</th></tr><tr><td>Database</td><td>#db-oncall</td></tr><tr><td>Platform</td><td>#platform</td></tr></tbody></table>',
  '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[pd trigger --service db\npd ack]]></ac:plain-text-body></ac:structured-macro>',
].join('')

const PAGE_OP = `mutation UpdateRunbook($body: String!) {
  confluence_updatePage(id: "123456789", status: "current", title: "On-call runbook", bodyRepresentation: "storage", bodyValue: $body, versionNumber: 13, versionMessage: "Escalation through incident.io") { id title version { number } }
}`

/** A Confluence page update: a storage-format body with headings, a list, a link, a table and a code macro; pending, or settled with the response saying back its title and version. */
export function pageCall(status: 'pending' | 'ran' = 'pending'): InspectedCall {
  const response = { data: { confluence_updatePage: { id: '123456789', title: 'On-call runbook', version: { number: 13 } } } }
  return callOf('toolu_page', PAGE_OP, { body: RUNBOOK }, 'Replace the escalation steps on the On-call runbook page and save it as version 13.', status === 'ran' ? response : undefined)
}

/** A Slack post to a channel whose text holds <!channel>, with a list, a link and an emoji. */
export function postCall(): InspectedCall {
  const operation = `mutation PostReleaseNote($text: String) {
  slack_sendMessage(channel: "C0123456789", text: $text) { ts message { text } }
}`
  const text = '<!channel> Release 2.4 is out :rocket:\n• Search is about twice as fast\n• Fixed <https://example.atlassian.net/browse/DEV-702|the login loop>\nThanks to <@U02ABC123> for the report.'
  return callOf('toolu_post', operation, { text }, 'Post the 2.4 release note to the channel, mentioning everyone in it.')
}

/** An issue delete, its subtasks with it. */
export function deleteCall(): InspectedCall {
  return callOf('toolu_delete', 'mutation DropDev634 { jira_deleteIssue(issueIdOrKey: "DEV-634", deleteSubtasks: "true") }', {}, 'Delete DEV-634 and its subtasks.')
}

/** A mutation the table does not map: an incident.io edit, read from its arguments and the schema. */
export function unmappedCall(): InspectedCall {
  const operation = `mutation RenameIncident {
  incidentio_editIncident(id: "01HXYZINCIDENT", notifyIncidentChannel: false, name: "Database failover in eu-west", summary: "The primary failed over to the replica.\\nWrites paused for 40 seconds.") { id name }
}`
  return callOf('toolu_unmapped', operation, {}, 'Rename incident 01HXYZINCIDENT and rewrite its summary, without telling its channel.')
}
