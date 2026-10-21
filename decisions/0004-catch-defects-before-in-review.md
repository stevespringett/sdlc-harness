# 0004: Catch defects before In Review, and keep findings on their issue

**Status:** Accepted; rule 5's limit superseded by [0007](0007-areas-own-issues-and-the-in-flight-limit.md)
**Date:** 2026-10-20

## Context

Left alone, an agent files a new issue for every finding a build or a review turns up, and each fix's review finds the next hole. Reviews run many rounds, people drown in follow-up issues, and defects reach In Review that one more look would have caught.

## Decision

1. **Design review before code.** For size M and up, or a change in a risky area (sign-in and sessions, payments, permissions, data sync, tenancy, the SDLC hooks), a separate agent reviews the plan before any code. The plan names every call site it changes and every failure case it covers: other tabs, offline, races.
2. **An issue owns its fixes.** A finding in the issue's scope (its Spec, its Touches, and the files its commits change) is fixed on the issue, as more commits, though a Minor one may be listed instead. A new issue is filed only when something outside the issue blocks it. Any other finding goes in the closing comment under "Found, not fixed", and an approver picks what becomes an issue.
3. **One QA pass, one fix round.** A separate agent reviews the diff once before the push. In-scope findings are fixed in one round, and a fresh agent checks those fixes narrowly. If that check finds something Important (a false acceptance criterion, one user's data shown or written for another, a security hole, lost or corrupted data, a crash or a hang), the agent stops and asks an approver, whose reply decides. The agent never starts a third round itself.
4. **Redesign a hot spot.** When a third issue in a week fixes the same module, the agent proposes one design for it on the newest issue, reviewed under rule 1, and folds the others in once an approver approves.
5. **A limit on builds in flight**, and mutation testing only in the risky areas.

## Consequences

- Positive: fewer issues to follow, defects caught when they cost least, fewer tokens on review rounds.
- Negative: a finding outside the issue waits for an approver's triage, and some never become issues.
- Negative: a design review delays the first commit on large or risky work.
