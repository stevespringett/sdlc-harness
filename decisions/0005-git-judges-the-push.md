# 0005: Git's own pre-push hook judges every push

**Status:** Accepted
**Date:** 2026-10-20

## Context

A Claude Code hook that guesses what a command will push by reading its text runs inside a time limit, after which the command runs anyway, and every fix finds the next hole: a quoted `push`, `send-pack`, `red:main` while HEAD is green, a large diff read as none. Git, by contrast, hands its pre-push hook the exact shas of every ref it sends.

## Decision

1. **Git judges.** `git-pre-push.mjs` is each managed repo's pre-push hook. It refuses a line that:
   - deletes a ref, rewrites history, moves a tag, sends a ref that is not a branch or tag, or opens a branch on a trunk repo;
   - sends a tree with no green record under that tree's `testCommand`;
   - changes a protected path or `.sdlc-harness/` with no recorded go, by the config on the remote (else the push's, the remote's HEAD, the tracking refs, or HEAD; none readable in a managed repo refuses);
   - adds a secret in any commit sent, or in a commit or tag message;
   - carries a GitHub closing keyword in a commit message (0003).
2. **One refusal, a failed read, a remote that does not answer in a minute, or a killed hook stops the whole push.** A mirror push is refused, since git deletes for it without telling the hook.
3. **Install proves itself.** Session start and `verify.mjs` install the judge per repo and globally, chaining to the hooks that ran before, with a guard that ends a chain that circles back. `verify.mjs` records no green until git is proven to run it.
4. **The Claude Code hook is a deny-list.** It refuses what keeps git from running the judge (`--no-verify`, hooks or include config per command, `GIT_CONFIG_*`, aliases, writes to the judge or `.git/config`, `send-pack`), GitHub writes that bypass git, and closing an issue.

## Consequences

- Positive: no command text decides what is checked, and nothing to race.
- Negative: the approvers' own pushes are judged too. `--no-verify` at a keyboard is the way past it, and `hooks/uninstall-hooks.mjs`, run by a person, restores the hooks paths.
- Negative: this stops mistakes, not a determined bypass. Branch protection with required checks is the server-side backstop, and the approvers' call.
- Neutral: the global `core.hooksPath` changes for every repo on the machine; repos the SDLC does not manage pass through to their own hooks.
