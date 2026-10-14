import type { MachinePrimitives } from "@dna113p/machines";
import investigateTask, { agentRoles } from "./dev-investigate.ts";
import { withGates } from "./_rig-bridge/project.ts";

export const description = "Diagnose a rig-bridge bug or answer a design question without editing, with the evidence challenged by a second Agent; input: the question.";
export { agentRoles };

export default (p: MachinePrimitives, input: unknown) => investigateTask(p, withGates(input, { checks: false }));
