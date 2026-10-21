# 0001: GitHub Issues-first, trunk-based SDLC with labeled autonomy

**Status:** Accepted; approval and acceptance detailed by [0003](0003-approvers-approve-and-accept.md), enforcement placed by [0005](0005-git-judges-the-push.md), how a repo is built narrowed by [0006](0006-build-principles-are-company-wide.md)
**Date:** 2026-10-20

## Context

A small team with an AI agent doing most of the execution needs one place that says what is being built, one place that says how, and a rule for when the agent may act alone. Pull requests are a human ceremony that adds little when no second engineer reads the code, and hosted CI minutes are limited.

## Decision

1. **GitHub Issues in one tracker repo is the source of truth** for what, why, and status. The handbook is the truth for how we work. Each repo is the truth for how it is built. No issues or PRs outside the configured owners.
2. **Five stages, one GitHub artifact each**: Capture (the issue), Spec (a `## Spec` comment by the agent), Build (a plan comment), Ship (a closing comment), Learn (a `CLAUDE.md` line). Status is kept in labels by default, or in a Projects (v2) field: Backlog is an open issue with no status label; In Progress and In Review are labels; Done is an approver closing the issue.
3. **Three autonomy labels**: `agent-fully-autonomous`, `agent-needs-go` (Feature, size L, or a protected path; an approver's go before the push), `human-only` (never built by the agent).
4. **Trunk-based by default**, switchable per repo through `.sdlc-harness/sdlc.json`. The four jobs a PR did (reviewer not author, green main, the go gate, evidence) are done by a fresh review session, a green record checked by git's pre-push hook, its protected-path rule, and the closing comment.
5. **One configurable model** for the session and every sub-agent; every body the agent writes ends with a line naming the model and version that wrote it (configurable).
6. **The agent writes through its own GitHub account**, so the author field says who wrote what. The Spec is a comment, never an edit of the author's description.
7. **ADRs stay, narrowed**: only decisions that constrain more than one future feature and cost over a day to reverse, 400 words, proposed on the issue first.

## Consequences

- Positive: people need only GitHub Issues. The agent follows one process in every repo. CI cost stays inside the plan.
- Positive: every gate is deterministic and local. Nothing waits on a person unless a label says so.
- Negative: parallel sessions integrating to trunk can land half-finished work; the rule is small commits behind a flag when work spans sessions.
- Negative: labels and status can be changed by anyone with triage access, so neither ever counts as approval (0003).
- Neutral: the rules reach a session through the plugin's SessionStart hook, not a `CLAUDE.md` import, so they travel with the plugin to every machine.
