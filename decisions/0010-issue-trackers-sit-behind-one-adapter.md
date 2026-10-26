# 0010: Issue trackers sit behind one adapter

**Status:** Accepted; rule 2 refined for Linear by [0011](0011-linear-through-its-mcp-connector.md)
**Date:** 2026-10-26

## Context

The harness reads and writes GitHub Issues in two ways: `hooks/tracker.mjs` for reads and status, and `gh issue` commands written straight into the skills for comments, labels, assignees, titles, and new issues. Teams also keep their work in Linear and Jira. Each has its own ids (`ENG-123` per Linear team, `PROJ-123` per Jira project), people, statuses, and ways to close an issue from a commit. With `gh` in the skills, every tracker would need its own copy of every skill.

## Decision

1. **One adapter per tracker**, chosen by `tracker.kind` in the config. `github` is the default; an unknown kind is a config problem and the tracker helper refuses to run.
2. **Every tracker read and write goes through `tracker.mjs`**: reads, status, comments, labels, assignees, titles, new issues, duplicate search, and area labels. The skills name only tracker commands, so they stay the same for every kind. Pull requests stay with `gh`: they belong to the code host, not the tracker.
3. **The adapter owns the issue id.** The CLI takes the id as people write it (`12`, `#12`, `GH-12`, later `ENG-123`), and the adapter parses it.
4. **The helper enforces what the hook enforces.** The Claude Code hook never sees the calls the helper makes, so no tracker command closes, reopens, deletes, or transfers an issue, and none writes outside the tracker.
5. The Claude Code hook's refusals stay as they are, as a second line.

## Consequences

- Positive: a Linear or Jira adapter is one file and its tests; no skill changes.
- Positive: every write the agent makes to the tracker passes one set of checks.
- Negative: each adapter must keep the refusals of decision 0003 for its own tracker, including its ways to close an issue from a commit (Linear's magic words, Jira Smart Commits).
- Neutral: the GitHub behavior is unchanged.
