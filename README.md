# GraphOS Agent Mods

<a href="https://github.com/inanna-apollo/graphos-agent-mods"><img src="docs/qr.svg" align="right" width="140" alt="QR code for github.com/inanna-apollo/graphos-agent-mods"></a>

**GraphOS Inspector** gives you a live TUI view of Claude's work in [GraphOS Agent Services](https://www.apollographql.com/context-graph). Watch it discover operations, inspect schema, check policy, and read results, with Haiku explanations alongside. The same pane shows arguments and proposed writes when a call needs review.

> **Experimental.** Not a supported Apollo product. Works with GraphOS Agent Services only, not the open-source Apollo MCP Server.

## Install

Use Claude Code 2.1.290 or later on macOS or Linux. In Claude Desktop's Code tab, start a **Local** session and check its own Claude Code version with `/status`; the Desktop app may run a different version from the `claude` command in your shell. If it is older, update the Desktop app and start a new Code tab session. Connect the claude.ai **GraphOS Agent Services** connector first; `/mcp` should list it.

In terminal Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add inanna-apollo/graphos-agent-mods
/plugin install graphos-agent-mods@graphos-experiments
```

In a Desktop **Local** session, add the marketplace from a shell on the same computer with `claude plugin marketplace add inanna-apollo/graphos-agent-mods`. Then select **+ → Plugins → Add plugin** in the Code tab and install `graphos-agent-mods@graphos-experiments` for your user account. Start a new Local session to load it.

Optional: allow Agent Services' read-only `search`, `introspect`, `validate`, and `dry_run` tools. In terminal Claude Code, use `/permissions`; in Desktop Code, use the shared `~/.claude/settings.json` permissions or the standalone CLI because `/permissions` has no interactive panel there. You can also choose "don't ask again" when Claude first asks. The inspector uses these tools for policy, schema, and validity checks; without them the pane still explains the parsed operation and marks those checks as not run. `/gas setup` reports anything missing.

Try asking: “Find the five most recently updated open issues in DEV and show their summary and status.” The pane opens on its own at the first permission dialog in a wide terminal, or run `/gas` to open it. If the command is missing, start a new session; in terminal Claude Code, `/reload-plugins` can also reload it. Check the plugin manager to confirm it is enabled.

## What it shows

- The operation and its arguments, with schema descriptions, types, paging, and policy information.
- Claude's `search`, `introspect`, `validate`, and `dry_run` calls: the operations and types it found, as the schema declares them, and what its checks answered.
- A result preview with links to records, plus an estimate of response size and which fields account for it.
- A proposed-write preview derived from the call's arguments. It shows new values; it does not fetch current records or compare old and new state.
- Optional GraphQL trust rules for reads you choose to run without a permission dialog. These rules only turn an `ask` into an `allow`; they cannot override a deny, organization limits, or Agent Services policy.

**Haiku explanations:** the inspector uses Claude Code's existing sign-in for helper calls—no separate API key is needed with a Claude subscription, and calls count toward your plan's usage. API-key and provider sessions use their configured billing. For a new headline, Haiku receives operation structure, argument values, and schema descriptions; lookup headlines also include bounded search terms, type names, declared members, and catalog facts. Argument values are capped at 2,000 characters. An execute headline may be requested while the permission dialog is open, even for a call you later refuse. Execution results and access-request tokens are never sent to Haiku. Headlines are best-effort and may be reused from cache. Policy decisions and verdicts come from the operation and Agent Services checks.

The inspector never calls `execute` itself. It calls only `search`, `introspect`, `validate`, and `dry_run`, and only when your settings allow those tools. Setup prompts and access requests are drafts for you to review and send. The plugin has no telemetry. Its own outgoing requests are the read-only checks and Haiku helper calls described above; opening a record link contacts its site.

## Commands

`/gas` opens the pane on the current or last Agent Services call; `/gas setup` reports anything missing. The [user guide](docs/guide.md#commands) lists every command. The [ten-minute demo](docs/demo.md) walks through discovery, a read, and its results.

## Updating

In terminal Claude Code, open `/plugin` → **Marketplaces**, update `graphos-experiments`, then run `/reload-plugins`. For Desktop Code, update the plugin from a shell and start a new Local session. The [user guide](docs/guide.md#updating-the-plugin) has the commands and auto-update details.

## Limits and details

**Claude Desktop rendering is out of scope for this release.** Native testing confirmed that connector discovery and call observation work, but the Inspector pane has broken box drawing and poor text contrast in Desktop. Use terminal Claude Code for the demo and the tested visual experience. Desktop rendering fixes are deferred.

The terminal has been checked with native rendering. The VS Code extension, mobile app, `claude -p`, and Windows are untested. Hover previews need mouse support; complete settled-call details also open with Tab and Enter. History keeps up to 128 calls and preserves details across plugin reloads, within a 16 MiB session budget. Details may expire under memory pressure and are cleared when the session ends. Terminal links open through `open` on macOS or `xdg-open` on Linux; clicked Desktop links open through the app. Custom Atlassian or Slack domains must be configured by hand. Only the claude.ai GraphOS Agent Services connector is inspected: by its tool name in terminal Claude Code, or by Desktop's reported connector name and ID. Agent Services added as another MCP server is not inspected.

See the [user guide](docs/guide.md) for write previews, trust-rule syntax, link settings, and detailed behavior. See [contributor guidance](.claude/CLAUDE.md) to work on the mod. The project is under the [Elastic License 2.0](LICENSE); questions and bug reports belong in this repository's issue tracker.
