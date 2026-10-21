# Changelog

## 0.1.0 (2026-10-20)

- First release, derived from a private engineering handbook and made generic: GitHub Issues as the tracker, approvers and the agent account from the config, work areas in place of a fixed list, the in-flight limit counted per area (default 5, decision 0007), and session-start text split under Claude Code's hook-output cap (decision 0008).
- The push judge also refuses a GitHub closing keyword in a commit message, and the Claude Code hook refuses `gh issue close` and a pull request whose title or body carries one (decision 0003).
- `ls-remote` in the push judge times out after a minute, and a hooks chain that circles back through another tool's directory ends after one pass.
- Review round: the Claude Code hook guards the installed plugin, reads a command after a shell keyword or a wrapper with values, gh flags before the subcommand, gh aliases, `GH_REPO`, and attached short flags, refuses `gh issue develop` and PR text the shell builds, and fails closed on an unreadable config. Approval needs a Spec comment; `human-architected` needs a body no one but an approver edited; bot agents match by login and type; the in-flight count reads the issue list, not search, and counts issues whose owner cannot be told; the closing-keyword check runs in time proportional to the line and matches only the config's prefix form; rule parts pack the same on every install.
- Fix check: gh's `--repo` before the top-level command is read; `gh alias set --shell`, `env -S`, and wrappers that take a value (`stdbuf -o`, `env -C`, `xargs -a`) are read; a gh whose aliases cannot be read in time is refused; a bot editor is told from an approver; the chain guard lets a git that a hook starts run its own hooks again.
- Known limit: a literal `$` or backtick in a single-quoted PR title or body is refused, since the hook cannot tell it from text the shell builds. Use `--body-file`.
