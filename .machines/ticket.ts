import type { MachinePrimitives } from "@dna113p/machines";
import ticketTask, { agentRoles } from "./_machine-shop/ticket-task.ts";
import { ticketInput } from "./_rig-bridge/project.ts";

export const description = "Carry one rig-bridge ticket from its own worktree to a local branch: one implementer decides and reports what is reversible, layered gates, one advisory cross-provider review; level careful restores falsify, plan and failing tests first; input: a ticket .md path or {ticket|ticketFile, level?, output?, ...}.";
export { agentRoles };
export { endings } from "./_machine-shop/ticket-task.ts";

export default (p: MachinePrimitives, input: unknown) => ticketTask(p, ticketInput(input));
