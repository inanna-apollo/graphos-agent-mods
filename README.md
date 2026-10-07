# GraphOS Agent Mods

<a href="https://github.com/inanna-apollo/graphos-agent-mods"><img src="docs/qr.svg" align="right" width="140" alt="QR code for github.com/inanna-apollo/graphos-agent-mods"></a>

**GraphOS Inspector** for Claude Code explains every [GraphOS Agent Services](https://www.apollographql.com/context-graph) call in a pane beside the permission dialog: what it reads or writes, which fields Agent Services allows, masks or denies, a diff for writes, and what came back.

> **Experimental.** Shared to try out; not a supported Apollo product. Works with GraphOS Agent Services only, not the open-source Apollo MCP Server.

## Try it

In Claude Code 2.1.290 or later (`claude --version`; `claude update`), with the claude.ai **GraphOS Agent Services** connector:

```
/plugin marketplace add inanna-apollo/graphos-agent-mods
/plugin install graphos-agent-mods@graphos-experiments
/gas setup
```

`/gas setup` checks the rest and gives the next step for anything missing: the `/permissions` lines for Agent Services' four read-only tools, so the pane can check policy without asking you, and, where your graph has Jira or Slack, one read-only question to send that teaches the mod your sites. Then ask Claude for anything from Agent Services. The pane opens on its own on a wide terminal, or with `/gas`.

The install asks for four optional settings (your Atlassian, Glean and Slack sites, and extra links): press Enter to skip them all. If `/gas` does not appear, restart Claude Code or run `/reload-plugins`; if it still does not, run `/plugin` and check that the plugin is enabled. An organization can restrict which mods load, and `claude --debug` says when one was not loaded.

To update later: `/plugin`, then graphos-agent-mods on the Installed tab, then Update now (or `claude plugin update graphos-agent-mods@graphos-experiments` in your shell). Updates are not automatic for a marketplace like this one.

## What you get

- **A pane beside the dialog.** The call's products, its policy (allowed, masked, denied), its arguments rendered for what they are (JQL, CQL, IDs, cursors), and its return tree.
- **Hover cards on everything.** Description, type in plain words, paging, policy: learn the schema as you use it.
- **Results you can click.** Jira, Confluence and Slack records open in the product, and a context receipt says how much of Claude's context the response used, field by field.
- **Write preview.** A mutation shows a diff of what it will change before you approve it.
- **A verdict above the dialog.** `✓ all 9 fields allowed · reads Confluence`, `✎ DEV-634 → transition 31 · writes Jira`.
- **Optional trust rules.** Reads you'd always approve, written as GraphQL shapes, run without a dialog.

## Requirements

- **Claude Code 2.1.290 or later.** Releases before 2.1.287 do not load mods; releases before 2.1.290 are untested, and the mod says so at session start.
- **The terminal, or the Desktop app's Code tab.** The VS Code extension, the mobile app and `claude -p` were not tried (a `-p` run has no pane at all).
- **GraphOS Agent Services,** through the claude.ai connector (`/mcp` lists it). A server counts as Agent Services only when it offers `execute`, `validate`, `introspect` and `dry_run`, Agent Services' own access check, so the open-source Apollo MCP Server is left alone.
- **macOS or Linux.** Windows was not tried: there the mod cannot find your `~/.claude/graphos-agent-mods/` files or open links.
- **Recommended: the four read-only Agent Services tools allowed** (`/gas setup` prints the lines for your connector; add them with `/permissions`):

  ```
  mcp__claude_ai_GraphOS_Agent_Services__search
  mcp__claude_ai_GraphOS_Agent_Services__introspect
  mcp__claude_ai_GraphOS_Agent_Services__validate
  mcp__claude_ai_GraphOS_Agent_Services__dry_run
  ```

  None of these change data. Allowing them also lets Claude itself call them without asking. Without them the pane still shows the parsed call, with access marked as not checked.

To work on the mod itself, run Claude Code with the plugin folder instead: `claude --plugin-dir path/to/graphos-agent-mods` (see Developing).

## What you see

- **A verdict above the dialog.** Under the call's row in the transcript, for example:
  - `⎿ GraphOS Inspector ⚑ email masked · reads Jira`
  - `✓ all 9 fields allowed · reads Confluence`
  - `✓ 1 field allowed · reads Jira`
  - `✎ DEV-634 → transition 31 · writes Jira`
  - `✎ posts to C0123456789 · ⚑ @channel notifies the channel · writes Slack`

  A write leads with its change in a few words (`✎`), from the call's own arguments, so it is there from the first moment, before the policy check is back. It stays in the transcript as the record of what you approved.
- **The pane** (`/gas` opens it at any width. On its own it opens at most once per session, and only on a terminal about 144 columns wide, or 110 once you have opened it yourself):
  - **Header.** A READ / WRITE / WATCH badge from the operation type, the services, the operation name, the status, and a policy meter (allowed / masked / denied). The status says `errors` when nothing usable came back (a result that is not a GraphQL response shows its own text under RESULT) and `needs sign-in` when a service needs your account linked first.
  - **Headline.** One sentence saying what the call does.
  - **Flags.** Surprises and risks: a denied field, a query field named for a change, more rows than the limit asked for, an over-sized result, one field that is most of a big response (`issues.fields.description is 71% of a 58 KB result`).
  - **Trust line**, only once you have written trust rules. `✓ ran without asking · trust rule JiraTriage`, or `asked · no trust rule fits`; its card says why (see Trust rules). With no rules file there is no trust line.
  - **Who made it.** A call a subagent made says so under that: `↳ from subagent · Explore: find naming pages`. Its card gives the whole task. A call another plugin made names the plugin: `↳ from the acme-helper plugin`. Claude's own calls in the main conversation say nothing.
  - **CHANGES**, for a write, first: what approving it changes, as a diff, read from the call's own arguments and the schema. See Write preview below.
  - **The form.** Each root field, with its arguments rendered for what they are (JQL, CQL, Slack search, dates, IDs, cursors) and its return tree, marked by policy and personal data.
  - **RESULT**, after the call runs:
    - rows with record keys (`[DEV-634]`) that open in the product: up to 25 a list, five until you press `… N more` (an older call you step back to keeps its first five, the rest counted). A Relay connection's rows are its nodes, and a record nothing names but its `id` shows its `id`;
    - click `▸` on a row to expand all its fields;
    - paging state (`first page · more available`) and totals;
    - for a write, the new values the response said back: `title On-call runbook ✓ · version 13 ✓`, or `created message 1728000000.000100`;
    - a dim last line, the context receipt (see below): `58 KB · about 14k tokens · description 71%`.
  - **Links** that open the same search in Jira, Confluence or Glean. A Slack message links to itself (its permalink).
  - **Hover cards on everything.** Every name, argument, badge and line has a card: its description, its GraphQL type in notation and in plain words, what it does for paging, its policy, its scopes, and what came back. The pane is meant to teach GraphQL and the Agent Services schema as you use it.
- **Context receipts.** How much of Claude's context each response used, and which fields used it: GraphQL's pitch against tools that return whole records, shown per call. Everything is computed from the response, never by a model.
  - **The line.** The last line of RESULT: the response's size, its tokens as an estimate, and the field that took most of it when one stands out (`58 KB · about 14k tokens · description 71%`; a response under 1 KB, or with no field over 30%, names none).
  - **The card.** Hover the line: each heavy field (at most five, the ones you would drop or narrow, not just the root) with its size, its share of the response, what a row of its list costs on average, its description from the schema, and what the result would be without it (`Without issues.fields.description this result would be about 17 KB`).
  - **The flag.** One field over half of a result over about 16 KB says so in the flags line.
  - **How it is measured.** The response's JSON written compactly, in UTF-8 bytes (a KB is 1,024 bytes, as Claude Code counts them), so it does not move with a service's spaces. A token is estimated at about 4 characters, always said as *about*: an estimate, not a count.
  - **A result Claude Code kept out of the context.** An oversized result is saved to a file, and Claude sees only a short preview and the file's path. The line says so (`58 KB saved to a file · Claude saw only a short preview and its path`) and sizes it from the saved file when the mod could read it back, else by the figure Claude Code gave (`about 58 KB`). Such a response is not counted as read below.
- **A standing line under the prompt**, once there is something to count: `Agent Services · 5 calls · 212 KB read · 3 trust rules · 2 ran unasked`. Agent Services calls this session, the bytes of the responses Claude read (a response whose result Claude Code kept out of the context was not read), trust rules loaded, and calls that ran without a permission dialog because they fit one of your rules (a call the engine allowed by your settings is a call, not one of these). A session with no Agent Services call, no trust rule and no trust-file notice shows nothing; `/gas trust off` says `trust off` in place of the rule count, and a trust file saved since the rules were read says `trust.graphql changed · run /gas trust to reload`. It updates when a call arrives or settles and when the rules load or switch, never on a timer.
- **RESULT under the call's row in the transcript.** Once a call has run and its response was read, a compact block sits under its row and its verdict line, and under its own line in a folded group: the rows line with the response's size after it (`5 issues · first page · 58 KB`) and the first three records, their keys links a click opens (on the sites your link settings name or the mod learned). It is for where the pane is too narrow to dock, and for scrollback. The engine's own result drawing stays beneath it. Nothing for a call still running, refused, failed, or whose response could not be read. An expanded group (`--verbose`, ctrl+o) draws each result inline itself and gets no block.
- **The spinner says what is running.** While an Agent Services call runs without a permission dialog (it fit one of your trust rules, or your settings already allow it), the spinner reads Haiku's headline for the call in place of its word, or `Agent Services · <operation name>` until the headline is in. When the call ends the spinner is the engine's again. A call that asks you first leaves the spinner alone.
- **Access requests.** When Agent Services denies a field and the denial can be requested, `a: draft access request` puts a draft in your prompt box. Nothing is filed until you send it and approve the call.
- **Trust rules** (optional, and invisible until you write a rules file). Reads you'd always approve can run without a permission dialog when they fit a rule you write in GraphQL. See below.

## Write preview: what a write changes

For a mutation, the pane's first section says what approving it changes, as a diff. It is computed from the call's own arguments and the schema. **The current state is not read**: the section says `new values only · current state not read`, so a value there may be what the record holds already.

```text
┃ CHANGES  issue DEV-634
  + summary      Add CSV export to the reports page
  + description  8 lines · rich text
  +   ## Goal
  +   Add CSV export to the reports page, so a report
      can be downloaded and shared first.
      6 more lines
  + labels       backend
  - labels       frontend
  new values only · current state not read
```

- **The target** is in the header: an issue key, a page or comment id, a channel and thread, a message's ts. A create says where it goes instead: `┃ NEW MESSAGE  in C0123456789`, `┃ NEW COMMENT  on DEV-634`.
- **The signs.** `+` (green) is a value the call sets or adds, `-` (red) what it removes or deletes, `±` (amber) a value it edits in place. A delete shows its target as `-`. A value the API needs on every call and that is almost always unchanged (Confluence's `status: current`) is dim, with no sign.
- **Bodies as lines.** Jira's rich text (ADF), Confluence's storage format, and Slack's mrkdwn, blocks and attachments are flattened to lines: headings, list items, tables, code, links (`label ↗`), mentions (`@U02ABC123`). The row says how many lines there are; the first few follow, wrapped, never cut; a count says the rest.
- **Jira's opaque JSON** is read from its values: each field of `fields` is a row, and `update`'s `add` and `remove` are `+` and `-`.
- **Flags that need no read**, on the flags line: `@channel`, `@here` or `@everyone` in a Slack text, `replyBroadcast` on a reply, `notifyUsers: false`, Jira's admin overrides, `deleteSubtasks`, and a delete that cannot be undone (Jira and Slack have no trash, and Confluence comments do not go to one). A Confluence page or blog post goes to its space's trash, and the section says so.
- **Cards.** The section's card says how the change was read; the target's, which argument names it and what that id is; each row's, what the new value means, the argument it is in, its type in notation and in words, and its schema description (or that it sits in untyped JSON).
- **Hand-mapped writes.** Jira: transition, edit, assign, create, comment add, edit and delete, issue delete. Confluence: page and blog post create, update and delete; footer and inline comment create, update and delete. Slack: post, edit, delete, and add or remove a reaction. Any other mutation is read generically: its id-like arguments name the target, and every other argument it sets is a new value; its card says it was not hand-mapped.
- **After it ran**, RESULT says which new values the response carried back: `version 13 ✓`, `title came back as …`, or the record a create made. The mod cannot add fields to the call, so this confirms only what the response happens to hold; a Jira transition returns nothing to confirm.

## Commands

| Command | What it does |
|---|---|
| `/gas` | Open the pane on the current or last Agent Services call (Esc hands the keys back and leaves it open; `×` or `ctrl+x x` closes it) |
| `/gas setup` | Report what the mod needs and the next step for each (see Try it) |
| `/gas older` · `/gas newer` · `/gas live` | Step through the last 20 calls |
| `/gas raw` | Open or close the raw operation and variables |
| `/gas trust` | Reload your trust rules, list them, and say what was skipped. The only way a saved change to the file takes effect mid-session |
| `/gas trust off` · `/gas trust on` | Turn trust rules off or on for this session |
| `/gas links` | Reload link mappings; say where each site comes from and how to set an unset one; say what was skipped |
| `/gas links forget` | Clear the sites the mod learned from Agent Services responses |

## Trust rules: auto-approve reads you'd always approve

Trust rules are optional. Until you write a rules file nothing about them shows: no trust line in the pane, no rule count in the standing line, and every call asks as it always did.

Write `~/.claude/graphos-agent-mods/trust.graphql`, then run `/gas trust`. Each **named query** in the file is a rule: the widest read you'd approve without a permission dialog. When an Agent Services call fits, it runs without one. The pane and the transcript say `✓ ran without asking · trust rule JiraTriage`, and the card says what fit where. When a call doesn't fit, it asks as usual: the pane says `asked · no trust rule fits`, and the line's card gives the reason, for example `jira_searchAndReconsileIssuesUsingJql: maxResults 200 is not between 1 and 50 (JiraTriage)`.

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

query GleanAnything {
  glean_search            # no selection: anything below it
}
```

A call fits when every root field it selects fits a rule's root of the same name:
- It selects nothing outside the rule's selection. Aliases don't matter, `__typename` always fits, and a field the rule writes with no selection allows anything below it.
- Every argument the rule writes is set by the call, after variable substitution, to an allowed value:

  | In the rule | Means |
  |---|---|
  | `"text*"` | a pattern over the text; `*` matches any run |
  | `50` on a limit argument (`first`, `limit`, `maxResults`, `pageSize`, …) | at most 50 and at least 1 |
  | `50` on any other argument | exactly 50 |
  | `["a", "b"]` | each item the call passes is one of these |
  | `{ k: v }` | each key written is checked; others are free |
  | an enum, `true` or `null` | exactly that |

  An argument the rule doesn't write may be anything.

**Never auto-approved, whatever the file says:**
- a mutation or subscription;
- a root named for a change (`jira_createIssue`, `confluence_deletePage`);
- any directive other than a decided `@skip` / `@include`;
- more than one operation, or anything the mod can't parse.

The mod only ever turns the engine's *ask* into *allow*, including an *ask* rule you wrote for `execute` in your settings. A deny rule in your settings, or a limit your organization set, still stands. Agent Services still applies its own policy to every call: masked and denied fields stay masked and denied.

**Things to know:**
- **Patterns match text, not meaning.** `"project = DEV*"` also matches `project = DEV OR project = OPS`. Write the narrowest shape you need.
- **The file is read** at session start, on `/gas trust`, and when the plugin itself is reloaded; a save alone never loads it. A rule written into it mid-session (by an agent, say) cannot take effect on its own: the mod watches the file only to tell you, with `trust.graphql changed. Run /gas trust to reload it; until then, the rules loaded earlier stand.` in the transcript and `trust.graphql changed · run /gas trust to reload` in the standing line. Treat the file like the allow rules in your `settings.json`; Claude is told never to edit it.
- **A rule fits only the call's own operation and variables.**

[`trust.example.graphql`](trust.example.graphql) has a commented starting point.

## Your sites: where records open

A record key opens on your own Atlassian site (Jira and Confluence) or Slack workspace, so the mod needs to know them. You can set them, or let the mod learn them.

**Learned from an Agent Services response.** Where a site is not set, the first Jira, Confluence or Slack response whose own metadata names it teaches it: `<name>.atlassian.net` for Atlassian, `<name>.slack.com` for Slack. Agent Services reaches Jira through Atlassian's API gateway, so a Jira answer names your site in a status's or a priority's icon, which any search that returns `status` or `priority` brings back; Slack names its workspace in a message's permalink. Links people wrote (in a description, a comment, a page or a message) never count. The mod remembers it between sessions and says so once in the transcript: `GraphOS Inspector: record links now open on yourco.atlassian.net, learned from an Agent Services response. /gas links says where each site comes from.` The first response's own records already open there. The limits:
- **Only a vendor tenant host.** Another host, `http`, a login in the URL, a port, and the vendors' shared hosts (`api.atlassian.net`, `app.slack.com`) teach nothing.
- **Only where nothing is configured.** A plugin option, an entry in your own `links.toml` (an entry of `""` turns that site off), or a site already learned is never replaced.
- **Only from a response,** under a Jira, Confluence or Slack root, never from what Claude wrote.
- A site on a custom domain is not learned: set it yourself.

`/gas links` says where each site comes from (a plugin option, your `links.toml`, the shipped default, learned, or not set) and how to set an unset one. `/gas links forget` clears the learned ones; the next response that shows the site teaches it again, unless you set it or turn it off.

**Set by you.** The `atlassianBase`, `gleanBase` and `slackBase` plugin options (set them in `/plugin`, then graphos-agent-mods), or `[bases]` in your `links.toml` (below). An option comes first, then your `links.toml`, then the shipped default; a learned site only fills a site that none of those sets.

## Link mappings (links.toml)

Which entity opens where is data, not code. The shipped defaults are in `links.toml` in the plugin folder: Jira issue keys to `/browse/KEY`, Confluence page ids, and the deep links that open a call's CQL, JQL or Glean search (a Slack message links to itself, by its permalink). They name no Atlassian site or Slack workspace of their own (see Your sites). Links are worked out when the pane draws, so a change applies to older calls too (the transcript's RESULT keeps the links it had when the call ran).

To add or change a mapping, create `~/.claude/graphos-agent-mods/links.toml` (an update replaces the shipped file, never yours). Saving it reloads it and says so in one quiet line (`links.toml reloaded: 12 row rules, 1 skipped`), naming any host it newly lets a click open (`; links now open on wiki.example.com`); `/gas links` reloads both files by hand and says where it looked and what it skipped. Your `[[record]]` rules are tried before the shipped ones, and your `[bases]` replace theirs. The `atlassianBase`, `gleanBase` and `slackBase` plugin options replace both. The `extraLinks` plugin option takes a JSON array of up to 8 search links, each with a `label`, `service`, `field` (a root field name, or a prefix ending in `*`), `arg`, `base` (a named base or an https URL) and `template` (such as `{base}/s?q={value}`), and works like a `[[search]]` rule, which is easier to keep.

```toml
[bases]                       # named hosts: https, no credentials; "" turns one off
atlassian = "https://yourco.atlassian.net"
wiki = "https://wiki.example.com"

[[record]]                    # a result row's link
service = "jira"              # root field prefix before `_`, or "*"
field = "key"                 # item field holding the value; dotted ok (fields.key)
match = "^[A-Z][A-Z0-9_]+-\\d+$"   # optional; the whole value must match
url = "{atlassian}/browse/{value}" # starts with {base name}; one {value}, percent-encoded

[[search]]                    # a link for the whole operation, from one string argument
label = "Open in Wiki"        # at most 40 characters
service = "x"
root = "x_*"                  # root field name, or a prefix ending in *
arg = "query"
url = "{wiki}/s?q={value}"
```

The file is a strict TOML subset: tables, arrays of tables, strings, booleans, integers and comments. A bad file or entry is skipped, never fatal. A host comes from `[bases]`, a plugin option, or, for the Atlassian site and Slack workspace only, what the mod learned from an Agent Services response (above); it never comes from anything else in call data. A link opens only if it is https and on one of those hosts.

## What the mod will and won't do

- **It never runs a GraphQL operation itself.** It calls only Agent Services' read-only tools (`search`, `introspect`, `validate`, `dry_run`), and only when your settings already allow them. A write's CHANGES come from the call's own arguments: the mod reads no record to show them.
- **It approves only calls that fit your own trust rules,** and only where you'd otherwise be asked. It never denies or rewrites a call.
- **Links open only on https hosts** named by your plugin options, your `links.toml` or the shipped `links.toml`, a vendor tenant host the mod learned (above), plus Agent Services' own sign-in links the pane drew.
- **It sends nothing for you.** `/gas setup` and the access-request buttons put a draft in your prompt box for you to read and send.
- **What it keeps:** the sites it learned, in Claude Code's store for this plugin (`/gas links forget` clears them), and the last 20 calls for the pane, in the session's memory. It writes no file of yours.

## What runs in the background

For each Agent Services `execute` call, while the permission dialog is up:

- **Agent Services' read-only checks,** when you have allowed those tools: `validate` and `dry_run` on the operation, and `search` and `introspect` for the schema of its root fields (cached for the session). They are ordinary requests to your Agent Services, as if Claude had made them, and they change nothing. Without the tools allowed, none are made.
- **One Haiku request for the headline,** through your own Claude Code sign-in, as Claude's own requests are. It carries the operation's fields, its argument values (each cut to at most 2,000 characters) and the schema's descriptions, never the response. It runs while the dialog is up, so a call you then refuse has been summarized too.
- **`/gas setup`** calls `search` once, when it is allowed, to see whether your graph has Jira, Confluence or Slack before it offers to find those sites.

Nothing else leaves your machine: the mod has no telemetry and makes no other network requests.

## Known limitations

- **Experimental.** Mods are a new Claude Code feature and their behavior can change between releases. This was built and tried on Claude Code 2.1.290 to 2.1.292.
- **Only Agent Services.** A server is Agent Services only if it offers `execute`, `validate`, `introspect` and `dry_run` (see Requirements).
- **Two surfaces.** The terminal and the Desktop app's Code tab are the ones it was built and tried on. The VS Code extension, the mobile app and `claude -p` were not tried and are not supported (a `-p` run has no pane at all).
- **Without the four read-only tools allowed,** access, schema and validity show as not checked.
- **The pane is read-only while a permission dialog is open.** Clicks reach it again once you answer. The verdict line above the dialog is the live part.
- **Auto mode.** Where Claude Code's own classifier decides whether to ask, calls can run without a permission dialog; the pane and the verdict still describe them, but your trust rules have nothing to lift.
- **The spinner names only calls that run without a permission dialog.** A call that asks leaves it alone.
- **A subagent's call is named only when Claude Code's agent list knows the agent.** Calls from a workflow or an engine fork say `from subagent` alone.
- **Tested in the harness, not yet in a live session:** the spinner text, a subagent's label, and the notices that say `trust.graphql` or `links.toml` was saved.
- **Opening a link** needs `open` (macOS) or `xdg-open` (Linux). On another system, or without one, a press says so in the transcript and opens nothing; a link's card still shows its URL.
- **Learned sites cover `<name>.atlassian.net` and `<name>.slack.com`** (and `<name>.enterprise.slack.com`). Self-hosted or custom-domain sites need to be set by hand.
- **Record links for other services** open only on a host your link settings name (the shipped file names Glean, incident.io, Google Docs and Drive, Gong, HubSpot and Ashby) or one you add.
- **Service names.** The shipped links, the learned sites and `/gas setup` expect the services to be named `jira`, `confluence`, `slack` and `glean`, as their root fields' prefixes (`jira_…`). For another name, add `[[record]]` and `[[search]]` rules in your `links.toml`.
- **One learned site per vendor, per machine.** With two Atlassian sites, the first one learned is used everywhere: set the one you want, or run `/gas links forget`.
- **After a reload of the plugin,** the transcript's RESULT block is redrawn only for the last 20 calls.
- **Hover cards** need mouse support in your terminal.
- **CHANGES shows new values only.** The current state is not read, so a value may already be what the record holds, and ids stay ids: a Jira transition by its id (the status it leads to is not read), an assignee by account id, Slack people and channels by their ids. A mutation outside the hand-mapped set is read generically, which can miss what it changes.
- **Trust patterns match text, not meaning** (see Trust rules).

## License and feedback

[Elastic License 2.0](LICENSE). Questions, bugs and ideas: open an issue on this repository.

## Developing

See [.claude/CLAUDE.md](.claude/CLAUDE.md) for the layout, conventions and checks. [docs/pane-design.md](docs/pane-design.md) records the pane's design decisions, and [docs/spikes.md](docs/spikes.md) records what the mod API turned out to do.

- `node --test test/unit/*.spec.ts` runs the pure modules (Node 22.18+ strips TypeScript types).
- `claude plugin test .` runs the hooks (`tests/*.test.ts`) on the terminal and desktop surfaces.
- `claude plugin validate .` checks the manifests and lists every `$` call the mod makes.
- `npx -p typescript@5 tsc -p . --noEmit` type-checks once Claude Code has written `.claude-plugin/types/`.
- `/gas snapshot` and `/gas snapshots on|off` write the pane's text, call arguments and result rows included, under `snapshots/` in the plugin folder (off by default; for design review only).
- `/gas timing on|off` writes the last 50 summary timings to `timing.log` (git-ignored; off by default).
