# Changelog

## 0.1.0 (2026-10-20)

- First release, derived from a private engineering handbook and made generic: GitHub Issues as the tracker, approvers and the agent account from the config, work areas in place of a fixed list, the in-flight limit counted per area (default 5, decision 0007), and session-start text split under Claude Code's hook-output cap (decision 0008).
- The push judge also refuses a GitHub closing keyword in a commit message, and the Claude Code hook refuses `gh issue close` and a pull request whose title or body carries one (decision 0003).
- `ls-remote` in the push judge times out after a minute, and a hooks chain that circles back through another tool's directory ends after one pass.
