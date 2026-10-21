# 0006: Build principles are company-wide; a repo narrows one, never contradicts it

**Status:** Accepted
**Date:** 2026-10-20

## Context

An SDLC says how we work, not how we build. When each repo's `CLAUDE.md` sets its own design rules, they drift: how many callers an abstraction waits for, whether a single-implementation interface is allowed at a boundary, whether guard tests may read source, which accessibility standard applies.

## Decision

1. **One set of build principles for every repo on the SDLC**: design, SOLID, correctness, architecture, security, UX, and testing. They live in the plugin's `PRINCIPLES.md`, one line each. A client edits that file once for all their repos.
2. **Every session sees them.** The plugin prints them at session start in any repo with `.sdlc-harness/sdlc.json`, as an output of their own, so no other text can push them past Claude Code's hook-output cap (0008).
3. **A repo narrows, never contradicts.** A repo's `CLAUDE.md` may narrow a principle with a named exception and its reason (for example, a guard test it names). A rule that contradicts a principle without naming it as an exception is a defect in that `CLAUDE.md`.
4. **The SDLC wins where it speaks.** Delivery (trunk, small changes, the gates) stays in `RULES.md`; the principles point to it.

## Consequences

- Positive: one place to change how code is built, and a spec or review can cite one file.
- Positive: a repo's exceptions are visible, each with its reason.
- Negative: every session pays for the text, about 1.2k tokens.
- Negative: sub-agents do not see session-start text, so a brief that designs, builds, or reviews code names the file.
