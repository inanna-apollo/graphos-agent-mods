// ---- The annotated IR (re-exported by src/ir.ts) ----
//
// Trust: `opType`, real field names, `policy` and `validation` are facts the
// mod derived itself. `description`, argument values and anything the model
// or schema wrote are untrusted text: escape when drawn, fence as data when
// handed to a model.

export type OpType = 'query' | 'mutation' | 'subscription'
export type Policy = 'allow' | 'mask' | 'deny' | 'unknown'

/** What we learned about a field from the schema; absent until introspect answers. */
export type FieldSchema = {
  /** The field's type as SDL writes it, e.g. `[Confluence_SearchResultItem!]`. */
  type: string
  isList: boolean
  /** The outer type is non-null (`T!`, `[T]!`). */
  isNonNull: boolean
  /** A list whose items are non-null (`[T!]`). */
  isListItemNonNull: boolean
  /** A list that is itself non-null (`[T]!`). */
  isListNonNull: boolean
  /** Untrusted schema text. */
  description?: string
  /** Short normalized hints from the description (`classified pii.contact` from an `x-data-classification` annotation; "max 100", "default web", "timezone Pacific Time", "one of A|B", "requires a bounded query"); untrusted, each at most 80 characters. */
  hints?: string[]
  deprecated?: string
  /** Scopes named in the description ("Requires the search:confluence … scopes"). */
  scopes: string[]
  /** Any other directives introspect showed, by name. */
  tags: string[]
  /** The description says the field is returned only (`only`) or in full (`full`) when the root's `include` argument has `value`. */
  requiresInclude?: { arg: 'include'; value: string; mode: 'only' | 'full' }
  /** The field's value is opaque JSON: no sub-selection. */
  isOpaque?: boolean
}

export type ArgIR = {
  name: string
  /** The argument's declared type, once introspect answers. */
  type?: string
  /** The declared default as a printed literal (`10`, `EQUALS`, `"and"`). */
  defaultValue?: string
  /** Untrusted schema text. */
  description?: string
  /** Values of the argument's named type when it is an enum in the SDL. */
  enumValues?: string[]
  /** Short normalized hints from the description; untrusted, each at most 80 characters. */
  hints?: string[]
  /** Untrusted: whatever the model sent, after variable substitution. */
  value: unknown
  fromVariable: boolean
  /** Which renderer draws it (`cql`, `jql`, `slack`, `id`, `url`, `date`); chosen by name and type, never by a model. */
  renderer?: Renderer
}

export type Renderer = 'cql' | 'jql' | 'slack' | 'id' | 'url' | 'date'

/** A declared argument the call did not set. */
export type OmittedArg = {
  name: string
  type: string
  default?: string
  /** Untrusted schema text. */
  description?: string
  /** Non-null with no default: the call would fail without it. */
  isRequired: boolean
  /** Values of its named type when that is an enum the SDL defines (at most 40). */
  enumValues?: string[]
  /** `name: Type` for each field of its named type when that is an input object the SDL defines (at most 40). */
  inputFields?: string[]
}

/** How a list-returning root pages, from argument and response-field names. */
export type Paging = {
  kind: 'cursor' | 'offset' | 'page' | 'token'
  /** The paging arguments the field declares. */
  via: string[]
  /** None of the paging arguments is set, or each is set to where a list begins (`startAt: 0`, a null token, `page: 1`). */
  isFirstPage: boolean
  /** The response field that signals more results, e.g. `hasMoreResults`, `next`. */
  moreField?: string
  /** A boolean that says whether more remains (`hasMoreResults`, `isLast`), when the continuation is a token field. */
  flagField?: string
  /** `page` paging: the response's count of pages (`pageCount`); the next page is `page + 1`. */
  pageCountField?: string
}

export type FieldIR = {
  /** The real field name: never the alias. */
  name: string
  /** The response key the caller gave the field; shown beside a root's name. */
  alias?: string
  /** On a root: the Agent Services scope it was checked against. */
  service?: string
  /** On a dry_run root: its original request's zero-based position and operation kind. Absent in older stored calls. */
  request?: { index: number; opType: OpType }
  /** `Parent.field` once the parent type is known, else the bare name. */
  coordinate: string
  /** The dry_run path: response keys (alias ?? name) joined by dots. */
  path: string
  /** Type condition it was selected under, if any. */
  onType?: string
  args: ArgIR[]
  /** Declared arguments the call did not set (when the schema is known and the field takes args). */
  omittedArgs?: OmittedArg[]
  /** Set on a root whose response is a list and which takes paging arguments. */
  paging?: Paging
  schema?: FieldSchema
  policy: Policy
  denialContext?: string
  children: FieldIR[]
}

export type Validation = { valid: boolean; diagnostics: string[] }

export type CallState =
  | 'analyzing' // parsed; enrichment in flight
  | 'ready' // parsed and enriched
  | 'partial' // parsed; some enrichment failed or is still out
  | 'invalid' // validate returned diagnostics: the call will fail
  | 'unparseable' // could not parse or normalize: show the raw operation

/**
 * Haiku's best-effort reading of a call: one headline. Untrusted model text
 * (escape when drawn); the computed policy and scopes are the facts.
 */
export type Summary = {
  /** One sentence the prompt asks to keep near 90 characters; only bounded, never cut. */
  headline: string
}

/** How one enrichment check went, so the pane can say why something is unknown. */
export type CheckOutcome = 'ok' | 'not-allowed' | 'failed' | 'skipped'
export type CheckTarget =
  | { kind: 'call' }
  | { kind: 'scope'; scope: string; opType?: OpType }
  | { kind: 'request'; scope: string; index: number }
  | { kind: 'root'; path: string }

/** Bounded evidence about one check, not the execution result or permission to run it. */
export type CheckContext = {
  check: 'policy' | 'validation' | 'schema'
  target: CheckTarget
  source: 'enrichment' | 'tool-response'
  /** The short tool name when the evidence identifies it; never an MCP tool id. */
  tool?: LookupTool
} & (
  | { outcome: 'ok'; operationDenied?: boolean }
  | { outcome: 'not-allowed'; decision: 'allow' | 'ask' | 'deny'; ceiling?: 'allow' | 'ask' | 'deny' }
  | { outcome: 'failed'; reason: 'request-failed' | 'missing-data' | 'analysis-timeout' | 'bundle-changed'; message?: string }
  | { outcome: 'skipped'; reason: 'unclaimed-service' | 'operation-unavailable' | 'not-applicable' }
)

export type Checks = {
  policy: CheckOutcome
  validation: CheckOutcome
  schema: CheckOutcome
  /** Optional in legacy records; at most 128 contexts, each diagnostic at most 300 characters. */
  context?: CheckContext[]
  contextOmitted?: number
  /** A short error from Agent Services when a check failed (untrusted; escaped when drawn). */
  error?: string
}

export type CallIR = {
  toolCallId: string
  /** Agent Services scope, e.g. `confluence`; resolved per root field, this is the first root's. */
  service?: string
  /** Every service the call's roots touch, each once, in the order they appear (provisional name prefixes until scopes resolve). */
  services?: string[]
  opType?: OpType
  opName?: string
  bundleDigest?: string
  state: CallState
  /** Why the call is unparseable, when it is. */
  failure?: string
  validation?: Validation
  /** How each enrichment check went; absent until enrichment ran. */
  checks?: Checks
  /** Whether dry_run refused the whole operation. */
  isOperationDenied?: boolean
  roots: FieldIR[]
  /** The normalized operation (fragments inlined, aliases kept) for the raw view. */
  printed?: string
  summary?: Summary
  /** The summary request is out (set while the call is pending, cleared when it answers or fails): the pane shimmers the headline meanwhile. */
  isSummarizing?: boolean
}

/**
 * What a settled call returned: counts, GraphQL error codes and paths, and
 * service-link URLs. Never response values. Untrusted; escaped when drawn.
 */
export type CallOutcome = {
  /** The main list under each root (its own rows, not a facet or warning list beside them): its real field name, rows returned, and a sibling total if the response has one. */
  rows: {
    field: string
    count: number
    total?: number
    /** The response key of the root the list is under (its alias, else its name): two roots' lists can share a field name. Absent in outcomes stored before it was kept. */
    root?: string
  }[]
  /**
   * Scalar fields directly under a root (or under its object, one level down): numbers, booleans, null, numeric strings only.
   * A total a `rows` entry already carries is not repeated here.
   */
  scalars?: {
    field: string
    value: number | boolean | null | string
    /** The response key of the root it sits under (its alias, else its name), as `rows` carry it; absent on a root's own value. Outcomes stored before this held the root's real name. */
    root?: string
    /** Where the value sits in the response, by response keys (`open.count`, or a root's own key). Absent in outcomes stored before it was kept. */
    path?: string
    /** It is the only field selected under that root. */
    isOnly?: boolean
  }[]
  errors: {
    message: string
    code?: string
    /** The response path with list indices as `*` (`root.*.email`). */
    path?: string
    /** The real name of the field at the path. */
    field?: string
    isDenied?: boolean
    /** Errors folded into this entry: distinct items with the same code and normalized path, or, at no path, errors with the same code and message. Absent is 1. At most 50 entries are kept. */
    count?: number
    /** The length of the list the indices run through, when there is exactly one. */
    of?: number
    /** A policy denial of a field the pane already marked denied. */
    isExpected?: boolean
    /** Agent Services' classification of the denied field (`pii-high`), from the denial token: at most 20 characters of `[a-z0-9.-]`. Nothing else of the token is kept. */
    classification?: string
    /** The denial's visibility is `requestable`. */
    isRequestable?: boolean
    /** The denial carried a denial_context token, which an access request can use. The token itself is never kept. */
    hasToken?: boolean
    /** From the denial token, each shape-checked and bounded: the field's schema coordinate (`Slack_User.realName`), the service name (`slack`), and the policy's reason. */
    coord?: string
    service?: string
    reason?: string
  }[]
  /**
   * Per root (response key) and denied response path: in how many distinct rows of the root's list Agent Services denied it, over every
   * path it was denied by and whether or not the row is shown. Counted at settle; absent in outcomes stored before it was kept.
   */
  denials?: {
    root: string
    field: string
    /** Absolute response-key path with list indices removed; absent in older records. */
    path?: string
    /** Distinct list items the field was denied in, capped at `of`; absent when the root is not a list (the field itself is denied). */
    rows?: number
    /** The length of the list the denied items are in, when the denial paths run through exactly one list. */
    of?: number
    /** The response path (keys, no indices) of the list the rows are items of: `teams.members`. */
    list?: string
    classification?: string
    /** False when any denial's visibility was not `requestable`; true when all that said so were. */
    isRequestable?: boolean
    /** A denial carried a denial_context token in the execute response itself. */
    hasToken?: boolean
    /** As on `errors`: the schema coordinate, service and policy reason from the first denial token for the field. */
    coord?: string
    service?: string
    reason?: string
  }[]
  /** UPSTREAM_AUTH_REQUIRED: services the user must link, and where (https only). */
  authLinks: { service: string; url: string }[]
  /**
   * A look at what each root list returned (at most 3 lists): up to 25 items with a label and an
   * optional second field (each at most 1,000 characters), and a `url` where the record has a trusted link
   * (src/links.ts recordLinkOf: configured host only). An older history entry keeps each list's first 5,
   * the rest counted in `more`, with label and text at most 400 characters and field values at most 80
   * (src/result.ts compactOutcome). Response content: only in $.state, escaped when drawn.
   */
  preview?: {
    field: string
    /** The response key of the root the list is under, as on `rows`. */
    root?: string
    /** The response index of each item kept, in order (items with no label are skipped). */
    at?: number[]
    items: {
      label: string
      /** What the label is a key for (an issue's summary): shown after the label. */
      text?: string
      extra?: string
      url?: string
      /** Short identifier-like scalars of the record (`key`, `id`, `fields.key`; a Relay edge's node's own), for matching links.toml rules when drawn (src/links.ts previewLinkOf). At most 12, values at most 80 characters (an https URL 256), no spaces. */
      raw?: Record<string, string>
      /**
       * The item's selected scalar fields in selection order, by real name (`user.email` one level in),
       * then the top-level scalars inside an opaque JSON field (`fields.summary`) and the name of an
       * object there (`fields.status.name`); no value where the field is denied. At most 12, values at
       * most 256 characters (80 in an older history entry).
       */
      fields?: { name: string; path?: string; value?: string }[]
      /** Policy-denied fields inside this item (`email`, nested `user.email`) by real field name: at most 4, distinct. */
      denied?: { field: string; path?: string; classification?: string; isRequestable?: boolean; isExpected?: boolean; hasToken?: boolean }[]
    }[]
    more: number
  }[]
  hasData?: boolean
  /** The result was not a GraphQL response the mod could read. */
  isUnreadable?: boolean
  /** Unreadable because Claude Code replaced an oversized result with an error text; `size` is its character count when it said. */
  isTooLarge?: boolean
  size?: number
  /** What the response cost in context, and which fields cost it (src/weight.ts). Absent when the response was not read. Not `size`, which is the stand-in text of an oversized result. */
  weight?: CallWeight
  /**
   * A write's new values the response said back (src/preview/confirm.ts): each the same as the call set (`same`), or not
   * (`differs`, with what came back and what was sent), and the record a create made (`new`). At most 12, values at most
   * 120 characters, escaped. Absent for a read, or when the response carried none of them.
   */
  confirms?: {
    /** The field as CHANGES labels it (`version`, `title`, `body`), or `created`. */
    label: string
    /** A short value said beside it: the one that came back, or a create's new record (`page 98765`). */
    value?: string
    state: 'same' | 'differs' | 'new'
    /** What the call sent, where it differs. */
    sent?: string
    /** Where it is in the response, by response keys (`confluence_updatePage.version.number`). */
    path?: string
  }[]
}

/**
 * How much of Claude's context a response used and where it went, computed
 * from the response's JSON (never from model text): sizes are UTF-8 bytes of
 * the response written compactly; a token is estimated at about 4 bytes.
 * Small and bounded: at most 5 fields, their names cut at generous bounds.
 * Untrusted (a response key names a field): escaped when drawn.
 */
export type CallWeight = {
  /** Bytes of the whole response: its data, its errors and its extensions. */
  bytes: number
  /** The few fields that explain most of it, heaviest first (the rule is in src/weight.ts). Empty when the response has no data or errors to speak of. */
  fields: WeightField[]
  /** More distinct fields than the walk tracks: some detail below was folded into the fields above it. */
  isCapped?: boolean
  /** Claude Code kept the response out of the context (saved it to a file and showed Claude a short preview and the path); `bytes` is the saved file's, read back. */
  isPersisted?: boolean
}

/** One field's share of a response's weight. */
export type WeightField = {
  /** Where it sits in the response: response keys joined by dots, list indices dropped (`open.issues.fields.description`). For a member of the response itself (`errors`, `extensions`) the path starts there. */
  path: string
  /** The same field by the real names the call selected (aliases undone), below its root: `issues.fields.description`. Empty for a root. Keys inside untyped JSON stay as the response wrote them. */
  name: string
  /** Bytes of every value at this path, with its key, summed over every list item it sits in. */
  bytes: number
  /** `bytes` over the whole response's, 0 to 1. */
  share: number
  /** The rows of the list it sits in (the nearest list on its path, itself included), all of them: a field of a list item costs `bytes / rows` a row. Absent when no list is on its path. */
  rows?: number
  /** A member of the GraphQL response beside `data` (`errors`, `extensions`), not a field the call selected. */
  isMeta?: true
}

// ---- Pane state ----

/**
 * `interrupted`: the inspector stopped waiting for the call's result (an abort
 * cut the wait, a reload took its hook away, the session ended); whether it
 * ran is not known. A result that still arrives replaces it.
 */
export type CallStatus = 'pending' | 'ran' | 'errored' | 'denied' | 'interrupted'

/** The Agent Services tools besides `execute` whose calls the pane also shows. */
export type LookupTool = 'search' | 'introspect' | 'validate' | 'dry_run'

/**
 * What Claude asked a lookup for, each part shape-checked and bounded
 * (src/lookup.ts). Untrusted model text: escaped when drawn.
 */
export type LookupInput = {
  /** search: the terms (at most 20, each at most 200 characters). */
  terms?: string[]
  /** search (optional), introspect, validate: the service the call names. dry_run names one per request. */
  scope?: string
  /** search: reads or writes only. */
  operationType?: 'query' | 'mutation'
  /** introspect: the type asked for, and how many reference hops. */
  type?: string
  depth?: number
  /** dry_run: each request's service, in order (at most 20). */
  scopes?: string[]
}

/**
 * What a lookup's response said, bounded (src/lookup.ts). The schema it
 * returned is in the call's IR as fields; this holds the rest. Absent until
 * the call settles with a response the mod could read.
 */
export type LookupCount = { kind: 'exact' | 'at-least'; value: number } | { kind: 'unknown' }

export type LookupFound = {
  /** Counts describe the source, independently of display and retention limits. */
  counts?: { hits?: LookupCount; types?: LookupCount; fields?: LookupCount; members?: LookupCount; scopes?: LookupCount }
  completeness?: 'complete' | 'partial' | 'unavailable'
  /** Why locally available details do not cover the complete response. */
  omissions?: string[]
  /** UTF-8 bytes of the response Claude read: 0 when Claude Code saved it to a file instead. */
  bytes: number
  /** Claude Code kept the response out of the context (saved it to a file). */
  isPersisted?: boolean
  /** search: operations found in all, and the services the catalog lists (an empty search only, at most 200). */
  hits?: number
  scopes?: string[]
  /** search: the paths of the operations found that are mutations (the rest are queries). */
  mutations?: string[]
  /** introspect: the declaration asked for; absent means the response defines no such type. Missing on older saved calls. */
  typeKind?: 'object' | 'interface' | 'input' | 'enum' | 'scalar' | 'union' | 'absent' | 'unavailable'
  /** introspect: the types the response defines, and enum values, input fields or union members (at most 60, as SDL writes them). */
  types?: number
  members?: string[]
  /** Introspection member cards, aligned with members; absent in older stored calls. Schema text only, bounded before storage. */
  memberDetails?: { name: string; description?: string; deprecated?: string }[]
  /** validate: problems the compiler reported. */
  problems?: number
  /** dry_run: each request's service and how it fared: refused whole, or failed with Agent Services' first error (at most 1,000 characters). */
  requests?: { scope: string; isDenied?: boolean; error?: string }[]
  /** Descriptions were left out of what the pane keeps: the response was too large to keep them all. */
  isTrimmed?: boolean
  /** The response was not one the mod could read: why, in at most 300 characters. */
  unreadable?: string
  /** The call failed: Agent Services' first error message, in at most 300 characters. */
  error?: string
}

/** One Agent Services call as the pane draws it, keyed by its tool_use_id: an `execute`, or a lookup (`tool`). */
export type InspectedCall = {
  id: string
  /** The lookup tool the call went to; absent for `execute` (and in state an older build wrote). */
  tool?: LookupTool
  /** What a lookup asked for. */
  input?: LookupInput
  /** What a lookup's response said, once it settled. */
  found?: LookupFound
  /** The MCP server the call goes to, as the tool name spells it. */
  server: string
  /** The operation exactly as the model sent it (a lookup: the operations it sent, or empty); escaped only when drawn. */
  operation: string
  /** Variables as pretty JSON, or the raw text when it could not be read (a lookup: the rest of its input). */
  variables: string
  /** Why the input could not be read, when it could not. */
  inputError?: string
  status: CallStatus
  /** The module instance whose tool.call hook waits on the call; another instance settles it as interrupted. Absent in state an older build wrote. */
  owner?: string
  /** When the mod saw the call ($.clock), for relative dates. */
  arrivedAt: number
  /** The parsed, annotated call; every view and the summary draw from it. */
  ir: CallIR
  /** What came back, once the call ran. */
  outcome?: CallOutcome
  /** How the call fared against the person's trust rules, when they have any (src/trust.ts): set at its permission check. */
  trust?: TrustFit
  /** The subagent or teammate that made the call; absent for the main loop's own. */
  agent?: CallAgent
}

/**
 * Who made a call that did not come from the main loop. `id` is tool.call's `agentId`; `label` is the agent's type and
 * task (`Explore: find naming pages`) from $.agent.list, empty until that answers or when the list has no such agent.
 * Untrusted text (a model wrote the task): escaped and bounded when recorded, escaped again when drawn.
 * `plugin` names the plugin whose hook made the call (tool.call's `next.origin`), absent when Claude did; `id` is then
 * empty unless the plugin called from inside a subagent's loop.
 */
export type CallAgent = { id: string; label: string; plugin?: string }

/** One root of a call and the trust rule it fit, with what made it fit, in words. */
export type RootFit = { root: string; rule: string; reasons: string[] }

/** A call's fit against the trust rules: ran unasked under these rules, or asked, and the first reason why. */
export type TrustFit = { isAllowed: true; fits: RootFit[] } | { isAllowed: false; reason: string }

/**
 * Pending calls oldest first, the last call that settled (always `history[0]`),
 * and bounded history newest first. Full models and versioned overviews live in separate session-only host state.
 * Detail entries survive code reloads and are cleared when the session ends.
 */
export type InspectorCalls = { queue: InspectedCall[]; last: InspectedCall | null; history: InspectedCall[] }

/** A stable history address; live follows the active call rather than an array index. */
export type SelectedCall = { kind: 'live' } | { kind: 'call'; id: string }
export type DetailAvailability = 'available' | 'expired' | 'reloaded' | 'oversize'
/** Compact host metadata. The operation, schema and previews live in separate session-only detail slots. */
export type CallOverview = Pick<InspectedCall, 'id' | 'tool' | 'server' | 'status' | 'owner' | 'arrivedAt'> & {
  overview: { headline: string; headlineSource?: 'model' | 'derived'; operationName?: string; operationKind?: OpType }
  details: DetailAvailability
}
/** A bounded catalog over reusable host slots; no full model is repeated here. */
export type CallDetailIndex = { version: 1; epoch: string; writer: string; entries: { id: string; slot: number; bytes: number }[]; active: string | null }
/** A cleared slot keeps its epoch so stale module writes cannot resurrect old details. */
export type CallDetailSlot = { epoch: string; writer: string; id: string; json: string | null }
export type StoredInspectorCalls = { version: 2; writer?: string; queue: CallOverview[]; last: CallOverview | null; history: CallOverview[] }
export type ResolvedCall = InspectedCall | CallOverview
export type ResolvedInspectorCalls = { queue: ResolvedCall[]; last: ResolvedCall | null; history: ResolvedCall[] }

declare module 'claude-code' {
  interface PluginState {
    'graphos-agent-mods': {
      calls: StoredInspectorCalls
      callDetailIndex: CallDetailIndex
      callDetails: StateFamily<CallDetailSlot | null>
      hasAutoOpened: boolean
      /** Which module instance owns the enrichment pump; an older instance's timer stops itself. */
      pumper: string
      /** Which field drawer is open; reset when a new call is shown. */
      paneUi: { field: string | null; arg: string | null; selection: SelectedCall; cursor?: number | null; row?: string | null; more?: string | null; detail?: { callId: string; detailId: string } | null; rawPage?: number; rawAsSent?: boolean }
      /** Each settled Agent Services call's final verdict line by tool_use_id (null: none), newest last, at most 500: what its transcript row draws. */
      verdicts: Record<string, string | null>
      /** `/gas trust off` for this session: every Agent Services call asks, whatever the trust rules say. */
      isTrustOff: boolean
      /** The Agent Services call running with no dialog and the line the spinner reads for it (src/view/spinner.ts); `id` is empty when none is. */
      spinner: { id: string; text: string }
    }
  }
}

// Optional Desktop host tool; discovery checks its availability and permission first.
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__ccd_connectors__session_connectors_status: {}
  }
}
