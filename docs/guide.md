# GraphOS Inspector guide

This guide covers the parts of GraphOS Inspector that benefit from more detail than the [README](../README.md). It works with GraphOS Agent Services in Claude Code.

## Reading a call

The pane appears beside the permission dialog when the terminal is wide enough; `/gas` opens it at any width. A transcript verdict remains under the call after the pane closes. The pane identifies the operation and services, shows arguments and selected fields, and annotates fields with schema information and Agent Services policy results when those checks are available. A write's verdict summarizes its target and proposed action before policy checks finish. The pane also identifies calls made by a known subagent or another plugin.

The headline is a short description of the operation. It is requested only when needed; it may be reused from cache. The pane's flags call out policy denials, query fields whose names suggest a write, results larger than requested limits, and unusually large fields.

After a readable response arrives, RESULT shows a compact preview of its rows, paging information, and links where available. Lists open with a few rows and can expand to show up to 25; a row can be expanded to inspect its fields. Links can open records or the corresponding Jira, Confluence, or Glean search; Slack messages link to their permalink. The transcript also gets a compact result block for scrollback and narrow terminals. Calls that were refused, failed, or whose result could not be read have no result block.

Hover cards explain names, arguments, types, descriptions, paging, policy, scopes, and returned values. A context receipt estimates the response's size from its compact JSON representation in UTF-8 bytes. The token figure is a rough estimate using bytes divided by four; it is not a token count or a measurement of Claude's actual context. The receipt can identify large fields and estimate the response size without them. A response Claude Code saves outside the conversation is measured from its saved file when readable, otherwise from the size Claude Code reported.

The standing line, when present, counts Agent Services calls, response bytes read, loaded trust rules, and calls that ran without asking because a trust rule matched. A call allowed by Claude Code settings is not counted as trust-rule execution.

When a call runs without a permission dialog, its spinner can show the headline while it is available. A field denied by Agent Services may offer an access-request draft; the draft is placed in the prompt box for you to review and send.

While a permission dialog is open, pane controls are inactive and the transcript verdict continues to update. Claude Code may run a call without a dialog in auto mode; trust rules apply only when its permission check returns `ask`.

## Write previews

Before approval, a mutation's CHANGES section summarizes the proposed values using the call's arguments and schema. It does not read the current record or compare against it. A plus means a value is set or added, a minus means a value is removed or deleted, and an edit marker means a value is changed in place. Required values that are usually unchanged may be shown without a change marker.

Jira rich-text documents, Confluence storage, and Slack text, blocks, and attachments are flattened into readable lines. The preview can flag actions such as broad Slack mentions, notification settings, Jira admin overrides, and deletes that cannot be undone. Jira, Confluence, and Slack have hand-mapped write previews; other mutations use a generic interpretation of id-like arguments as targets and remaining arguments as values, which may not fully describe the operation.

After a write runs, RESULT can confirm values included in the service response. It cannot add fields to the operation, so it only confirms what that response contains. For example, a Jira transition may return no status to confirm.

## Trust rules

Trust rules are optional. Create `~/.claude/graphos-agent-mods/trust.graphql`, then run `/gas trust` to load it. Each named query describes a read shape and argument constraints that may run without a permission dialog.

```graphql
query JiraTriage {
  jira_searchAndReconsileIssuesUsingJql(
    jql: "project = DEV*"
    maxResults: 50
    fields: ["summary", "status", "priority", "assignee", "updated"]
  ) {
    issues { id key fields }
    nextPageToken
    isLast
  }
}
```

A call fits when every root field and selection fits a rule, and every argument constrained by that rule is within its allowed values:

| Rule value | What the call may pass |
|---|---|
| `"text*"` | A string matching the pattern; `*` matches any run of characters. |
| `50` on a limit argument | An integer from 1 through 50. |
| `50` on another argument | Exactly `50`. |
| `enumValue`, `true`, or `null` | That exact value. |
| `["a", "b"]` | A list whose every item is allowed; a single value is treated as a one-item list. An empty list fits only an empty rule list. |
| `{ k: v }` | An object that sets `k` to an allowed value. Other keys are unconstrained. |

Arguments omitted by the rule are unconstrained. A rule field with no selection permits any child selection; aliases do not change which fields are matched, and `__typename` always fits.

A rule never permits a mutation, subscription, root field named for a change, multiple operations, or an operation the inspector cannot parse. A call may use `@skip` or `@include` only on a supported field or fragment and with a resolved boolean condition; any other directive, location, or unresolved condition always asks. Trust rules only change a permission result from `ask` to `allow`; they do not override a deny, an organization ceiling, or Agent Services policy. String patterns apply to the whole argument's text. For example, `"project = DEV*"` also matches `project = DEV OR project = OPS`, so use narrow patterns.

Write-name detection is conservative: an underscore-separated read name containing a write verb, such as `jira_get_issue_update_history`, still requires approval even if a rule names it.

Nested different type conditions on the same value, such as `... on JiraIssue { ... on Node { id } }`, require approval and cannot be used in trust rules. Repeating the same type condition or selecting a different type beneath a child field is supported.

A saved file is loaded at session start, when `/gas trust` runs, or when the plugin reloads. Saving the file alone does not change in-memory rules; the inspector reports that the file changed. A call that does not fit a rule still asks as usual. Use `/gas trust off` and `/gas trust on` to disable and re-enable rules for the current session.

## Sites and links

The inspector can learn an Atlassian site or Slack workspace from vendor metadata in an Agent Services response. It learns only when a base is unset, and never from descriptions, comments, message text, or other user-authored content. Learned hosts are limited to vendor tenant domains such as `<name>.atlassian.net` and `<name>.slack.com` (including Enterprise Slack). A custom domain must be configured manually. Only one learned site per vendor is retained; with multiple sites, the first learned site is used until you set a base or run `/gas links forget` and teach it again.

`/gas links` reports where each site comes from and reloads link settings. `/gas links forget` clears learned sites. Saving `links.toml` reloads it automatically; the settings apply to the pane without a restart, and the transcript names any host the save newly lets a link open. Links open only on https, apart from Agent Services' own sign-in links. To define custom sites or mappings, create `~/.claude/graphos-agent-mods/links.toml`:

```toml
[bases]
atlassian = "https://yourco.atlassian.net"
wiki = "https://wiki.example.com"

[[record]]
service = "jira"                  # root field prefix, or "*"
field = "key"                     # item field; dotted paths are allowed
match = "^[A-Z][A-Z0-9_]+-\\d+$" # optional full-value match
url = "{atlassian}/browse/{value}"

[[search]]
label = "Open in Wiki"
service = "x"
root = "x_*"                       # exact root name or prefix ending in *
arg = "query"
url = "{wiki}/s?q={value}"
```

A record mapping chooses a field from a result row; a search mapping builds a link from one string argument. URLs must use an HTTPS base named in the file or a supported learned vendor base. User bases replace shipped bases. Invalid entries are skipped. Shipped links cover Jira, Confluence, Slack messages, and selected services such as Glean, Google Drive, Gong, HubSpot, and Ashby.

The file accepts a strict TOML subset: tables, arrays of tables, strings, booleans, integers, and comments. An empty base (`atlassian = ""`) turns that base off and prevents the inspector learning it. User `[[record]]` rules take priority over shipped record rules; shipped `[[search]]` rules take priority over user search rules.

## Setup and background work

The inspector follows the claude.ai GraphOS Agent Services connector only, by its server name (`claude_ai_GraphOS_Agent_Services`). Its hooks match that server's tools alone, so calls to any other MCP server never reach the plugin.

`/gas setup` checks the Claude Code version and the connector, and notes whether the read-only Agent Services tools are allowed; allowing them is optional. When `search` is allowed, it may call `search` to identify which supported services are present and draft a read-only question that can teach the inspector your Jira/Confluence site or Slack workspace. You review and send that prompt yourself.

For an eligible `execute` call, the inspector can call Agent Services' read-only `validate`, `dry_run`, `search`, and `introspect` tools while the permission dialog is open. The checks are only made when your settings allow the tools. Schema lookups are cached for the session. If services are added during a session, reload the plugin to refresh the service catalog. The inspector never calls `execute` or performs a write itself.

For a new headline, Haiku receives the parsed operation structure, its argument values (each capped at 2,000 characters), and schema descriptions through your Claude Code sign-in. It does not receive the response. The request is best-effort and may be skipped or reused from cache. It can run while the permission dialog is open, including before you refuse the call. The pane computes the policy and verdict from the operation and Agent Services checks.

Sites learned from Agent Services responses are stored with Claude Code for the plugin. The pane keeps the last 20 calls in session memory. The plugin writes no user config file. Access requests and setup questions are drafts in the prompt box; nothing is sent until you choose to submit it. Nothing else leaves your machine: the plugin has no telemetry.

## Commands

| Command | Purpose |
|---|---|
| `/gas` | Open the current or last call; Esc returns keys to Claude Code, `×` or `ctrl+x x` closes the pane |
| `/gas setup` | Check setup and show numbered next steps |
| `/gas older`, `/gas newer`, `/gas live` | Browse the last 20 calls |
| `/gas raw` | Toggle the raw operation and variables |
| `/gas trust` | Reload and list rules; report skipped entries |
| `/gas trust off`, `/gas trust on` | Disable or enable trust rules for this session |
| `/gas links` | Reload mappings and report configured sites |
| `/gas links forget` | Clear learned sites |

The `/gas snapshot`, `/gas snapshots on|off`, and `/gas timing on|off` commands are maintainer diagnostics; see [contributor guidance](../.claude/CLAUDE.md). Snapshots are opt-in and can include operation arguments and result rows; inspect them before sharing.

## Updating the plugin

In Claude Code, run `/plugin`, open **Marketplaces**, select `graphos-experiments`, choose **Update marketplace**, then run `/reload-plugins`. From a shell, run:

```sh
claude plugin marketplace update graphos-experiments
claude plugin update graphos-agent-mods@graphos-experiments
```

Marketplace updates are not automatic by default. The Marketplaces tab can enable auto-update.
