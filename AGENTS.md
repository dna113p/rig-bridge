# rig-bridge agent guidance

Run `npm run check` before calling a change done. The live `rig-bridge.service`
runs from this checkout's `src/`; do not restart it or bind port 8767 from here.

## Delegating work through Machines

When coordinating rig-bridge work, read [.machines/README.md](.machines/README.md)
before delegating. It maps each kind of work to a Machine (`verify`, `ticket`,
`review`, `investigate`), its input, and its gates. Use the `machine-delegation`
skill to launch and supervise a run, and `machine-project-setup` only when no
route fits. Edits to rig-bridge go through `ticket`, which works in its own
worktree. A worker already running inside a Machine state does its assignment
directly.

## Reporting through Drip

Drip is the owner's inbox. Its one job is to get them back into context fast.
This checkout is registered as project `Rig Bridge`.

- For work that may outlast the owner's attention, open a thread with
  `drip_open`, with their ask in their own words.
- Keep one recap current with `drip_recap`. Its `now` line is one sentence
  with the verdict and the state ("The export is fixed: one index, two fast
  nights"), because that line is what the owner reads in the list.
- Before any question or hand-off, send a page: breadcrumb (project, ticket,
  file or component), a diagram or table of the change, the evidence that
  matters, and the decision at the end. Attach it to the recap or to the
  question. A page on a plain `drip_say` sits behind "Open the conversation".
- Ask with `drip_ask` only when the work cannot continue, and offer choices
  with what each one does.
