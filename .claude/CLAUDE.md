# GraphOS Agent Mods (GraphOS Inspector): working on this repo

The plugin is `graphos-agent-mods` (display name GraphOS Agent Mods), published from the `graphos-experiments` marketplace at github.com/inanna-apollo/graphos-agent-mods. GraphOS Inspector is the mod inside it: it explains GraphOS Agent Services `execute` calls in a docked pane and a transcript line, and auto-approves reads that fit the user's trust rules. The name GraphOS Inspector is on the pane title, the `GraphOS Inspector:` log prefix and the `skills/graphos-inspector` skill; the command stays `/gas`. The README covers what it does for users; this file covers how to change it.

## Hard rules

- **The mod never calls `execute`.** It calls only `READ_ONLY_GAS_TOOLS` (`search`, `introspect`, `validate`, `dry_run`), and only behind `$.tool.check` returning `allow` (`gasCaller` in `hooks/register.tsx`). Keep that guard.
- **Trust rules only lift an `ask` to `allow`.** They never touch a `deny`, an `allow`, or an organization `ceiling`, and the matcher's hard floor stays. Mutations, subscriptions, change-named roots, directives and unparseable input never fit. Any change to `src/trust.ts` needs adversarial unit tests.
- **A saved `trust.graphql` is never read or applied on its own.** The file watcher (`classic.FileChanged`) only reports the save. The rules in memory change only at session start, on `/gas trust`, and when the plugin module is reloaded (a fresh instance reads the file once). This is what stops an agent that writes the file mid-session from widening what runs without a permission dialog, so no code path may read the file in response to a save. `tests/watch.test.ts` holds it.
- **A learned site only fills an empty base, and only from a vendor tenant host.** `src/sites.ts` decides which hosts a click may open without the user naming them: `<name>.atlassian.net` and `<name>.slack.com`, taken only from the vendor's own metadata in an Agent Services response under a Jira, Confluence or Slack root (`isSiteKey`: a record's `self`, `_links.base`, a status's, priority's or issue type's `iconUrl`, Slack's auth-test `url` and a message's `permalink`), never from content a person wrote (`CONTENT_KEYS`: descriptions, comments, bodies, Slack blocks and attachments) and never from what the model wrote. It never replaces a `links.toml` entry (`""` turns a base off) or a site already learned, and a stored value is checked with `tenantOf` on every load. Any change to `src/sites.ts` or to how `loadLinkConfig` merges `learned` needs adversarial unit tests (`test/unit/sites.spec.ts`).
- **Live testing reads only.** In the tester, approve only read queries. Never make a mutating Agent Services call or file an access request to test anything; verify with reads.
- **Never write `~/.claude/graphos-agent-mods/trust.graphql` or `links.toml` without asking the user.** They are the user's real config and affect every session.

## Layout

- `hooks/register.tsx` is the only module that touches `$`. It holds the events (tool.call, tool.check, ui.render, command.run), the enrichment pump, state atoms and file loading.
- `src/` is pure, with no `$`:
  - **parse** (`adapter.ts`, `normalize.ts`, `build.ts`);
  - **Agent Services enrichment** (`enrich.ts`, `gas.ts`, `annotate.ts`, `schema.ts`);
  - **results** (`result.ts`), and what a response cost in context (`weight.ts`, saying it for the pane: `view/receipt.ts`);
  - **links** (`links.ts`, `links.toml`, regenerated into `default-links.ts` by `node scripts/default-links.mjs`) and **learned sites** (`sites.ts`: what a response teaches, the `/gas links` report, the `/gas setup` question);
  - **setup** (`setup.ts`, the `/gas setup` report from facts the hook gathers) and **the release the mod needs** (`version.ts`);
  - **trust rules** (`trust.ts`);
  - **the history queue** (`queue.ts`);
  - **Haiku's headline** (`summary.ts`);
  - **write preview** (`preview/`): what a mutation changes, from its own arguments and the schema (`changes.ts`), the hand-mapped Jira, Confluence and Slack writes as data with the read each would need, stored and never run (`table.ts`), rich text flattened to lines (`flatten.ts`), and what a write's response says back (`confirm.ts`). It reads no record: the hard rule stands.
- `src/view.tsx` and `src/view/` hold the pane. `plan.ts` counts every block's rows so the pane can shed detail to fit, and places hover cards (`Plan.anchors`). `ui/hover.tsx` and `ui/preview-cards.tsx` draw the cards; `diff.tsx` draws a write's CHANGES and their cards.
- `types/index.d.ts` is the `$.state` contract. It must stand alone; `src/ir.ts` re-exports it. Its plugin key, every atom's `plugin:` and `name` in `.claude-plugin/plugin.json` are one spelling (`test/unit/manifest.spec.ts` holds them).
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are the manifests (the marketplace's description sits under `metadata.description`). `plugin.json` has no `version` on purpose: Claude Code then versions the plugin by commit, so every push reaches people who update (a pinned version keeps them on the old copy however many commits follow); `validate` warns about it. The manifest declares no `userConfig`: Claude Code asks for every declared option at install, which made installing feel like a form; sites are learned or set in `links.toml` (`src/links.ts` still takes options, which the tests use to set bases). No lockfile is tracked: a `package.json` with a lockfile at the root makes Claude Code npm-install the dev tooling into every install. The user's own files live in `~/.claude/graphos-agent-mods/` (`userFile` in `hooks/register.tsx`).
- Tests: `test/unit/*.spec.ts` covers pure modules (node:test). `tests/*.test.ts` runs the hooks through the mod test harness (`claude-code/testing`). A hook test that needs the plugin store gives it its own `store.get`, `store.set` and `store.delete` hooks (`tests/learn.test.ts`), and one that needs the shipped `links.toml` feeds its own small fixture to `fs.read` rather than depend on the real file. The hover tests take 4 to 7 s against the harness's 5 s limit and time out when the machine is busy: run the suite again before suspecting a change.
- Docs:
  - `README.md` is for users; update it with every user-visible change;
  - `docs/pane-design.md` holds pane design decisions;
  - `docs/spikes.md` holds what the mod API turned out to do. Read it before fighting the engine.

## Checks (all four before every commit)

```sh
npx -p typescript@5 tsc -p . --noEmit     # or any tsc 5; needs .claude-plugin/types/ (written by Claude Code)
node --test test/unit/*.spec.ts
claude plugin test .
claude plugin validate .                   # lists every $ call; passing $ into imported functions is rejected
```

## Conventions

- **Names.** The product is GraphOS Agent Services on first mention and Agent Services after that; the feature is GraphOS Inspector; the command is `/gas`. "GAS" is internal shorthand: it stays in code identifiers and file names (`READ_ONLY_GAS_TOOLS`, `gasCaller`, `src/gas.ts`) and in nothing a user sees: not a string, card, flag, log line, setup report, doc, manifest or skill. Say "an Agent Services call", not "a GAS call". Tool ids (`mcp__claude_ai_GraphOS_Agent_Services__*`), the plugin name and the error code `CONSTELLATION_ACCESS_DENIED` are spelled as they are.
- **Computed, never model text.** Verdicts, flags, policy and trust decisions come from the parse, the schema and Agent Services' checks. Haiku writes one headline from the operation and the schema.
- **Wrap, don't truncate.** Never cut a name or content with `…`. Wrap it and have the planner count the rows; `tests/parity.test.ts` holds planned rows to drawn rows at every width. `truncate-end` is for decorative text only. Stored caps are generous safety bounds, at least 2–3× realistic values.
- **Cards on everything.** Every name the pane draws gets an information-rich hover card: description (or "no description in the schema"), type in notation and in words, paging role, policy, and what came back. The pane is partly a learning tool. The visible form stays compact.
- **An info pane, not a debug log.** No tool ids, server names or plumbing in the pane.
- **Escape all untrusted text** (`esc` / `escapeText`), and bound everything kept in `$.state`.
- **Light, behavioral tests.** A UI test checks only what a person would notice: some text appears, a press works, a status changes. Never assert exact rendered lines, offsets or props. Behavior tests never depend on shipped data (links.toml hosts, rule counts); they use fixtures. A test that breaks because the layout moved gets loosened or deleted, not re-pinned. Be thorough on pure logic and invariants: normalize, escape, trust, parity.
- **Commit messages** are one descriptive sentence saying what now holds and why, like the existing log. Local commits only unless the user asks to push.

## Live testing

- A second Claude runs `claude --plugin-dir . --model haiku` from the repo root, in manual permission mode.
- The tmux window `tester` is the maintainer's workflow, not something the repo needs: drive that Claude with `tmux send-keys -t tester`, read it with `tmux capture-pane -p -t tester`, and screenshot the pane with `scripts/pane-shot.sh <target> [out.png]`.
- Redraw after a code change with `/gas older` then `/gas newer`.
- Hover can't be simulated (tmux mouse events don't hover, and the harness pointer reaches only `Client` elements), so check cards by hand.

## Subagents in worktrees

A worktree agent needs `node_modules` and `.claude-plugin/types` symlinked from the main checkout before the checks run. Leave those symlinks uncommitted. Tell agents the testing conventions above.
