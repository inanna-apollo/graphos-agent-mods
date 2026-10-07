---
name: graphos-inspector
description: Use when calling the GraphOS Agent Services execute tool. The user may review each Agent Services execute call in the GraphOS Inspector pane and a verdict line under the call; write operations that read clearly there.
---

# Writing Agent Services operations the user can review

Each Agent Services `execute` call you make is explained to the user, in the GraphOS Inspector pane where it is open and in a verdict line under the call, often while they decide whether to approve it. The pane parses the operation and shows its real field names, arguments, access policy and a short summary. Make that review quick and accurate:

- **Name every operation** after what it does: `query SearchQueryPlanPages`, not an anonymous `{ … }`. The pane shows the name so the user can match it to the permission dialog.
- **Don't alias root fields.** The pane always shows real field names, so an alias only adds noise, and an alias that disagrees with the field (`safeRead: deleteIssue`) reads as an attempt to mislead.
- **Pass inputs as variables**, with explicit limits (`limit`, `first`, `pageSize`). The pane shows "up to N" only when the limit is explicit.
- **Select only the fields the task needs.** Each field is checked against access policy, and fewer fields make a clearer review. Still request personal data when the task needs it; policy decides, not you.
- **Mind the context a response uses.** The pane shows the user how big each response was and which field took most of it (`58 KB · about 14k tokens · description 71%`), and flags one field that is most of a big result. Long free text (descriptions, comment bodies) is usually that field: select it only when the task reads it, and ask for fewer rows rather than more. A response over the tool's size limit is saved to a file and you see only a preview and its path.
- **For a write, send only what changes.** The pane shows a mutation as a diff read from its own arguments: every field it sets is a new value (`+`), rich text as its lines, the target by its id. A field you restate unchanged reads as a change, so leave it out, apart from what the API requires on every call (Confluence's `title`, `status` and `versionNumber` on an update). Name the target by the id the service uses (an issue key, a page id, a channel id and a message ts), and pass Jira's `transition` as `{ id }`: the pane says the id, never a name you give it.
- **One operation per call**, with no unused fragments.
- **Keep comments out of operations.** The pane never shows them, so they can't explain anything to the user.

Nothing here changes what Agent Services allows. The pane explains a call; the permission dialog decides.

## Trust rules are the user's, not yours

The user may keep trust rules in `~/.claude/graphos-agent-mods/trust.graphql`: GraphQL shapes of reads that run without a permission dialog. A call that fits runs unasked; anything else asks as usual.

- **Never create, edit, or suggest edits to that file**, and never run `/gas trust` yourself. Widening it is the user's decision alone, like editing their permission settings.
- A change to the file mid-session takes no effect: the rules loaded at session start stand until the user runs `/gas trust`, and the user is told the file changed. Writing it is never a way to get a call through.
- Don't reshape a call to squeeze it inside a rule. Write the operation the task needs; if it asks, it asks.
- A call that ran unasked still went through Agent Services' policy: masked and denied fields come back masked and denied.
