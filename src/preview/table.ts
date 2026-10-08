// Maintained mappings for Jira, Confluence and Slack mutation previews.
// Pure data: no $ or execution.
//
// Each root specifies its change kind, target arguments, value/body formats
// and deletion effects. The optional `read` stores a query and variable
// bindings for fetching current state. The mod does not run these queries
// because it does not call `execute`. Unit tests check their read-only shape.
// Mappings use Agent Services schemas inspected on Oct 7 2026.

import type { BodyFormat } from './flatten.ts'

export type ChangeKind = 'create' | 'update' | 'transition' | 'delete' | 'assign' | 'react'

/** How one argument of a mapped mutation reads in the CHANGES section. */
export type ArgReading =
  /** It names the target (or where a new record goes): said in the header, not as a row. */
  | { as: 'target' }
  /** Not part of the change: response shaping, history metadata, an idempotency key. */
  | { as: 'skip' }
  /** A value the call sets, one row. `label` replaces the argument's name; `back` is where the response says it again (below the root). */
  | { as: 'value'; label?: string; meaning: string; back?: string; /** Said dim, with no sign, when it holds this value: required on every call and almost always unchanged (Confluence's `status: current`). */ restatedWhen?: string; /** Numbers say a version: `version 13`. */ isVersion?: true }
  /** Rich text in a format: its lines. `formatArg` names the argument that says the format (Confluence's `bodyRepresentation`). */
  | { as: 'body'; label?: string; format: BodyFormat; formatArg?: string; meaning: string; back?: string }
  /** Jira's opaque `fields` JSON: one row per field it sets. */
  | { as: 'jira-fields'; skip?: string[] }
  /** Jira's opaque `update` JSON: its add, remove, set and edit operations. */
  | { as: 'jira-update' }
  /** Jira's `transition: { id }`. */
  | { as: 'transition' }
  /** A Jira account id to assign: `-1` and null are words. */
  | { as: 'assignee' }
  /** A Slack reaction's name, added or removed. */
  | { as: 'reaction'; sign: '+' | '-' }

/** Where a target is, said after its noun: `on DEV-634`, `in C0123`. `arg` may be a path into a JSON argument (`fields.project.key`). */
export type Where = { arg: string; words: string }

export type TargetSpec = {
  /** What the change is to: `issue`, `page`, `message`. */
  noun: string
  /** The arguments that name it, first set wins. */
  id?: string[]
  /** Where it sits or goes, each said when the call sets it. */
  where?: Where[]
}

/**
 * A variable of the stored read: the call path it takes (`transition.id`);
 * a value transform (what each call value becomes); or a projection, the keys
 * of the call's JSON arguments and fixed extras (Jira's `fields`, which the
 * schema cannot say: both of the call's arguments are opaque JSON).
 */
export type ReadVariable = string | { path: string; map: Record<string, string> } | { keysOf: string[]; plus?: string[] }

/** The read that would fetch the record's current state (v2): never run in v1. */
export type ReadSpec = {
  /** One named query, built from the schema alone: values reach it only as variables. */
  query: string
  /** Variable name (without `$`) → the call argument path it takes (`transition.id`). */
  variables: Record<string, ReadVariable>
  /** Where a before value is in the read's response and where the after value is: `read:` a path in the read, `arg:` one in the call. */
  pairs?: { label: string; before: string; after: string }[]
}

export type Mapping = {
  root: string
  kind: ChangeKind
  /** The section's label: `CHANGES`, or `NEW MESSAGE` for what a create makes. */
  section: string
  /** The label when an argument is set (`threadTs` makes a message a reply). */
  sectionWhen?: { arg: string; section: string }
  target: TargetSpec
  /**
   * The change in a few words, for the transcript line right above the dialog:
   * `{issueIdOrKey} → transition {transition.id}`. A `{path}` is the call's
   * value there, `{target}` the target in words, `{labels}` the changed
   * fields' labels, `{row:label}` that row's value; one the call left unset
   * reads `?`.
   */
  phrase: string
  /** The phrase when an argument is set (a reply in a thread). */
  phraseWhen?: { arg: string; phrase: string }
  /** Every argument the root takes (the Agent Services schema as read on Oct 7 2026), and how it reads; one not here reads as a plain value. */
  args: Record<string, ArgReading>
  /** A delete: whether the record can come back, said as a flag when it cannot and as the section's note when it can. */
  removal?: { isPermanent: boolean; words: string }
  /** What the call leaves as it is, said in the section's note (Slack keeps blocks an edit leaves out). */
  keeps?: string
  read?: ReadSpec
  /** The read when an argument is set (a reply also reads its thread's parent). */
  readWhen?: { arg: string; read: ReadSpec }
}

// ---- Reads (v2), as checked against the Agent Services schema as read on Oct 7 2026

const JIRA_TRANSITION = `query PreviewJiraTransition($issueIdOrKey: String!, $transition_id: String) {
  issue: jira_getIssue(issueIdOrKey: $issueIdOrKey, fields: ["status", "summary"]) { key fields }
  target: jira_getTransitions(issueIdOrKey: $issueIdOrKey, transitionId: $transition_id) {
    transitions { id name hasScreen isAvailable to { id name } }
  }
}`

const JIRA_EDIT = `query PreviewJiraEdit($issueIdOrKey: String!, $fields: [String]) {
  jira_getIssue(issueIdOrKey: $issueIdOrKey, fields: $fields, expand: "names,editmeta") { key fields names editmeta { fields } }
}`

const JIRA_ASSIGN = `query PreviewJiraAssign($issueIdOrKey: String!) {
  jira_getIssue(issueIdOrKey: $issueIdOrKey, fields: ["assignee", "summary"]) { key fields }
}`

const JIRA_COMMENT = `query PreviewJiraCommentChange($issueIdOrKey: String!, $id: ID!) {
  jira_getComment(issueIdOrKey: $issueIdOrKey, id: $id) { id body created updated author { displayName } visibility { type value } }
}`

const JIRA_DELETE_ISSUE = `query PreviewJiraDeleteIssue($issueIdOrKey: String!) {
  jira_getIssue(issueIdOrKey: $issueIdOrKey, fields: ["summary", "status", "issuetype", "assignee", "subtasks", "comment"]) { key fields }
}`

const JIRA_ISSUE_CONTEXT = `query PreviewJiraIssueContext($issueIdOrKey: String!) {
  jira_getIssue(issueIdOrKey: $issueIdOrKey, fields: ["summary"]) { key fields }
}`

const CONFLUENCE_PAGE = `query PreviewConfluencePageUpdate($id: ID!, $bodyFormat: String) {
  confluence_page(id: $id, bodyFormat: $bodyFormat) {
    id title status spaceId parentId
    version { number createdAt authorId message }
    body { storage { representation value } }
  }
}`

const CONFLUENCE_PAGE_DELETE = `query PreviewConfluencePageDelete($id: ID!) {
  confluence_page(id: $id, bodyFormat: "storage") {
    id title status spaceId parentId
    version { number createdAt authorId }
    body { storage { value } }
  }
}`

const CONFLUENCE_FOOTER = `query PreviewConfluenceCommentChange($id: ID!) {
  footer: confluence_footerComment(id: $id, bodyFormat: "storage") { id status version { number authorId } body { storage { value } } }
}`

const CONFLUENCE_INLINE = `query PreviewConfluenceInlineCommentChange($id: ID!) {
  inline: confluence_inlineComment(id: $id, bodyFormat: "atlas_doc_format") { id status version { number authorId } body { atlasDocFormat { value } } }
}`

const CONFLUENCE_PARENT = `query PreviewConfluenceNewComment($pageId: ID!) {
  confluence_page(id: $pageId) { id title version { number } }
}`

const SLACK_MESSAGE = `query PreviewSlackMessageChange($channel: ID!, $ts: String!) {
  slack_threadReplies(channel: $channel, ts: $ts, limit: 1) { messages { ts threadTs text user { id name } replyCount } }
}`

const SLACK_REACTION = `query PreviewSlackReaction($channel: ID!, $timestamp: String!) {
  slack_reactionGet(channel: $channel, timestamp: $timestamp) { channel message { ts text reactions { name count users } } }
}`

const SLACK_POST = `query PreviewSlackPost($channel: ID!) {
  slack_conversation(channel: $channel) { id name isPrivate isArchived isIm isMpim numMembers }
}`

const SLACK_REPLY = `query PreviewSlackReply($channel: ID!, $threadTs: String!) {
  slack_conversation(channel: $channel) { id name isPrivate isArchived isIm isMpim numMembers }
  parent: slack_threadReplies(channel: $channel, ts: $threadTs, limit: 1) { messages { ts text replyCount } }
}`

/** `bodyFormat ← bodyRepresentation`: the read takes the body in the format the call writes; wiki cannot be read back, so storage. */
const BODY_FORMAT: ReadVariable = { path: 'bodyRepresentation', map: { storage: 'storage', atlas_doc_format: 'atlas_doc_format', wiki: 'storage' } }

// ---- Argument readings shared by several roots

const SKIP: ArgReading = { as: 'skip' }
const TARGET: ArgReading = { as: 'target' }

const CONFLUENCE_BODY: ArgReading = { as: 'body', label: 'body', format: 'storage', formatArg: 'bodyRepresentation', meaning: 'the whole body, as the call writes it: it replaces what is there' }
const CONFLUENCE_NEW_BODY: ArgReading = { as: 'body', label: 'body', format: 'storage', formatArg: 'bodyRepresentation', meaning: 'the body of the new content' }
const CONFLUENCE_VERSION: ArgReading = { as: 'value', label: 'version', isVersion: true, back: 'version.number', meaning: 'the version this save makes. Confluence refuses the save unless the content is at the version before it now, so a stale number fails rather than overwriting someone else' }
const CONFLUENCE_VERSION_NOTE: ArgReading = { as: 'value', label: 'version note', back: 'version.message', meaning: "the note saved with this version in the content's history" }
const CONFLUENCE_TITLE: ArgReading = { as: 'value', label: 'title', back: 'title', meaning: 'the title it will have. Confluence needs the title on every update, so it may be the one it has now' }
const CONFLUENCE_STATUS: ArgReading = { as: 'value', label: 'status', back: 'status', restatedWhen: 'current', meaning: 'its state: current is published, draft is not. Confluence needs it on every update; current keeps it as it is' }
const REPRESENTATION: ArgReading = SKIP

/** How the change is made, not part of it: `notifyUsers: false` and the admin overrides are flags (./changes.ts), the form shows them all. */
const JIRA_NOTIFY: ArgReading = SKIP
const JIRA_OVERRIDE: ArgReading = SKIP
const JIRA_VISIBILITY: ArgReading = { as: 'value', label: 'visible to', meaning: 'who can read it: a role or a group only, rather than everyone who can see the issue' }
const JIRA_PROPERTIES: ArgReading = { as: 'value', label: 'properties', meaning: 'entity properties: data stored on the record for apps, not shown in Jira itself' }
const ADF_BODY = (meaning: string): ArgReading => ({ as: 'body', label: 'body', format: 'adf', meaning, back: 'body' })

const SLACK_TEXT = (meaning: string, back = 'message.text'): ArgReading => ({ as: 'body', label: 'text', format: 'mrkdwn', meaning, back })
const SLACK_BLOCKS: ArgReading = { as: 'body', label: 'blocks', format: 'blocks', meaning: "the message's layout blocks: when a message has them, Slack shows them in place of its text" }
const SLACK_ATTACHMENTS: ArgReading = { as: 'body', label: 'attachments', format: 'attachments', meaning: "legacy attachments shown under the message's text" }

// ---- The table

const MAPPINGS: readonly Mapping[] = [
  // Jira
  {
    root: 'jira_doTransition',
    kind: 'transition',
    section: 'CHANGES',
    target: { noun: 'issue', id: ['issueIdOrKey'] },
    phrase: '{issueIdOrKey} → transition {row:transition}',
    args: { issueIdOrKey: TARGET, transition: { as: 'transition' }, fields: { as: 'jira-fields' }, update: { as: 'jira-update' }, historyMetadata: SKIP, properties: JIRA_PROPERTIES },
    read: {
      query: JIRA_TRANSITION,
      variables: { issueIdOrKey: 'issueIdOrKey', transition_id: 'transition.id' },
      pairs: [{ label: 'status', before: 'read:issue.fields.status.name', after: 'read:target.transitions.0.to.name' }],
    },
  },
  {
    root: 'jira_editIssue',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'issue', id: ['issueIdOrKey'] },
    phrase: 'edits {issueIdOrKey}: {labels}',
    args: {
      issueIdOrKey: TARGET,
      notifyUsers: JIRA_NOTIFY,
      overrideScreenSecurity: JIRA_OVERRIDE,
      overrideEditableFlag: JIRA_OVERRIDE,
      returnIssue: SKIP,
      expand: SKIP,
      fields: { as: 'jira-fields' },
      historyMetadata: SKIP,
      properties: JIRA_PROPERTIES,
      transition: { as: 'transition' },
      update: { as: 'jira-update' },
    },
    read: { query: JIRA_EDIT, variables: { issueIdOrKey: 'issueIdOrKey', fields: { keysOf: ['fields', 'update'], plus: ['summary'] } } },
  },
  {
    root: 'jira_assignIssue',
    kind: 'assign',
    section: 'CHANGES',
    target: { noun: 'issue', id: ['issueIdOrKey'] },
    phrase: 'assigns {issueIdOrKey} to {row:assignee}',
    args: { issueIdOrKey: TARGET, accountId: { as: 'assignee' }, key: { as: 'assignee' }, name: { as: 'assignee' } },
    read: { query: JIRA_ASSIGN, variables: { issueIdOrKey: 'issueIdOrKey' }, pairs: [{ label: 'assignee', before: 'read:jira_getIssue.fields.assignee.displayName', after: 'arg:accountId' }] },
  },
  {
    root: 'jira_addComment',
    kind: 'create',
    section: 'NEW COMMENT',
    target: { noun: 'comment', where: [{ arg: 'issueIdOrKey', words: 'on' }] },
    phrase: 'comments on {issueIdOrKey}',
    args: { issueIdOrKey: TARGET, expand: SKIP, body: ADF_BODY('the text of the new comment'), properties: JIRA_PROPERTIES, visibility: JIRA_VISIBILITY },
    read: { query: JIRA_ISSUE_CONTEXT, variables: { issueIdOrKey: 'issueIdOrKey' } },
  },
  {
    root: 'jira_updateComment',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'comment', id: ['id'], where: [{ arg: 'issueIdOrKey', words: 'on' }] },
    phrase: 'edits comment {id} on {issueIdOrKey}',
    args: { issueIdOrKey: TARGET, id: TARGET, notifyUsers: JIRA_NOTIFY, overrideEditableFlag: JIRA_OVERRIDE, expand: SKIP, body: ADF_BODY("the comment's whole text: it replaces what is there"), properties: JIRA_PROPERTIES, visibility: JIRA_VISIBILITY },
    read: { query: JIRA_COMMENT, variables: { issueIdOrKey: 'issueIdOrKey', id: 'id' }, pairs: [{ label: 'body', before: 'read:jira_getComment.body', after: 'arg:body' }] },
  },
  {
    root: 'jira_deleteComment',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'comment', id: ['id'], where: [{ arg: 'issueIdOrKey', words: 'on' }] },
    phrase: 'deletes comment {id} on {issueIdOrKey}',
    args: { issueIdOrKey: TARGET, id: TARGET },
    removal: { isPermanent: true, words: 'Jira has no trash for comments: a deleted comment cannot be restored' },
    read: { query: JIRA_COMMENT, variables: { issueIdOrKey: 'issueIdOrKey', id: 'id' } },
  },
  {
    root: 'jira_deleteIssue',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'issue', id: ['issueIdOrKey'] },
    phrase: 'deletes {issueIdOrKey}',
    args: { issueIdOrKey: TARGET, deleteSubtasks: SKIP },
    removal: { isPermanent: true, words: 'Jira has no trash for issues: a deleted issue, its comments and its history cannot be restored' },
    read: { query: JIRA_DELETE_ISSUE, variables: { issueIdOrKey: 'issueIdOrKey' } },
  },
  {
    root: 'jira_createIssue',
    kind: 'create',
    section: 'NEW ISSUE',
    target: { noun: 'issue', where: [{ arg: 'fields.project.key', words: 'in' }, { arg: 'fields.project.id', words: 'in project' }] },
    phrase: 'creates an issue {target}',
    args: { updateHistory: SKIP, fields: { as: 'jira-fields', skip: ['project'] }, historyMetadata: SKIP, properties: JIRA_PROPERTIES, transition: { as: 'transition' }, update: { as: 'jira-update' } },
  },

  // Confluence
  {
    root: 'confluence_createPage',
    kind: 'create',
    section: 'NEW PAGE',
    target: { noun: 'page', where: [{ arg: 'spaceId', words: 'in space' }, { arg: 'parentId', words: 'under page' }] },
    phrase: 'creates a page {target}',
    args: { spaceId: TARGET, parentId: TARGET, title: { as: 'value', label: 'title', back: 'title', meaning: 'the title of the new page' }, status: { as: 'value', label: 'status', back: 'status', restatedWhen: 'current', meaning: 'current publishes the page; draft saves it unpublished' }, bodyRepresentation: REPRESENTATION, bodyValue: CONFLUENCE_NEW_BODY },
    read: { query: CONFLUENCE_PARENT, variables: { pageId: 'parentId' } },
  },
  {
    root: 'confluence_updatePage',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'page', id: ['id'] },
    phrase: 'edits page {id}: {labels}',
    args: {
      id: TARGET,
      status: CONFLUENCE_STATUS,
      title: CONFLUENCE_TITLE,
      spaceId: { as: 'value', label: 'space', back: 'spaceId', meaning: 'the space it will be in: a different one moves the page' },
      parentId: { as: 'value', label: 'parent page', back: 'parentId', meaning: 'the page it will sit under: a different one moves the page' },
      bodyRepresentation: REPRESENTATION,
      bodyValue: CONFLUENCE_BODY,
      versionNumber: CONFLUENCE_VERSION,
      versionMessage: CONFLUENCE_VERSION_NOTE,
    },
    read: {
      query: CONFLUENCE_PAGE,
      variables: { id: 'id', bodyFormat: BODY_FORMAT },
      pairs: [
        { label: 'body', before: 'read:confluence_page.body.storage.value', after: 'arg:bodyValue' },
        { label: 'version', before: 'read:confluence_page.version.number', after: 'arg:versionNumber' },
      ],
    },
  },
  {
    root: 'confluence_deletePage',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'page', id: ['id'] },
    phrase: 'deletes page {id}',
    args: { id: TARGET },
    removal: { isPermanent: false, words: "Confluence moves a deleted page to its space's trash, where it can be restored" },
    read: { query: CONFLUENCE_PAGE_DELETE, variables: { id: 'id' } },
  },
  {
    root: 'confluence_createBlogPost',
    kind: 'create',
    section: 'NEW BLOG POST',
    target: { noun: 'blog post', where: [{ arg: 'spaceId', words: 'in space' }] },
    phrase: 'creates a blog post {target}',
    args: { spaceId: TARGET, title: { as: 'value', label: 'title', back: 'title', meaning: 'the title of the new blog post' }, status: { as: 'value', label: 'status', back: 'status', restatedWhen: 'current', meaning: 'current publishes it; draft saves it unpublished' }, bodyRepresentation: REPRESENTATION, bodyValue: CONFLUENCE_NEW_BODY },
  },
  {
    root: 'confluence_updateBlogPost',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'blog post', id: ['id'] },
    phrase: 'edits blog post {id}: {labels}',
    args: { id: TARGET, status: CONFLUENCE_STATUS, title: CONFLUENCE_TITLE, bodyRepresentation: REPRESENTATION, bodyValue: CONFLUENCE_BODY, versionNumber: CONFLUENCE_VERSION, spaceId: { as: 'value', label: 'space', back: 'spaceId', meaning: 'the space it will be in: a different one moves it' }, versionMessage: CONFLUENCE_VERSION_NOTE },
  },
  {
    root: 'confluence_deleteBlogPost',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'blog post', id: ['id'] },
    phrase: 'deletes blog post {id}',
    args: { id: TARGET },
    removal: { isPermanent: false, words: "Confluence moves a deleted blog post to its space's trash, where it can be restored" },
  },
  {
    root: 'confluence_createFooterComment',
    kind: 'create',
    section: 'NEW COMMENT',
    target: { noun: 'comment', where: [{ arg: 'pageId', words: 'on page' }, { arg: 'blogPostId', words: 'on blog post' }, { arg: 'parentCommentId', words: 'replying to comment' }] },
    phrase: 'comments {target}',
    args: { pageId: TARGET, blogPostId: TARGET, parentCommentId: TARGET, bodyRepresentation: REPRESENTATION, bodyValue: { as: 'body', label: 'body', format: 'storage', formatArg: 'bodyRepresentation', meaning: 'the text of the new comment' } },
    read: { query: CONFLUENCE_PARENT, variables: { pageId: 'pageId' } },
  },
  {
    root: 'confluence_createInlineComment',
    kind: 'create',
    section: 'NEW COMMENT',
    target: { noun: 'inline comment', where: [{ arg: 'pageId', words: 'on page' }, { arg: 'blogPostId', words: 'on blog post' }, { arg: 'parentCommentId', words: 'replying to comment' }] },
    phrase: 'comments inline {target}',
    args: {
      bodyRepresentation: REPRESENTATION,
      bodyValue: { as: 'body', label: 'body', format: 'storage', formatArg: 'bodyRepresentation', meaning: 'the text of the new comment' },
      pageId: TARGET,
      blogPostId: TARGET,
      parentCommentId: TARGET,
      inlineMarkerRef: SKIP,
      inlineOriginalSelection: { as: 'value', label: 'anchored to', meaning: 'the passage of the page the comment is pinned to, as the call quotes it' },
    },
    read: { query: CONFLUENCE_PARENT, variables: { pageId: 'pageId' } },
  },
  {
    root: 'confluence_updateFooterComment',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'comment', id: ['id'] },
    phrase: 'edits comment {id}',
    args: { id: TARGET, bodyRepresentation: REPRESENTATION, bodyValue: { ...CONFLUENCE_BODY, meaning: "the comment's whole text: it replaces what is there" }, versionNumber: CONFLUENCE_VERSION, versionMessage: CONFLUENCE_VERSION_NOTE },
    read: { query: CONFLUENCE_FOOTER, variables: { id: 'id' } },
  },
  {
    root: 'confluence_updateInlineComment',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'inline comment', id: ['id'] },
    phrase: 'edits inline comment {id}',
    args: {
      id: TARGET,
      bodyRepresentation: REPRESENTATION,
      bodyValue: { ...CONFLUENCE_BODY, meaning: "the comment's whole text: it replaces what is there" },
      versionNumber: CONFLUENCE_VERSION,
      versionMessage: CONFLUENCE_VERSION_NOTE,
      resolved: { as: 'value', label: 'resolved', meaning: 'true marks the inline comment resolved, which hides it from the page; false opens it again' },
    },
    read: { query: CONFLUENCE_INLINE, variables: { id: 'id' } },
  },
  {
    root: 'confluence_deleteFooterComment',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'comment', id: ['id'] },
    phrase: 'deletes comment {id}',
    args: { id: TARGET },
    removal: { isPermanent: true, words: 'Confluence deletes a comment for good: it does not go to the trash' },
    read: { query: CONFLUENCE_FOOTER, variables: { id: 'id' } },
  },
  {
    root: 'confluence_deleteInlineComment',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'inline comment', id: ['id'] },
    phrase: 'deletes inline comment {id}',
    args: { id: TARGET },
    removal: { isPermanent: true, words: 'Confluence deletes a comment for good: it does not go to the trash' },
    read: { query: CONFLUENCE_INLINE, variables: { id: 'id' } },
  },

  // Slack
  {
    root: 'slack_sendMessage',
    kind: 'create',
    section: 'NEW MESSAGE',
    sectionWhen: { arg: 'threadTs', section: 'NEW REPLY' },
    target: { noun: 'message', where: [{ arg: 'channel', words: 'in' }, { arg: 'threadTs', words: 'in thread' }] },
    phrase: 'posts to {channel}',
    phraseWhen: { arg: 'threadTs', phrase: 'replies in a thread in {channel}' },
    args: {
      channel: TARGET,
      threadTs: TARGET,
      text: SLACK_TEXT('the text of the new message'),
      blocks: SLACK_BLOCKS,
      attachments: SLACK_ATTACHMENTS,
      replyBroadcast: SKIP,
      mrkdwn: SKIP,
      unfurlLinks: { as: 'value', label: 'unfurl links', meaning: 'whether Slack shows a preview under the links in the text' },
      unfurlMedia: { as: 'value', label: 'unfurl media', meaning: 'whether Slack shows images and video the links point to' },
      username: { as: 'value', label: 'posts as', meaning: 'the name the message shows instead of yours (or the app’s)' },
      iconEmoji: { as: 'value', label: 'icon', meaning: 'the emoji the message shows as its sender’s picture' },
      iconUrl: { as: 'value', label: 'icon', meaning: 'the image the message shows as its sender’s picture' },
    },
    read: { query: SLACK_POST, variables: { channel: 'channel' } },
    readWhen: { arg: 'threadTs', read: { query: SLACK_REPLY, variables: { channel: 'channel', threadTs: 'threadTs' } } },
  },
  {
    root: 'slack_updateMessage',
    kind: 'update',
    section: 'CHANGES',
    target: { noun: 'message', id: ['ts'], where: [{ arg: 'channel', words: 'in' }] },
    phrase: 'edits message {ts} in {channel}',
    args: { channel: TARGET, ts: TARGET, text: SLACK_TEXT("the message's whole text: it replaces what is there", 'text'), blocks: SLACK_BLOCKS, attachments: SLACK_ATTACHMENTS },
    keeps: 'blocks and attachments it leaves out stay as they are',
    read: { query: SLACK_MESSAGE, variables: { channel: 'channel', ts: 'ts' }, pairs: [{ label: 'text', before: 'read:slack_threadReplies.messages[ts=$ts].text', after: 'arg:text' }] },
  },
  {
    root: 'slack_deleteMessage',
    kind: 'delete',
    section: 'CHANGES',
    target: { noun: 'message', id: ['ts'], where: [{ arg: 'channel', words: 'in' }] },
    phrase: 'deletes message {ts} in {channel}',
    args: { channel: TARGET, ts: TARGET },
    removal: { isPermanent: true, words: 'Slack has no trash for messages: a deleted message cannot be restored' },
    read: { query: SLACK_MESSAGE, variables: { channel: 'channel', ts: 'ts' } },
  },
  {
    root: 'slack_addReaction',
    kind: 'react',
    section: 'CHANGES',
    target: { noun: 'message', id: ['timestamp'], where: [{ arg: 'channel', words: 'in' }] },
    phrase: 'reacts {row:reaction} to {target}',
    args: { channel: TARGET, timestamp: TARGET, name: { as: 'reaction', sign: '+' } },
    read: { query: SLACK_REACTION, variables: { channel: 'channel', timestamp: 'timestamp' } },
  },
  {
    root: 'slack_removeReaction',
    kind: 'react',
    section: 'CHANGES',
    target: { noun: 'message', id: ['timestamp', 'file', 'fileComment'], where: [{ arg: 'channel', words: 'in' }] },
    phrase: 'removes {row:reaction} from {target}',
    args: { name: { as: 'reaction', sign: '-' }, channel: TARGET, timestamp: TARGET, file: TARGET, fileComment: TARGET },
    read: { query: SLACK_REACTION, variables: { channel: 'channel', timestamp: 'timestamp' } },
  },
]

const BY_ROOT = new Map(MAPPINGS.map(mapping => [mapping.root, mapping] as const))

/** The hand-mapped reading of a mutation root, by its real name; undefined for any other. */
export function mappingOf(root: string): Mapping | undefined {
  return BY_ROOT.get(root)
}

/** Every hand-mapped mutation, in the table's order. */
export const MAPPED: readonly Mapping[] = MAPPINGS

/**
 * What the common Jira fields are, in words, for a row's card: the schema
 * types Jira's `fields` as opaque JSON, so it describes none of them.
 */
export const JIRA_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  summary: "the issue's one-line title",
  description: "the issue's long text, in Atlassian rich text",
  labels: 'free-form tags on the issue',
  priority: 'how urgent the issue is, as one of the priorities Jira is set up with',
  assignee: 'who the issue is assigned to, by account id',
  reporter: 'who the issue is said to come from, by account id',
  duedate: 'the date the issue is due, as YYYY-MM-DD',
  components: "the project's components the issue belongs to",
  fixVersions: 'the versions the issue is fixed in',
  versions: 'the versions the issue affects',
  environment: 'where the issue happens, in rich text',
  issuetype: 'the kind of issue: a bug, a task, a story',
  parent: 'the issue this one sits under (an epic, or the issue a subtask belongs to)',
  resolution: 'how the issue was closed: done, won’t do, duplicate',
  timetracking: 'the original and remaining time estimates',
  comment: 'a comment on the issue',
  status: "the issue's workflow status; Jira changes it only through a transition",
  security: 'the security level: who may see the issue at all',
  project: 'the project the issue is in',
})
