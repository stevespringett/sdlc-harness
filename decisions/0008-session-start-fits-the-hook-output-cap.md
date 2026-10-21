# 0008: Session-start text is split to fit Claude Code's hook-output cap

**Status:** Accepted
**Date:** 2026-10-20

## Context

Claude Code keeps each hook command's stdout whole only up to 10,000 characters. A longer output is saved to a file, and the session sees a 2,000-character preview. The cap is per command, not per session. The rules alone are about 20,000 characters, so a single session-start output would show a session only the first screen of its rules, and every rule past it would silently stop applying.

## Decision

1. **Split the text across several SessionStart commands**, each printing one part under 9,500 characters: up to four parts of `RULES.md` (whole `##` sections, packed in order, with one spare part), `PRINCIPLES.md`, and the repo's facts with the watch text. A part past the last prints nothing.
2. **Each part names itself** ("SDLC rules, part 2 of 3") and reads correctly in any order, since Claude Code may run the commands in parallel.
3. **A test pins it.** `session-start.test.mjs` runs every SessionStart command in `hooks.json` for startup, resume, clear, and compact, with a heavy config, and fails when any output passes 9,500 characters, when `RULES.md` needs more parts than `hooks.json` declares, or when any section stops arriving word for word.
4. **A test command too long to show** is printed by reference, so the rest of the repo text still arrives whole.

## Consequences

- Positive: every session sees every rule, and growth fails a test before it fails a session.
- Negative: adding a fifth rules part means a `hooks.json` change and a `RULE_PARTS` bump, in the same commit.
- Neutral: a change to Claude Code's cap shows up as a preview again; the test pins today's number.
