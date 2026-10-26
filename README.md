# SDLC harness

How a team works with Claude Code, in a form Claude Code can execute: a plugin with four skills (`/ticket`, `/spec`, `/build`, `/ship`), the hooks that enforce the gates, and the handbook that explains them. GitHub Issues is the tracker. No dependencies beyond Node 20+, git, and the `gh` CLI.

| You want | Read |
|---|---|
| The process, with diagrams | [SDLC.md](SDLC.md) |
| The rules every session follows | [RULES.md](plugins/sdlc-harness/RULES.md), injected by the plugin at session start |
| The build principles every repo follows | [PRINCIPLES.md](plugins/sdlc-harness/PRINCIPLES.md), injected beside the rules |
| Why it works this way | [decisions/](decisions/) |
| What a repo declares about itself | [schema/sdlc.schema.json](schema/sdlc.schema.json) |
| The skills and hooks | [plugins/sdlc-harness/](plugins/sdlc-harness/) |

Setting up a new client takes about 30 minutes, in six steps.

## 1. Accounts

The harness tells people apart by GitHub account, so set these up first.

1. **Approvers.** The people who approve issues for work and accept them. They use their own GitHub accounts.
2. **The agent account.** A separate GitHub account (a machine user, such as `acme-agent`) that Claude Code writes through. Give it write access to the code repos and triage access (at least) to the tracker repo. It must never be an approver's account: then its comments would read as approvals, and the harness refuses to approve anything.
3. **Log `gh` in as the agent** on every machine that runs Claude Code: `gh auth login`, then check it:

   ```bash
   gh api user --jq .login
   ```

4. **Look up each account's numeric id** for the config. A login can be renamed and taken by someone else; the id cannot.

   ```bash
   gh api users/octocat --jq .id
   ```

## 2. Install the plugin

Host this repo where the client's machines can read it (a private repo in the client's GitHub org is usual), then add it as a marketplace and install the plugin:

```bash
claude plugin marketplace add your-org/sdlc-harness
```

```bash
claude plugin install sdlc-harness@sdlc-harness
```

To try it from a local checkout first, pass the folder path to `claude plugin marketplace add` instead. Restart Claude Code, open a managed repo (step 3), and run `/context`: the `sdlc-harness-rules`, `sdlc-harness-principles`, and `sdlc-harness-repo` blocks should be listed.

So that every machine gets it, each repo can carry a `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "sdlc-harness": { "source": { "source": "github", "repo": "your-org/sdlc-harness" } }
  },
  "enabledPlugins": { "sdlc-harness@sdlc-harness": true }
}
```

Update with `claude plugin update sdlc-harness@sdlc-harness` after the handbook changes.

Claude Code on the web: if a cloud session does not show the rules blocks, commit a copy of `RULES.md` as `.claude/rules/sdlc-rules.md` and of `PRINCIPLES.md` as `.claude/rules/sdlc-principles.md` in that repo as a fallback, and refresh both when the handbook changes. The push judge still installs only where the plugin's hooks run.

## 3. Add the config file to each repo

Copy [schema/sdlc.example.json](schema/sdlc.example.json) to `.sdlc-harness/sdlc.json` in the repo root, fill it in, and commit it. The plugin does nothing in a repo without this file.

| Key | What to put |
|---|---|
| `integration` | `trunk` (push to the default branch, no PRs) or `github-flow` (push a branch, open a PR) |
| `testCommand` | The one command that proves the repo is green, such as `npm test` |
| `protectedPaths` | Prefixes or globs that need an approver's go before a push: migrations, auth, payments, CI and deploy config, dependency manifests |
| `approvers` | `[{ "login": "...", "id": 123 }]`: the only accounts that approve and accept |
| `agent` | `{ "login": "...", "id": 456 }`: the account Claude Code writes through |
| `people` | Other people who file issues; a refused issue goes back to them |
| `tracker.repo` | `owner/name` of the repo whose Issues hold the work. Default: this repo's origin |
| `tracker.allowedOwners` | Orgs or users the agent may file issues and PRs in. Default: the tracker's owner |
| `tracker.states` | `labels` (default) or `project` (see step 4) |
| `area` | The work area this repo's watch owns, such as `web` |
| `areas`, `defaultArea` | Every area in the tracker; the one that owns an issue with no area |
| `inFlightLimit` | Builds at once per area. Default 5 |
| `checkouts` | `{ "your-org/api": "../api" }`: where another repo's checkout is, for cross-repo issues |
| `issuePrefix` | How commits name an issue. Default `GH`, so `GH-12`, which GitHub links to issue 12 |
| `modelLine`, `adhdStyle`, `subagentModel`, `policyStart`, `watch`, `watchInterval` | Optional; see the schema |

A single-repo client sets `area` and `defaultArea` to the same name and leaves `tracker.repo` out. A multi-repo client points every repo at one tracker repo and gives each its own `area`.

The first Claude Code session in the repo installs git's pre-push judge (decision 0005). From then on, a push needs a green record from `verify.mjs` for the exact tree it sends.

## 4. Create the labels

From inside a repo that has the config, with `gh` logged in as someone who can manage labels in the tracker repo:

```bash
node ~/Development/sdlc-harness/plugins/sdlc-harness/hooks/setup-labels.mjs --dry-run
```

```bash
node ~/Development/sdlc-harness/plugins/sdlc-harness/hooks/setup-labels.mjs
```

(Use the path to your checkout, or the installed copy under `~/.claude/plugins/`.) It creates or updates, never deletes:

- `agent-fully-autonomous`, `agent-needs-go`, `human-only`
- `Feature`, `Improvement`, `Defect`, `Discovered`, `human-architected`
- `status:not-started`, `status:in-progress`, `status:in-review` (labels mode only)
- `area:<name>` for each area in the config

**Status on a board instead (optional).** Set `tracker.states` to `project` and `tracker.project` to `{ "owner": "your-org", "number": 3 }`. The board needs a single-select field named `Status` with the options Backlog, Not Started, In Progress, In Review, and Done (or set `field` and `options` to match yours). The agent account needs write access to the board. Done still means an approver closed the issue.

**Recommended:** turn on branch protection with required status checks on the default branch. The pre-push judge stops mistakes; only the server stops a determined bypass.

## 5. Use the four skills

| Skill | What it does | Then a person |
|---|---|---|
| `/ticket <idea>` | Files an issue in the Intent shape (Problem, Outcome, Constraints), with a kind and an area label | Nothing, or edits the issue |
| `/spec GH-n` | Runs the intake checks, reads the code, posts a `## Spec` comment (acceptance criteria, touches, size, autonomy label), asks at most three questions | Answers, then an approver comments a line that is just `approved` |
| `/build GH-n` | Checks the approval and the area's in-flight limit, posts a plan, sets In Progress, builds in a worktree with a failing test first for defects | For `agent-needs-go`: an approver comments `go` on the plan |
| `/ship GH-n` | Verifies, gets one review from a fresh session, fixes in one round, pushes (or opens a PR), sets In Review, posts the closing comment | An approver closes the issue as completed, or replies with what is missing |

The approval, the go, and the acceptance count only from an approver's own account. The agent never closes an issue, and never writes `Fixes #n`, `Closes #n`, or `Resolves #n`: the push judge refuses such a commit, and the Claude Code hook refuses `gh issue close` and such a PR.

**The watch.** In a repo with `watch` on and an `area`, the first interactive session claims a lock and runs `/loop 15m`. Each tick reads the agent account's GitHub notifications and acts on the ones its area owns: it starts a build when an approval arrives, resumes one when a go arrives, folds answers into specs, and specs the oldest unlabeled issue. One watcher per repo; a second session is told who holds it.

## 6. Change the process

Edit `SDLC.md`, `RULES.md`, or `PRINCIPLES.md`, or add a decision under `decisions/`. Bump the version in `plugins/sdlc-harness/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (both entries), run the tests, and push. Machines pick it up on their next `claude plugin update`.

```bash
npm test
```

The tests (`node --test`, no dependencies) cover the push judge, the install, the deny-list, the policy (intake, approval, ownership, in-flight), the GitHub helper against a fake `gh`, the watch lock, and the session-start output size.

## Removing it

A person at a keyboard (the Claude Code hook refuses it) runs this inside a managed repo to put the hooks paths back as they were:

```bash
node ~/Development/sdlc-harness/plugins/sdlc-harness/hooks/uninstall-hooks.mjs
```

**Another tool that sets the global `core.hooksPath`.** The judge installs itself in front of whatever hooks path was there before and chains to it. If another tool does the same and records this one as its previous path, the chain would circle; the harness ends such a chain after one pass. Prefer one such tool per machine.
