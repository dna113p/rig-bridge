# rig-bridge agent guidance

Outside a Machine run, run `npm run check` before calling a change done. Inside
one, run the focused tests for what you changed; the workflow runs the rest of
the gates. The live `rig-bridge.service` runs from this checkout's `src/`; do
not restart it or bind port 8767 from here.

## Delegating work through Machines

When coordinating rig-bridge work, read [.machines/README.md](.machines/README.md)
before delegating. It maps each kind of work to a Machine (`verify`, `ticket`,
`review`, `investigate`), its input, and its gates. Use the `machine-delegation`
skill to launch and supervise a run, and `machine-project-setup` only when no
route fits. Edits to rig-bridge go through `ticket`, which works in its own
worktree. A worker already running inside a Machine state does its assignment
directly.

The conversation that understands a piece of work should do it. Handing work to
a fresh Agent loses what the conversation knows, so delegate when that context
is not needed: a separate change that can run in parallel, a review that needs
clean eyes, or work that waits for later as a ticket. Changes whose decisions
depend on each other stay in one conversation or ticket.

Write a ticket as the problem and its fences, not the design: `## Goal` (who
needs what, and why), `## Acceptance` as observable results, `## Forbidden`
paths and irreversible decisions, and `## Scope` as a hint of the likely paths.
Leave implementation choices, wording and test lists to the implementer, which
reports them as assumptions. A `ticket` run decides everything a revert can
undo and asks only about what it cannot.

## Drip project

This checkout is registered as project `Rig Bridge`.

<!-- drip:reporting -->
## Reporting through Drip


Use Drip for work that may outlast the person's attention: more than a few
minutes, or started from Drip or a phone. Read the `drip-briefing` skill
before reporting; use `drip_guide` if the skill is unavailable. At the start,
use `drip_projects` to find the registered project holding this folder, then
open a thread with `drip_open`. Keep the person's ask in their own words.
If no project matches, say which folder needs registration and continue.
Keep the thread's recap current with `drip_recap`: on opening, after each
milestone, before each question, and when the work drifts from the ask.
Write its `now` as a sentence about where the work stands, never a name and
state label. Say what changed and what the person needs to do. Ask blocking
questions with `drip_ask`; distinguish restricted choices from suggestions,
and explain each choice's effect and your recommendation. Attach a page to
its recap or question when useful; keep the text able to stand alone.
Read and answer the person's messages returned by the tools. When finished,
close the thread with `drip_close` and a final result. Say "Nothing needed."
once when there is nothing for the person to do.
<!-- /drip:reporting -->
