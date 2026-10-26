# Changelog

## Unreleased

- Licensed under Apache-2.0: a `LICENSE` file, and the license field in `plugin.json` and `package.json`. The README and the decisions index speak to a team adopting the harness, not a client, and drop the setup time estimate.
- `scripts/release.mjs` cuts a release: it writes the version into `package.json`, `plugin.json`, and both `marketplace.json` fields, dates this section, commits, and tags. A test fails when the fields disagree or a Markdown file names a version; changelog sections are dated, and the tag names the version. Pushing the tag runs `.github/workflows/release.yml`, which checks the versions, runs the tests, and publishes the GitHub Release.
- `.github/workflows/test.yml` runs the repo's `testCommand` on Ubuntu and macOS, Node 20, 22, and 24.
- The marketplace owner is the maintainer, Steve Springett.
- Estimates are t-shirt sizes (S, M, L) judged by scope and risk, never stated in units of time (decision 0009). The Spec's size line drops "hours / a day / days", `RULES.md` gains a Sizing section, and the ADR trigger reads "would take size L work to reverse". The setup steps, stage headings, and skill steps drop their "~N min" and "~N s" timings.

## 2026-10-20

- First release, derived from a private engineering handbook and made generic: GitHub Issues as the tracker, approvers and the agent account from the config, work areas in place of a fixed list, the in-flight limit counted per area (default 5, decision 0007), and session-start text split under Claude Code's hook-output cap (decision 0008).
- The push judge also refuses a GitHub closing keyword in a commit message, and the Claude Code hook refuses `gh issue close` and a pull request whose title or body carries one (decision 0003).
- `ls-remote` in the push judge times out after a minute, and a hooks chain that circles back through another tool's directory ends after one pass.
- Review round: the Claude Code hook guards the installed plugin, reads a command after a shell keyword or a wrapper with values, gh flags before the subcommand, gh aliases, `GH_REPO`, and attached short flags, refuses `gh issue develop` and PR text the shell builds, and fails closed on an unreadable config. Approval needs a Spec comment; `human-architected` needs a body no one but an approver edited; bot agents match by login and type; the in-flight count reads the issue list, not search, and counts issues whose owner cannot be told; the closing-keyword check runs in time proportional to the line and matches only the config's prefix form; rule parts pack the same on every install.
- Fix check: gh's `--repo` before the top-level command is read; `gh alias set --shell`, `env -S`, and wrappers that take a value (`stdbuf -o`, `env -C`, `xargs -a`) are read; a gh whose aliases cannot be read in time is refused; a bot editor is told from an approver; the chain guard lets a git that a hook starts run its own hooks again.
- Known limit: a literal `$` or backtick in a single-quoted PR title or body is refused, since the hook cannot tell it from text the shell builds. Use `--body-file`.
