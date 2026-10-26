# 0011: Linear is reached through its MCP connector, as the agent's own member

**Status:** Accepted; refines [0010](0010-issue-trackers-sit-behind-one-adapter.md) rule 2 for Linear
**Date:** 2026-10-26

## Context

Teams that keep their work in Linear should be able to run the harness with no code of their own. Linear's MCP connector already gives a Claude Code session every read and write the SDLC needs (`get_issue`, `list_comments`, `list_issues`, `save_comment`, `save_issue`, `get_notifications`, `mark_notification`), logged in as whoever connected it. A Node helper cannot call MCP tools; only the session can. An API key would be one more secret on every machine.

## Decision

1. **`tracker.kind: "linear"` with `tracker.team`** (the team key, such as `ENG`). The key is the issue prefix, since every Linear id carries it.
2. **The session makes the Linear calls; the helper decides.** The session saves what it read and pipes it through `tracker.mjs` (`whoami`, `issue`, `inflight`, `queue`, `inbox`), which turns it into the shape `policy.mjs` reads. Approval, intake, ownership, and the in-flight count are decided by the same code as on GitHub. The session-start text names the Linear call for every tracker operation, so the skills stay the same for every kind.
3. **The connector is logged in as the agent's own Linear member**, never an approver's: `tracker: whoami` refuses otherwise. People match by Linear UUID alone.
4. **The hook guards Linear writes**, since no helper sees them: only comments, issues, notifications, labels, and attachments are written; `save_issue` never sets a completed or canceled state, marks a duplicate, or files or moves an issue outside the team.
5. **The push judge refuses Linear's closing words** (every form of close, fix, resolve, complete, and implement) before the team's ids.

## Consequences

- Positive: a Linear team needs only the connector, a member for the agent, and the config.
- Negative: Linear lets only a comment's author edit it, and the harness relies on that: an edited comment's editor is taken to be its author. Linear does not say who edited a description, so a description edit after an approver applied `human-architected` is not detected.
- Negative: the hook cannot tell an approved Spec from another comment, so not editing one rests on the rule and the policy's `approved` answer.
- Negative: Linear's Git automations can move an issue to Done on a merge without any closing word. Each team sets "On merge" to In Review or no change.
