import type { MachinePrimitives } from "@dna113p/machines";
import reviewCode, { agentRoles } from "./dev-review-code.ts";
import { withGates } from "./_rig-bridge/project.ts";

export const description = "Review rig-bridge code or a diff without editing and return evidence-backed findings; input: what to review, or a Machine Shop assignment naming another workspace.";
export { agentRoles };

export default (p: MachinePrimitives, input: unknown) => reviewCode(p, withGates(input, { checks: false }));
