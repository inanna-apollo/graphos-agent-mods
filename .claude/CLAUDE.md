# Contributor guide

This repository publishes `graphos-agent-mods` (display name **GraphOS Agent Mods**) in the `graphos-experiments` marketplace at [inanna-apollo/graphos-agent-mods](https://github.com/inanna-apollo/graphos-agent-mods). **GraphOS Inspector** is the feature; `/gas` is its command. The README and [user guide](../docs/guide.md) describe the experience; this file covers implementation constraints and contributor workflow.

## Safety boundaries

- The mod never calls Agent Services `execute`. It may call only `search`, `introspect`, `validate`, and `dry_run`, and only after `$.tool.check` returns `allow`. Keep the guard in `hooks/register.tsx`.
- Trust rules may change only `ask` to `allow`. They cannot override `deny`, an existing `allow`, or an organization ceiling. Mutations, subscriptions, change-named roots, any directive except a resolved `@skip` or `@include`, nested differing type conditions on the same value, and unparseable operations must never fit. Changes to `src/trust.ts` need adversarial behavior coverage.
- A saved `trust.graphql` is reported, never read or applied by the file-change handler. In-memory rules change at session start, `/gas trust`, or plugin reload. Do not add a code path that reloads the file on save.
- Learned links may fill only an unset base, and only from verified vendor metadata in an Agent Services response. Never learn a host from user-authored content or model text. Do not replace a configured or already learned host; validate stored hosts when loading them. Changes to `src/sites.ts` or learned-base merging need adversarial coverage.
- Live Agent Services checks are read-only. Never test with a mutation or file an access request.
- Never edit `~/.claude/graphos-agent-mods/trust.graphql` or `links.toml` without the user's explicit instruction. They are real user configuration.

## Architecture

- `hooks/register.tsx` is the only module that calls the mod API (`$`). It registers hooks and commands, coordinates enrichment, and owns session state. Every hook matcher names the claude.ai connector's server (`claude_ai_GraphOS_Agent_Services`, `CONNECTOR` in `src/servers.ts`): a matcher on any server's tool (`mcp__.+__search`) would route every MCP server's calls through the mod.
- `src/` contains the pure implementation, with no `$`:
  - parsing: `adapter.ts`, `normalize.ts`, `build.ts`;
  - Agent Services enrichment: `enrich.ts`, `gas.ts`, `annotate.ts`, `schema.ts`;
  - results: `result.ts`; response size: `weight.ts`, shown by `view/receipt.ts`;
  - links: `links.ts`, plus the shipped `links.toml`, regenerated into `default-links.ts` by `node scripts/default-links.mjs`;
  - learned sites: `sites.ts`; setup: `setup.ts`; the required Claude Code release: `version.ts`;
  - trust: `trust.ts`; history: `queue.ts`; the headline: `summary.ts`;
  - write previews: `preview/`.
- `src/view.tsx` and `src/view/` draw the pane and the transcript blocks. `view/plan.ts` counts every block's rows, sheds detail to fit, and places hover cards.
- `types/index.d.ts` defines the `$.state` contract and must stand alone; `src/ir.ts` re-exports it. Keep the plugin key and state atom names consistent with `.claude-plugin/plugin.json` (`test/unit/manifest.spec.ts` checks them).
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are the manifests. `plugin.json` intentionally has no `version`: Claude Code then versions the plugin by commit, so every push reaches people who update, while a pinned version holds them on the old copy. It declares no `userConfig`, because Claude Code prompts for every declared option at install. User files belong under `~/.claude/graphos-agent-mods/`.
- The mod has no runtime dependencies. `package.json` holds development tooling only. Do not add a root lockfile: Claude Code can install the root package's development dependencies into every plugin installation.
- `README.md` is the concise entry point; `docs/guide.md` is the detailed user reference. `docs/pane-design.md` records design decisions, and `docs/spikes.md` records behavior learned from the mod API.

## Implementation conventions

- User-facing product terminology is **GraphOS Agent Services** on first mention, then **Agent Services**; the feature is **GraphOS Inspector**. `GAS` is internal shorthand only. Preserve exact tool IDs, plugin identifiers, and service error codes.
- Verdicts, flags, policy, and trust decisions come from parsed operations, schema data, and Agent Services checks. Haiku supplies only a best-effort headline from the operation and schema. Keep its inputs and data boundaries explicit.
- Escape untrusted text and bound values retained in `$.state`. Wrap names and content; never cut them with `…` (`truncate-end` is for decorative text only). `tests/parity.test.ts` holds planned rows equal to drawn rows at every width. Stored caps are safety bounds, 2–3× realistic values. Show details that explain the operation; keep tool IDs, request IDs, and debug output in tests or diagnostic logs.
- Every name the pane draws gets a hover card: its description (or that the schema has none), its type in notation and in words, paging role, policy, and what came back. Keep the visible content concise and put the detail in cards.
- Tests should protect behavior and invariants. UI tests should check user-noticeable outcomes, not exact prose, offsets, or layout props. Use fixtures instead of depending on shipped hosts or changing data. Test pure logic deeply, especially parsing, escaping, trust, learned links, and layout/draw parity. Copy-only edits do not need tests. A test that breaks because the layout moved is loosened or deleted, not re-pinned.
- The invariants each have a test: `tests/watch.test.ts` (a saved trust file is never applied), `test/unit/sites.spec.ts` (learned sites), `test/unit/trust.spec.ts` (the trust floor), `tests/parity.test.ts` (rows and card anchors).
- Hook tests use `claude-code/testing`. One that needs the plugin store gives it `store.get`, `store.set` and `store.delete` hooks (`tests/learn.test.ts`); one that needs `links.toml` feeds a fixture to `fs.read`. The hover tests take 4–7 s against the harness's 5 s limit: rerun before suspecting a change.
- Commit messages are one sentence saying what now holds and why, like the existing log.

## Checks

Install local development tooling with `npm install --no-package-lock`.

Run focused checks while iterating. Before review, run the applicable full checks:

```sh
npm run typecheck
npm run test:unit
npm run test:plugin
npm run validate
```

Use Node 22.14 or later. `test:unit` enables Node's TypeScript stripping. `typecheck` checks the implementation, hook tests, and unit tests; it requires installed development dependencies and `.claude-plugin/types/` generated by the matching Claude Code CLI. `test:plugin` runs the hook harness, and `validate` checks manifests and permitted mod API calls. Documentation-only changes need a review of the text and links.

For a live smoke check, use a separate Claude Code session with `claude --plugin-dir . --model haiku` in manual permission mode. Approve only read queries. After a code change, `/gas older` then `/gas newer` redraws the pane. A local tmux workflow may be used if available; hover cards still need manual checking. Snapshot and timing commands are maintainer diagnostics. Snapshot output is opt-in and may include operation arguments and results; inspect it before sharing. Timing output goes to a git-ignored log.

A subagent in a git worktree needs `node_modules` and `.claude-plugin/types` symlinked from the main checkout before running checks; leave the symlinks uncommitted.
