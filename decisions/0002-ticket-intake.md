# 0002: Ticket intake: no epics by name, Intent only, no outside specs

**Status:** Accepted; the rule on findings is in [0004](0004-catch-defects-before-in-review.md)
**Date:** 2026-10-20

## Context

People follow every issue the agent creates, so the count matters. "Epic" issues duplicate what parent issues and sub-issues already do. Issues arrive in any shape. An outside agent with no repo access can write design decisions into an issue body, and a session reading the issue would build them.

## Decision

1. **No title contains the word "epic".** A real epic is a parent issue with sub-issues. A parent is never specced or built itself. The watch renames titles it sees.
2. **An issue the agent picks up must be in the Intent shape**: Problem, Outcome, and Constraints.
3. **A body carrying a spec is refused** unless it carries `human-architected` applied by an approver: they created the issue, or their own account wrote the label alone on a line in a comment. Design is decided by the agent session that reads the code and posted as a Spec comment.

A refused issue, or a parent, gets exactly one comment and goes back to its human creator (the first approver when the agent or an unknown account created it); assigning it to the agent again after fixing it restarts the check. Rules 2 and 3 apply to issues created from the config's `policyStart`. `hooks/policy.mjs` decides every check, with tests, so every session applies them the same way.

## Consequences

- Positive: fewer issues for people to follow. Design stays with the code.
- Negative: GitHub cannot restrict who applies a label, so `human-architected` is trusted only with an approver's authorship or comment. A spoofed label is ignored, not blocked.
- Neutral: older issues before `policyStart` are grandfathered, not converted.
