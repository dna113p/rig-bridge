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
