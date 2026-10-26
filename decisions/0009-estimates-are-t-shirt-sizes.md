# 0009: Estimates are t-shirt sizes, never units of time

**Status:** Accepted; amends [0001](0001-github-issues-first-trunk-based-sdlc.md) rule 7
**Date:** 2026-10-26

## Context

The Spec defined size as S (hours), M (a day), L (days), and the ADR trigger said "costs more than a day to reverse". Those are human working-time units. The agent does most of the execution, so its hours and days are not a person's, and a number in days reads as a commitment to a date. Two sizes with the same scope could also differ only because someone guessed a different duration.

## Decision

1. **Size is S, M, or L, judged by scope and risk.** S: one file or one function, an obvious approach, no open question. M: several files in one subsystem, a known approach. L: more than one subsystem, a schema or data migration, a new pattern, or a real unknown.
2. **No estimate is stated in units of time**: not minutes, hours, days, weeks, sprints, or any other. This applies to Specs, plans, comments, commits, and replies to a person. Asked "how long", the agent answers with the size and what drives it.
3. **The ADR trigger is restated in size**: a decision that constrains more than one future feature and would take size L work to reverse.
4. **Process steps carry no timings either**: setup steps, stage headings, and skill steps say what they do, not how long they take.
5. The gates that read size (`agent-needs-go` for L, the design review for M and up) keep their meaning.

## Consequences

- Positive: a size is checkable against the Touches line of the Spec, so two readers reach the same size.
- Positive: no comment from the agent reads as a delivery date.
- Negative: people who plan by calendar must translate sizes themselves, from their own history.
- Neutral: time limits that are not estimates stay as they are: the watch interval, lock and loop expiry, and the hot-spot window of a week.
