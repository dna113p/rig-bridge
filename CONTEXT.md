# Rig Bridge

Rig Bridge connects a calling assistant to one owner's computer and makes its project activity and handoffs visible.

## Language

**Workspace**:
A persistent project home containing related checkouts and threads.
_Avoid_: Session, conversation

**Thread**:
A continuing line of conversation or work within a workspace, attached to a particular checkout.
_Avoid_: Workspace, HTTP session

**Run**:
One stretch of assistant work within a thread, ending when the assistant hands control back to the user.
_Avoid_: Command, thread

**Handoff**:
The assistant's explicit report that it is returning control to the user, with an outcome and summary. It can mean completed work, a request for input, or work that cannot proceed.
_Avoid_: Inactivity, command completion

**Checkout**:
The working directory used by a thread, including an ordinary directory or a Git worktree.

**Execution handle**:
A temporary routing identity for a thread's tool calls, with its own cancellation and mutation retry scope. The compatibility API calls this a `workspace_id`.

**Transport session**:
An MCP connection lifecycle independent of project workspaces, threads, and execution handles.
