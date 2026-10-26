---
name: spec
description: Turn a GitHub issue's intent into an approvable spec. Reads the issue and the repo, posts a Spec comment from the agent's own account (acceptance criteria, touches, size, autonomy label, decisions needed), applies the label, asks at most three questions as one comment. Never writes code and never closes or moves the issue.
argument-hint: "GH-n (or the issue number)"
---

# /spec GH-n

Stage 2 of the SDLC. Output is a `## Spec` comment on the issue, written by the agent's own GitHub account so the spec is attributed to the agent and the description stays the author's intent, and, if needed, one comment with questions. An approver approves by replying `approved` (or `go`) on the issue from their own account; this skill never changes status and never treats a status or a label as approval.

`<tracker>`, `<policy>`, and `<repo>` are the paths and tracker repo the repo block at session start prints.

## Steps

1. **Check the account.** `node <tracker> whoami`; anything but `ok: true` → stop and say why.
2. **Intake checks** (`RULES.md` Ticket intake). `node <tracker> issue <n> > <file>`, add `"model": "<your model line>"` to the JSON, and run `node <policy> check < <file>`. Config `problems` in the verdict → stop and name them. A `title.rename`: `gh issue edit <n> --repo <repo> --title "<rename>"` (or write a title from the description when it is null). `parent: true` or `blocked: true`: post `notice` with `gh issue comment <n> --repo <repo> --body-file <file>` if it is not null, assign the helper's `assignTo` (`gh issue edit <n> --repo <repo> --add-assignee <login> --remove-assignee <agent>`), report the one line, and stop. A parent is never specced; its sub-issues are.
3. **Read the issue and every comment** (the file from step 2 holds them all). If a `## Spec` comment by the agent already exists, you are revising it: read the answers in the comments and fold them in. The latest `## Spec` comment by the agent is the Spec.
4. **Area** (`RULES.md`, Areas). If the issue has no area label, pick the existing one that covers it and add it with `gh issue edit --add-label`. If none fits, leave it empty and post a one-line comment asking an approver which area, separate from the questions in step 8. An issue that already has an area keeps it; suggest a move in a comment if it looks misfiled. Setting an area can hand the issue to another repo's session: run `node <policy> owner < <file>` on the issue with its new label, and on `mine: false` stop there. With an `owner`, say in one line which area owns it now; when a person started this skill rather than the watch, tell them to run it from the repo whose config names that area. With `owner: null`, post a one-line comment saying so and assign an approver.
5. **Read the repo where it matters**. `.sdlc-harness/sdlc.json` for protected paths and the test command. The repo's `CLAUDE.md` and architecture docs for the area involved, and the build principles (`PRINCIPLES.md`, printed at session start), which the design follows except where that `CLAUDE.md` names an exception. Then the actual files the change would touch. Do not guess at file names; open them. Use the `Explore` agent for a wide search when the area is unclear. When the change lands in another repo, read that repo's checkout and config the same way (`RULES.md`, Areas, rule 7).
6. **Decide the autonomy label** with the rules in `RULES.md`, then apply it with `gh issue edit --add-label` (and `--remove-label` for any other autonomy label the issue carries):
   - `human-only` already present, or the work is legal, billing keys, data deletion, production deploy, or a product decision only a person can make → `human-only`. Write the Spec anyway so the human has it, and say who must do it.
   - Feature label, or size L, or any file under a protected path → `agent-needs-go`.
   - Otherwise → `agent-fully-autonomous`.
7. **Post the Spec as a comment.** Never write it into the description: that is the author's intent, and a Spec there reads as theirs. Creating: `gh issue comment <n> --repo <repo> --body-file <file>`. Revising before an approver approved it: edit the existing Spec comment in place (`gh issue comment <n> --repo <repo> --edit-last --body-file <file>` when it is your latest comment; otherwise post a new one), and change the date line to `Revised YYYY-MM-DD`. Revising after an approver approved it (the helper says `approved: true`): post a **new** `## Spec` comment and never edit the approved one, so the approval does not carry over to text they have not seen. The last line is the model line, rule 10 of `RULES.md`:

   ```
   ## Spec
   **Acceptance criteria**
   - [ ] three to seven boxes, each one testable, each one visible to a user or an API caller
   **Touches** the repo it lands in, then the files or subsystems; mark protected paths with (protected)
   **Size** S / M / L, with the one reason that decided it (`RULES.md`, Sizing)
   **Autonomy** agent-fully-autonomous / agent-needs-go / human-only, with the one reason that decided it
   **Decisions needed** at most three, each as: question, recommended answer, why. Omit the heading if there are none.
   **Not in scope** what a reasonable reader might expect but will not get

   Specced YYYY-MM-DD.
   Claude Opus 5.5 (claude-opus-5-5)
   ```

   Touches names the repo the change lands in; that line never decides who owns the issue (the area does).

8. **Questions go out as one comment**, not inside the Spec, ending with the model line, with `@<login>` for the person who must answer. Then assign that person. Say in the comment that the issue is ready for an approver's approval once they answer. With no questions, assign an approver: their approval comment is the next move, for every label.
9. **Report** in under five lines: autonomy label, size, number of acceptance criteria, number of questions and who they went to, and "ready for approval" or "waiting on answers".

## Rules

- No code, no plan, no branch. If you catch yourself naming the order of implementation steps, stop; that is `/build`'s plan comment.
- Acceptance criteria describe observable behavior, never internal structure. "The instructor sees the rubric on the grading card" is a criterion. "Add a JSONB column" is not.
- An issue that fails the intake checks is not ready to spec; the helper's one notice says why. An older, grandfathered issue with no Problem or Outcome gets the same treatment by hand: one comment asking for them (none if a comment from the agent already asks), assign the creator (the first approver when the agent created it), stop.
- A trusted `human-architected` issue: the body is the design. The Spec follows it; a conflict with the code is a question in step 8, never a silent change.
- Batch the questions. One comment with up to three. Never a second round before the first is answered.
- Never write a closing keyword in a comment, and never close, reopen, or move the issue's status here.
