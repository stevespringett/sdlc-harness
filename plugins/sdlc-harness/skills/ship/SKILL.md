---
name: ship
description: Ship a built issue. Runs the repo's tests through the verifier, gets one QA review from a separate session, fixes what it found in one round, has the fixes checked, then integrates per .sdlc-harness/sdlc.json (trunk push or PR), triggers on-demand e2e when the diff warrants it, moves the issue to In Review, and posts the closing comment. Never closes the issue.
argument-hint: "GH-n"
---

# /ship GH-n

Stage 4 of the SDLC. Precondition: the issue's worktree exists and every acceptance criterion is either met or deferred with an approver's OK on the issue.

`<tracker>`, `<verify>`, and `<repo>` are the paths and tracker repo the repo block at session start prints; `<prefix>` is the issue prefix. Run every git and verify step in the checkout the issue was built in (`/build` step 4), with that checkout's config.

## Steps

1. **Check the account** (`node <tracker> whoami`, `ok: true` or stop) and read `.sdlc-harness/sdlc.json`.
2. **Clean tree.** `git status --porcelain`. Uncommitted changes → commit them or stop. Every commit names `<prefix>-<n>`; none carries `Closes`, `Fixes`, `Resolves`, or another closing keyword before an issue reference (reword any that does), so GitHub never closes the issue on its own.
3. **Rebase** onto the latest default branch: `git fetch origin && git rebase origin/<defaultBranch>`. Conflicts are yours to resolve; re-run the tests after.
4. **Verify** (the real gate): `node <verify> --quiet`. Red → fix, commit, verify again. Never weaken a test. Green writes the record git's pre-push judge checks; verify also installs the judge and records nothing until git is proven to run it.
5. **One QA pass by a separate session** (`RULES.md`, Quality before In Review). `Agent` with `subagent_type: general-purpose`, `model:` the config's `subagentModel`, and this brief: the issue number, the Spec's acceptance criteria and Touches, "review `git diff origin/<defaultBranch>...HEAD` in <worktree path>; do not edit files; check it against the principles file (the `file` path the session's `<sdlc-harness-principles>` block names), as narrowed by the exceptions the repo's `CLAUDE.md` names; the full suite already ran through verify, so run single test files only; <mutation line>; return a verdict (push / fix first) and findings, each marked Important (it makes an acceptance criterion false, unless an approver agreed on the issue to defer it; shows or writes one user's data for another; opens a security hole; loses or corrupts data; crashes or hangs the app; or, in tooling and rules, lets a check pass that should fail or makes two rules contradict) or Minor, with file:line and a concrete failure scenario; put anything outside the issue's scope (its Spec, what its Touches list, and the files its commits change) under one 'found, not fixed' line; skip style". The mutation line is "run mutation testing on the changed code" when the diff is in a risky area, and "do not run mutation testing" otherwise.
   - Fix every in-scope finding in one round (a Minor one may go under "Found, not fixed" with its reason instead), commit, and verify again (step 4).
   - Then a fresh session checks the fix commits narrowly, with this brief: the QA findings and the fix commits, "check that each finding is gone and that no fix broke anything near it; single test files only; no mutation testing unless a fix is in a risky area; mark each finding Important or Minor as above". A Minor finding from it is fixed in this round or listed under "Found, not fixed"; it never starts another round.
   - If that check finds an Important issue, stop: post it on the issue in a comment that starts "Stopped for your call", with `@<approver>`, assign that approver, and wait. A reply from an approver's own account resumes here, never at the QA pass, and assigns the agent back: "fix" (or a go) means fix what the stop named, verify, a narrow check of that fix alone, then step 6, unless that check finds an Important issue, which stops the push again; "ship" means step 6 with the finding listed; "redesign" means back to `/build`'s plan. Any other reply, such as a question, is answered in a comment that also starts "Stopped for your call", so the issue stays stopped. Never start a third round on your own.
   - Disagreements with a finding are stated in the closing comment, not ignored.
6. **agent-needs-go check.** If the issue carries `agent-needs-go` or the diff touches a protected path, confirm the go is recorded (`ls "$(git rev-parse --git-common-dir)/sdlc-harness/go/<prefix>-<n>"`). Missing → stop and say what is waiting. The judge will refuse the push anyway.
7. **Integrate.** Write any commit message or PR body to a file first.
   - `trunk`: `git push origin HEAD:<defaultBranch>`. Git runs the push judge on the exact commits sent. Then in the main checkout: `git pull --ff-only`.
   - `github-flow`: `git push -u origin <branch>` and `gh pr create --title "<prefix>-<n>: <title>" --body-file <file>`. The body lists the acceptance criteria and names the issue as `Refs #<n>` (or `<repo>#<n>` from another repo), never with a closing keyword; the Claude Code hook refuses one. The agent never merges (`gh pr merge` is refused): `agent-fully-autonomous` may rely on auto-merge an approver turned on for the repo; `agent-needs-go` waits for an approver's merge.
8. **On-demand e2e.** If any changed file matches `e2eTriggerPaths` and `e2eCommand` is set, run it after the push and note the run URL.
9. **The issue.** `node <tracker> state <n> in-review`, then assign an approver and remove the agent (`gh issue edit <n> --repo <repo> --add-assignee <approver> --remove-assignee <agent>`): acceptance is theirs. Never close the issue and never set Done. Then post the closing comment with `gh issue comment <n> --repo <repo> --body-file <file>`:

   ```
   **Shipped in `<sha>`** on <branch>.
   What now works: two to five lines, each an acceptance criterion, ticked, or deferred with an approver's OK.
   Also fixed to finish it: one line per in-issue discovery with its sha, or omit.
   Found, not fixed: one line each, for an approver to triage, or "nothing".
   Evidence: test counts, CI run URL, e2e run URL, PR URL, screenshot if any.
   Reviewed by a separate session; findings addressed: N. Disagreed: none / list.
   Ready for acceptance: close this issue as completed, or reply with what is missing.
   Claude Opus 5.5 (claude-opus-5-5)
   ```

   The last line is the model line (rule 10 of `RULES.md`) when `modelLine` is on.

10. **Clean up.** `git worktree remove <worktree path> && git branch -D <branch>` (on github-flow, only once the PR has merged). Report in under five lines.

## Rules

- Write commit messages to a file and commit with `git commit -F <file>`: a message passed on the command line can trip the Claude Code hook's word reading.
- Git's pre-push judge is the enforcement, this skill is the discipline (decision 0005). If it refuses the push, read its reason and do what it says; never pass `--no-verify`, never move `core.hooksPath`, and never edit the judge's files.
- Never force-push. Never push a branch on a trunk repo.
- A red nightly or a failed on-demand e2e caused by this push is fixed on this issue while it is open, In Review included: move it back to In Progress when the area has a free slot (`node <tracker> inflight`, the limit of `inFlightLimit`), fix, and ship again. Until a slot frees, it stays In Review, assigned to the agent, and each tick's report names it with the count. Once an approver has closed the issue, it is a Defect issue via `/ticket`, linked to this one.
- Every mistake found in review that you have seen before in this repo becomes one line in that repo's `CLAUDE.md`, in the same push.
