# rig-bridge Machines

Routing map for delegated rig-bridge work. It is documentation, not a runtime
registry. The coordinating agent reads it before delegating, using the
`machine-delegation` skill; workers already inside a Machine state do their
assignment directly. Use `machine-project-setup` only when a route is missing.

Launch directory for every route: this checkout's root. This catalog hides any
ancestor `.machines/`; `~/.machines/smoke` is a user catalog entry and still lists.

**The live bridge runs from this checkout.** `rig-bridge.service` executes
`src/cli.ts` from here, and its restarts pick up whatever is on disk. Editing
work therefore goes through `ticket`, which works in its own worktree under
`../rig-bridge-worktrees/` and never writes to this checkout. Restarting the
service after a merge is the owner's call; no route does it.

## Routes

| Work | Machine | Input | Where it works | Agent calls |
| --- | --- | --- | --- | --- |
| Run the gates, no model | `verify` | gate names, or empty for all | this checkout, read-only | 0 |
| Feature, bug fix, refactor, dependency upgrade | `ticket` | a ticket `.md` path, or a request object | a new worktree and `ticket/<id>-<title>` branch | 4–16 |
| Review code or a diff | `review` | what to review and its scope | this checkout (or `workspace`), left unchanged | 1 |
| Diagnosis or design question | `investigate` | the question | this checkout (or `workspace`), left unchanged | 2, up to 4 |

```sh
machine run verify                       # lint, types, tests, smoke, tunnel
machine run verify types tests
machine run ticket path/to/RB-12.md      # unattended; parks when stuck
machine run ticket --input-file request.json
machine run review "Review the uncommitted changes in src/work.ts for handoff regressions"
machine run investigate "Why can a handoff arrive before the queued bash receipt is dispatched?"
```

### ticket

Machine Shop's `ticket-task`, copied to `_machine-shop/ticket-task.ts`:
worktree and `npm ci --ignore-scripts` → **falsify** (a read-only Agent tries to show the
ticket is wrong, done, or underspecified; questions need options and a recommended
answer) → plan → plan review → tester writes failing tests → **scope check** →
**red proven** with the `tests` gate → implementer → **scope check** → **every
gate** → structured cross-provider review (criteria met/unmet, findings by
severity), judged by an Operation → one commit → re-verify on the current base
→ deliver. Repairs (default 3) and review rounds (default 2) have separate
budgets. A stuck run **parks**: it ends with the worktree kept and a note of
what a person must decide. A run never asks a Human unless the request sets
`"stuck": "ask"`.

A ticket file is `<id>.md`; its first `# ` heading is the title and the body
needs these four sections (each list at least one bullet):

```markdown
# Show handoff age in the CLI monitor

## Goal
`npm run status` shows how long ago each unread handoff arrived.
## Scope
- src/cli.ts
- src/ui.ts
- tests/status.test.ts
## Acceptance
- The monitor prints a relative age such as "3m ago" beside each unread handoff
- Read handoffs show no age
## Forbidden
- No change to the /api/status JSON shape
```

The wrapper appends rig-bridge's project-wide Forbidden rules from
[project.json](project.json): no touching the live services, port 8767,
`~/.local/state/rig-bridge`, `.env`, or credentials. Scope is enforced
mechanically, so name every path the change needs, including tests, and
`package.json`, `package-lock.json` for a dependency change.

Request object (all but one of `ticket`/`ticketFile` optional):

```json
{
  "ticket": { "id": "RB-12", "title": "Show handoff age", "body": "## Goal\n..." },
  "output": "branch",
  "maxRepairs": 3,
  "maxReviewRounds": 2,
  "stuck": "park",
  "assume": false,
  "resume": false
}
```

`output` is `branch` (default: commit on a local branch, nothing leaves this
computer), `patch` (also writes `git format-patch` output into the evidence
directory), or `pr` (**pushes** the branch to `origin` and opens a draft PR with
`gh`; choose it only when the owner asked for a PR). `assume: true` lets
falsify accept its own recommended answers for gaps it marks assumable. After a
park, fix the ticket or the worktree and rerun with `"resume": true`.

The route does not merge, delete the branch, or remove the worktree after
delivery. Review and merge `ticket/*` branches, then
`git worktree remove ../rig-bridge-worktrees/rig-bridge--<id>`.

Concurrent tickets get separate worktrees and branches, so they do not
overwrite each other; tickets whose Scopes overlap will conflict at merge.

Results: the final state is `delivered`, `parked`, `blocked`, `handedOff`, or
`abandoned`. Only `delivered` is a finished assignment. Evidence (`result.json`,
check logs, stage reports, `delivery.json`) is under
`../rig-bridge-worktrees/.machine-runs/machine-shop/<run-id>/`.

### verify, review, investigate

Thin wrappers over the copied Machine Shop defaults (`dev-*.ts`). They fill the
workspace with this checkout and, for `verify`, the gates. `review` and
`investigate` take task text or a Machine Shop assignment object, and an
assignment may set `workspace` to a ticket worktree to review a candidate. Both
block when the checkout changes during the run. Results go to the ignored
`.machine-runs/machine-shop/<run-id>/result.json` of the workspace; `verify`
exits nonzero on a failed gate.

## Gates

One list, `checks` in [project.json](project.json); `verify` and `ticket` read
it, and a ticket's red phase runs the `tests` gate. Every gate runs even after
one fails. Measured 2026-10-14 on this checkout; each leaves the checkout clean.
`npm run check` runs the same list except `tunnel`.

| Class | Gate | Command | Time |
| --- | --- | --- | --- |
| Lint | `lint` | `npm run lint` (oxlint 1.87.0, warnings fail; config in `.oxlintrc.json`) | under 1 s |
| Types | `types` | `npm run typecheck` | 4 s |
| Tests | `tests` | `npm test` (real stdio and HTTP servers, Pi tools) | 13 s |
| Live check | `smoke` | `npm run smoke:serve` (starts `cli.ts serve` on a free port with temporary state, checks the bearer file, health, dashboard, status, MCP auth, one tool call, SIGTERM) | 1.5 s |
| Live check | `tunnel` | `npm run test:tunnel` (two clients through a real `tunnel-client` 0.0.14 dev proxy) | 3 s |
| Build | none | runs TypeScript directly under Node 24 | – |

The test gates run through `env -u NODE_TEST_CONTEXT`. A Machine started from
inside `node --test` otherwise passes that variable on, and the nested
`node --test` then exits 0 even when tests fail.

The `tunnel` gate needs `tunnel-client` on `PATH` (`~/.local/bin`); it is not
part of `npm run check`. `.machines/_machine-shop/` is copied upstream code and
is excluded from lint.

## Agent bindings

Presets live in [agents.ts](agents.ts); change models there, not in workflows.
Each runs an installed CLI with its existing login and spends that plan.

| Role | Preset | Harness, model, effort | Edits | Fallback |
| --- | --- | --- | --- | --- |
| implementer, tester | `implementer`, `tester` | Claude Code, Opus, high | yes; `acceptEdits` and Bash, in the ticket worktree | `implementer-sol` |
| reviewer | `reviewer` | Codex, GPT-6.1 Sol, high | no; Codex read-only sandbox | `reviewer-opus` |
| investigator | `investigator` | Claude Code, Opus, high | no editing tools; Bash allowed | `sol-review`, `claude-review` |

Mirrored pairing for one run: `--agent implementer=implementer-sol --agent reviewer=reviewer-opus`.

Why: the author and the reviewer come from different providers. The evidence
is a research prior only:
`machine-wars/docs/research/machine-wars-research-priors-2026-10-09.json` (web
research, no local trials, marked ineligible for automatic routing). It rates
Opus 5.5 and GPT-6.1 Sol within 0.5 of each other on backend, terminal, and
debugging work, which it calls a tie. These bindings are a reviewable choice,
not a measurement, and match fballz's setup. No rig-bridge trials exist yet.

Surveyed 2026-10-14: `claude` 2.1.296 (signed in), `codex` 0.162.1 (signed in
with ChatGPT), `agy` 1.3.5 and `pi` (installed, unrated). `dsh` is not
installed, so `deepseek` cannot run. `chatgpt-web` drives ChatGPT through this
very bridge; do not bind it to a role that edits rig-bridge, since a ticket
could break the bridge that the Agent depends on. The `jev`, `laya`, `von`, and
`openrouter-decision` classifiers have no role here.

An allowed Bash can still write files from a read-only Claude preset. The
unchanged-checkout guards in `review`, `investigate`, and the ticket's
planning states detect that after the fact and block the run.

## Verification

```sh
node --test .machines/_rig-bridge/routes.test.ts   # about 2 min
```

These tests use the sibling Machines runtime (`../machines/src`, or set
`MACHINES_RUNTIME`). With fake Agents, they run the real graph in a disposable
local clone, including real `npm ci` and real gates. They cover: a ticket
delivered to its branch after red, green, and review; a failing gate that parks
with nothing committed; an out-of-scope edit that parks before the gates; falsify
questions that park before any edit; and `review` blocking when its reviewer
edits. They also cover input mapping and gate refusal. `verify` has run live
and passed. No route has yet run a real Agent, so the Agent bindings are bound
and fixture-tested only.

## Deliberately direct

- Service lifecycle (`install:service`, `install:tunnel-service`, systemd
  restarts) and tunnel credentials: outward-facing, owner-run.
- Releases and pushes: there is no release process yet. `ticket` with
  `output: "pr"` is the only route that pushes.
- Small edits, single commands, and questions answered by reading one file.

## Maintenance

Copied from `machine-shop` at `2d943d6` (2026-10-13): `dev-verify-checks.ts`,
`dev-review-code.ts`, and `dev-investigate.ts` through its installer;
`_machine-shop/task.ts`, `brief.ts`, and `scope.ts`; and `_machine-shop/ticket-task.ts` by
hand, with its helper imports rewritten from `./defaults/_machine-shop/` to
`./`. Reinstalling the same defaults is a no-op. The installer refuses to
overwrite a customized copy, so compare by hand before upgrading. Keep
`.machine-runs/` out of Git.
