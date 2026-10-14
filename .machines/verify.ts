import type { MachinePrimitives } from "@dna113p/machines";
import verifyChecks from "./dev-verify-checks.ts";
import { definingCheckout, gates } from "./_rig-bridge/project.ts";

export const description = "Run the rig-bridge gates from project.json without a model and save logs and a receipt; input: gate names, or empty for all.";

export default function verify(p: MachinePrimitives, input: unknown) {
  const names = typeof input === "string" ? input.trim().split(/\s+/u).filter(Boolean) : [];
  return verifyChecks(p, { task: "Run the rig-bridge gates", workspace: definingCheckout, checks: gates(names) });
}
