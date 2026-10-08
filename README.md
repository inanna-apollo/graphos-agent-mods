# GraphOS Agent Mods

<a href="https://github.com/inanna-apollo/graphos-agent-mods"><img src="docs/qr.svg" align="right" width="140" alt="QR code for github.com/inanna-apollo/graphos-agent-mods"></a>

**GraphOS Inspector** helps you review [GraphOS Agent Services](https://www.apollographql.com/context-graph) calls in Claude Code. It shows the operation, arguments, Agent Services policy checks, results, and a preview of proposed writes beside the permission dialog.

> **Experimental.** Not a supported Apollo product. Works with GraphOS Agent Services only, not the open-source Apollo MCP Server.

## Install

Use Claude Code 2.1.290 or later, on macOS or Linux, in the terminal or Claude Desktop's Code tab. Connect the claude.ai **GraphOS Agent Services** connector first; `/mcp` should list it.

```text
/plugin marketplace add inanna-apollo/graphos-agent-mods
/plugin install graphos-agent-mods@graphos-experiments
```

Optional: allow Agent Services' read-only `search`, `introspect`, `validate`, and `dry_run` tools in `/permissions` (or choose "don't ask again" the first time Claude uses one). The inspector uses them for policy, schema, and validity checks; without them the pane still explains the parsed operation and marks those checks as not run. `/gas setup` reports anything missing.

Try asking: “Find the five most recently updated open issues in DEV and show their summary and status.” The pane opens automatically in a wide terminal, or run `/gas` to open it. If the command is missing, restart Claude Code or run `/reload-plugins`, then check `/plugin` to confirm the plugin is enabled.

## What it shows

- The operation and its arguments, with schema descriptions, types, paging, and policy information.
- A result preview with links to records, plus an estimate of response size and which fields account for it.
- A proposed-write preview derived from the call's arguments. It shows new values; it does not fetch current records or compare old and new state.
- Optional GraphQL trust rules for reads you choose to run without a permission dialog. These rules only turn an `ask` into an `allow`; they cannot override a deny, organization limits, or Agent Services policy.

**Data sent for a headline:** when a call is eligible for a new summary, the inspector sends the operation structure, argument values, and schema descriptions to Haiku through your Claude Code sign-in. Argument values are capped at 2,000 characters. The request may happen while the permission dialog is open, even for a call you later refuse. The response is not sent to Haiku. Headlines are best-effort and may be reused from cache. Policy decisions and verdicts are computed from the operation and Agent Services checks, not from the headline model.

The inspector never calls `execute` itself. It calls only `search`, `introspect`, `validate`, and `dry_run`, and only when your settings allow those tools. Setup prompts and access requests are drafts for you to review and send. Nothing else leaves your machine: the plugin has no telemetry.

## Commands

`/gas` opens the pane on the current or last Agent Services call; `/gas setup` reports anything missing. The [user guide](docs/guide.md#commands) lists every command.

## Updating

In `/plugin`, open **Marketplaces**, select `graphos-experiments`, choose **Update marketplace**, then run `/reload-plugins`. The [user guide](docs/guide.md#updating-the-plugin) has the shell commands and auto-update.

## Limits and details

The terminal and Desktop Code tab are the tested surfaces. The VS Code extension, mobile app, `claude -p`, and Windows are untested. Hover cards need terminal mouse support. Links open through `open` on macOS or `xdg-open` on Linux. Custom Atlassian or Slack domains must be configured by hand. Only the claude.ai connector is inspected (tools named `mcp__claude_ai_GraphOS_Agent_Services__*`); Agent Services added as another MCP server is not, and no other server's calls pass through the plugin.

See the [user guide](docs/guide.md) for write previews, trust-rule syntax, link settings, and detailed behavior. See [contributor guidance](.claude/CLAUDE.md) to work on the mod. The project is under the [Elastic License 2.0](LICENSE); questions and bug reports belong in this repository's issue tracker.
