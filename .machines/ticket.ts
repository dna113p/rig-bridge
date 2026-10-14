import type { MachinePrimitives } from "@dna113p/machines";
import ticketTask, { agentRoles } from "./_machine-shop/ticket-task.ts";
import { ticketInput } from "./_rig-bridge/project.ts";

export const description = "Carry one rig-bridge ticket from its own worktree through falsify, plan, failing tests, implementation, gates, and cross-provider review to a local branch; input: a ticket .md path or {ticket|ticketFile, output?, stuck?, ...}.";
export { agentRoles };

export default (p: MachinePrimitives, input: unknown) => ticketTask(p, ticketInput(input));
