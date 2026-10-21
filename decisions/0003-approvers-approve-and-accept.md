# 0003: Only the approvers approve an issue for work and accept it

**Status:** Accepted; where the go is enforced, see [0005](0005-git-judges-the-push.md)
**Date:** 2026-10-20

## Context

Any account with triage access can change an issue's labels, status, or board column. An outside AI working through a person's login can post relayed "approvals". Anyone with write access can edit any comment. And GitHub closes an issue by itself when a commit or merged pull request says `Fixes #12`, so nobody accepts the work.

## Decision

1. The configured approvers are the only people who approve an issue for work and the only people who accept it. The agent account is never one; a config that names it as one approves nothing.
2. Approval to build is a comment from an approver's own account (login, and id when given) with a line that is just `approved` or `go`, after the latest `## Spec` comment by the agent and after that Spec's last edit. A Spec changed after approval is posted as a new comment. An edited approval counts only when an approver made the edit. A comment without a valid date fails the check. No label or status is approval, Not Started included.
3. No other account approves, confirms, or accepts. A line reporting someone else's decision never counts. Comments from bots, or that read as an outside AI (the helper's `untrustedComments`), are input at most.
4. `/ship` moves a shipped issue to In Review and assigns an approver. An approver closes it as completed. The agent never closes an issue and never writes a closing keyword: git's pre-push judge refuses a commit message with one, and the Claude Code hook refuses `gh issue close` and a PR title or body with one.

## Consequences

- Every build waits for one short comment from an approver, the small autonomous fixes included.
- Done means an approver looked at it, not that a commit landed.
- Logins can be renamed; giving each approver's numeric id in the config closes that gap.
- Detecting outside-AI text is heuristic. A false positive only demotes a comment to input; it never blocks an approver.
