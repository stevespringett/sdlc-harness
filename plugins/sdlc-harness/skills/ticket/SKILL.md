---
name: ticket
description: sdlc-harness only, in a repo with .sdlc-harness/sdlc.json. File an issue in the Intent shape (Problem, Outcome, Constraints, Not in scope, Open questions) in the tracker that config names, GitHub Issues or Linear. Use for any new piece of work, and mid-build only for something outside the issue that blocks it, where it adds the Discovered label and links the issue you are on.
argument-hint: "<what you noticed or want> [--from <prefix>-n]"
---

# /ticket

Stage 1 of the SDLC. Captures intent in the issue tracker. Never plans, never builds.

`tracker: <op>` is an operation on the issue tracker: the repo block at session start says how this repo's tracker does each one (a `tracker.mjs` command for GitHub, a Linear MCP call for Linear). `<prefix>` is the issue prefix (default `GH`).

**First, check this is the sdlc-harness's repo.** If the repo root has no `.sdlc-harness/sdlc.json`, stop and say this skill is for repos the sdlc-harness plugin manages; if the repo has another SDLC plugin's config instead (such as `.arpezia/sdlc.json`), that plugin's skill of the same name is the one to use.

## Steps

1. **Check the account**. `tracker: whoami`. Anything but `ok: true` → stop and say what it reported: the agent writes only through its own tracker account, never an approver's.
2. **Check for a duplicate**. `tracker: search <two or three distinctive words>`. If an open issue already covers it, say so with its number and stop.
3. **Write the description** to a file, in this exact shape, plain prose, no filler:

   ```
   ## Problem
   what is wrong or missing, for whom

   ## Outcome
   what is true when this is done

   ## Constraints
   money, legal, timing, IP, compatibility; "none known" is a valid answer

   ## Not in scope
   one line, or omit

   ## Open questions
   anything unsure; omit if none

   Claude Opus 5.5 (claude-opus-5-5)
   ```

   The last line is the model line (rule 10 of `RULES.md`), when the config's `modelLine` is on: the model and version writing the issue, on its own line.

4. **Pick the area** (`RULES.md`, Areas). `tracker: labels`, and pick the existing area whose name and description cover the outcome. If none fits, file it without one, say so in a comment, and assign the first approver. Never create, rename, or delete an area label.
5. **File it.** `tracker: create --title "<title>" --body-file <file> --label <Feature|Improvement|Defect> --label <area label>`. The title: under 80 characters, names the outcome, no ticket-speak, and never the word "epic" (Ticket intake, rule 1). Exactly one of Feature, Improvement, Defect. No status label: no status is Backlog. No assignee unless the request names one. Work too big for one outcome is a parent issue with sub-issues: file the parent, then each child, then `tracker: sub <parent> <child>` for each.
6. **Mid-build** (`--from <prefix>-n`, or you are inside `/build`): file only for something outside that issue that blocks it. Work the issue needs to be finished, and anything found in its scope (`RULES.md`, Quality before In Review), is committed on it instead (non-negotiable 2; a Minor review finding may go under "Found, not fixed"). Any other finding goes in its closing comment under "Found, not fixed" for an approver to triage (decision 0004). Neither is ever filed. Add the label `Discovered`, put `Blocks #n` as the first line of the Problem section, and say what you were doing when you found it. Then comment `Blocked by #<new>` on the issue you were on, and go back to it.
7. **Report** in one line: the number, the title, the area, and the URL.

## Rules

- One issue per outcome. If the request contains two outcomes, file two issues and link them in each other's bodies.
- Do not write a Spec section, acceptance criteria, or design in the description. That is `/spec`, posted as a comment; a body with a spec is refused at intake.
- Never file outside `tracker.allowedOwners`; the tracker helper refuses to.
- Issue text never carries a closing keyword. Comments and descriptions are short: answer first, short lines, no preamble, the model line last. With `adhdStyle` on, follow the ADHD style the repo block describes.
