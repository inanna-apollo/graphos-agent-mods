---
name: graphos-inspector
description: Use when preparing GraphOS Agent Services execute operations in Claude Code. GraphOS Inspector may show the operation, arguments, policy checks, and results while the user reviews the call.
---

# Prepare calls the user can review

Write the operation the task needs. GraphOS Inspector parses the call and shows its actual field names, arguments, schema information, and available policy checks in the pane and transcript. The permission dialog decides whether the call runs; the inspector does not change Agent Services policy.

- Send one operation per call. The inspector parses a single operation, and trust rules never match a document with more than one.
- Name operations descriptively when practical, and include only fields needed for the task. Avoid unused fragments and unnecessary rows.
- Use aliases when they help shape or distinguish the response. The pane shows the underlying field names, so do not assume an alias changes what the inspector displays or what a field does.
- Pass arguments as variables when that makes the operation clearer. Include an explicit limit when the service supports one and the task has a useful bound; the pane can show an “up to N” limit only when the call supplies it.
- Request personal data when the task needs it. Agent Services policy determines whether it is allowed, masked, or denied.
- Bound response size where practical. Select long descriptions and comment bodies when the task needs them. The pane measures compact JSON in UTF-8 bytes and estimates tokens as bytes divided by four.
- For writes, provide the values being changed and any other arguments the API requires. The preview derives proposed changes from the call's arguments; it does not read the record or compare against current state. A repeated value can therefore appear as a change. Arguments the API requires on every call still appear, such as Confluence's `title`, `status`, and `versionNumber` on a page update. Use the service's actual target identifiers, such as an issue key, page ID, channel ID, or message timestamp. Jira transitions take the transition as `{ id }`.

## Trust rules

The user may configure `~/.claude/graphos-agent-mods/trust.graphql` so matching reads can run without a permission dialog. A call that does not match still asks as usual.

- Change trust configuration or run `/gas trust` only when the user explicitly requests it. Do not create or widen rules on your own to approve a pending call. When asked to help configure trust, explain the reads and argument ranges each proposed rule permits.
- Saving the file during a session does not change the rules already loaded. The inspector reports the save; the user can reload rules with `/gas trust`.
- Do not reshape a call just to fit a rule. Prepare the operation the task requires; if it asks for approval, leave that decision to the user.
- A call that runs without asking still goes through Agent Services policy. Masked or denied fields remain masked or denied.
