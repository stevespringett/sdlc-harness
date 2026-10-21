# 0007: Work areas own issues; the in-flight limit counts per area

**Status:** Accepted
**Supersedes:** rule 5's limit in [0004](0004-catch-defects-before-in-review.md)
**Date:** 2026-10-20

## Context

Several repos can share one tracker and one agent account, each with its own watching session. If ownership comes from more than one place (the repo an issue lives in, the files its Spec touches, a label), sessions read it differently. If the in-flight limit counts every session's work, one busy session blocks another that sits idle on approved work it owns.

## Decision

1. **The area decides the owner, and nothing else does.** Every issue carries one `area:<name>` label. The repo whose config names that area owns the issue; `defaultArea` owns an issue with no area, and one with several when it is among them. Several areas without the default have no owner until an approver decides. The area list is the approvers' alone. Labels were chosen over milestones (kept for releases and dates) and over a Projects field (optional for status) because a label works on every plan, through every client, and needs no board.
2. **A session builds only the issues its area owns**, and every watch reads the same inbox: `tracker.mjs inbox` marks each notification with its owner, and `tracker.mjs read` refuses to mark another area's.
3. **Up to `inFlightLimit` builds in flight per area (default 5).** In flight is an open issue assigned to the agent whose status is In Progress. A session counts only its own area's; another area's work never counts against it and never blocks it. A parked build names the count and every issue counted. `policy.mjs inFlight` decides, with tests.
4. **Cross-repo work stays with its owner.** An owned issue whose change lands in another repo is built by the owning session in that repo's checkout, with that repo's config, and counts against the owning session's limit. With no checkout of that repo, the build stops and says so.

## Consequences

- Positive: one source of ownership, so every session reads it the same way.
- Positive: sessions never block each other's work.
- Negative: an issue with no area label, and no default area, waits for an approver.
- Neutral: a repo that names no area runs no watch, and a session there counts every area's builds.
