# Company-wide decisions

One file per decision, numbered, never deleted. Supersede instead of editing. Same format as a repo ADR, capped at 400 words: Context, Decision, Consequences. Alternatives only when a rejected option keeps coming back.

Write one only when the decision applies to more than one repo or to how we work. Decisions about a single system live in that system's `docs/adr/`. A client adopting the harness keeps these, and adds its own from 0009.

| # | Title | Status |
|---|---|---|
| [0001](0001-github-issues-first-trunk-based-sdlc.md) | GitHub Issues-first, trunk-based SDLC with labeled autonomy | Accepted; detailed by 0003, enforcement by 0005, narrowed by 0006 |
| [0002](0002-ticket-intake.md) | Ticket intake: no epics by name, Intent only, no outside specs | Accepted |
| [0003](0003-approvers-approve-and-accept.md) | Only the approvers approve an issue for work and accept it | Accepted |
| [0004](0004-catch-defects-before-in-review.md) | Catch defects before In Review, and keep findings on their issue | Accepted; the limit superseded by 0007 |
| [0005](0005-git-judges-the-push.md) | Git's own pre-push hook judges every push | Accepted |
| [0006](0006-build-principles-are-company-wide.md) | Build principles are company-wide; a repo narrows one, never contradicts it | Accepted |
| [0007](0007-areas-own-issues-and-the-in-flight-limit.md) | Work areas own issues; the in-flight limit counts per area | Accepted |
| [0008](0008-session-start-fits-the-hook-output-cap.md) | Session-start text is split to fit Claude Code's hook-output cap | Accepted |
