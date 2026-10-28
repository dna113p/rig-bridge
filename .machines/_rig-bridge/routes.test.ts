import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { definingCheckout, gates, readTicket, ticketInput, withGates } from "./project.ts";
import { ticketSections } from "../_machine-shop/ticket-task.ts";
import ticketTask from "../_machine-shop/ticket-task.ts";
import reviewRoute from "../review.ts";

// Run from the rig-bridge checkout: node --test .machines/_rig-bridge/routes.test.ts
// The runtime is the sibling Machines checkout unless MACHINES_RUNTIME names another entry point.
const location = process.env.MACHINES_RUNTIME ?? resolve(import.meta.dirname, "../../../machines/src/index.ts");
const runtime: typeof import("@dna113p/machines") = await import(pathToFileURL(location).href);

type Request = { prompt: string; outcomes: readonly string[]; cwd?: string };
type Runner = (request: Request) => any;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("gates come from project.json in order, and an unknown name is refused", () => {
  assert.deepEqual(gates().map(gate => gate.name), ["lint", "types", "tests", "smoke", "tunnel"]);
  assert.deepEqual(gates(["tunnel", "types"]).map(gate => gate.name), ["types", "tunnel"]);
  assert.throws(() => gates(["types", "typo"]), /Unknown gate\(s\): typo/u);
});

test("assignments default to this checkout; editing routes get the gates and read-only routes none", () => {
  const filled = withGates("Add a test");
  assert.equal(filled.task, "Add a test");
  assert.equal(filled.workspace, definingCheckout);
  assert.deepEqual((filled.checks as { name: string }[]).map(gate => gate.name), ["lint", "types", "tests", "smoke", "tunnel"]);
  assert.equal(withGates("Review the diff", { checks: false }).checks, undefined);
  assert.equal(withGates(JSON.stringify({ task: "x", workspace: "/tmp" }), { checks: false }).workspace, "/tmp");
  assert.throws(() => withGates([]), /task text or a Machine Shop assignment/u);
});

test("a ticket request maps onto a worktree outside the checkout with the project's forbidden actions appended", context => {
  const body = "## Goal\nG\n## Scope\n- src/a.ts\n## Acceptance\n- a works\n## Forbidden\n- nothing beyond the scope above";
  const mapped = ticketInput({ ticket: { id: "RB-1", title: "A", body } }) as any;
  assert.equal(mapped.repository.path, definingCheckout);
  assert.equal(mapped.repository.output, "branch");
  assert.deepEqual(mapped.repository.checks.map((gate: { name: string }) => gate.name), ["lint", "types", "tests", "smoke", "tunnel"]);
  assert.equal(mapped.worktreeRoot, resolve(definingCheckout, "..", "rig-bridge-worktrees"));
  assert.equal(mapped.evidenceRoot, mapped.worktreeRoot);
  const sections = ticketSections(mapped.ticket.body);
  assert.deepEqual(sections.missing, []);
  assert.equal(sections.forbidden[0], "nothing beyond the scope above");
  assert.ok(sections.forbidden.some(rule => rule.includes("rig-bridge.service")), sections.forbidden.join("\n"));
  assert.equal(ticketInput({ ticket: { id: "RB-1", title: "A", body }, output: "patch", maxRepairs: 0 }).maxRepairs, 0);

  const directory = mkdtempSync(join(tmpdir(), "rig-bridge-ticket-file-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "RB-7.md"), `# Show uptime\n\n${body}\n`);
  assert.deepEqual(readTicket(join(directory, "RB-7.md")).title, "Show uptime");
  const fromFile = ticketInput("RB-7.md", { cwd: directory }) as any;
  assert.equal(fromFile.ticket.id, "RB-7");
  assert.equal(fromFile.ticket.title, "Show uptime");

  assert.throws(() => ticketInput({}), /exactly one of ticket or ticketFile/u);
  assert.throws(() => ticketInput({ ticket: { id: "x", title: "y", body }, checks: [] }), /Unknown input field: checks/u);
  assert.throws(() => ticketInput("do the thing"), /ticket \.md path or a JSON request/u);
});

test("review runs read-only and fails when the reviewer changes the checkout", async context => {
  const repo = clone(context);
  const run = (reviewer: Runner) => runtime.run(reviewRoute(runtime, { task: "Review src/common.ts", workspace: repo }), { agents: { reviewer } });
  const clean = await run(() => ({ type: "reviewed", summary: "No actionable findings in src/common.ts" }));
  assert.equal(clean.value, "done");
  assert.equal((clean.output as any).outcome, "completed");
  const dirty = await run(request => { writeFileSync(join(request.cwd!, "src/common.ts"), "// changed\n"); return { type: "reviewed", summary: "Edited" }; });
  assert.equal(dirty.value, "blocked");
  assert.equal((dirty.output as any).outcome, "blocked");
});

// The ticket scenarios run the real graph, the real npm setup and the real gates in a disposable clone.
const body = [
  "## Goal", "Add src/fixture-marker.ts exporting marker = \"ready\".",
  "## Scope", "- src/fixture-marker.ts", "- tests/fixture-marker.test.ts",
  "## Acceptance", "- src/fixture-marker.ts exports marker equal to \"ready\"",
  "## Forbidden", "- nothing beyond the scope above",
].join("\n");
const markerTest = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("fixture marker is ready", async () => {\n  const { marker } = await import("../src/fixture-marker.ts");\n  assert.equal(marker, "ready");\n});\n';
const approve = { type: "approved", summary: "Marker matches the ticket", criteria: [{ text: "marker", met: true, evidence: "src/fixture-marker.ts:1" }], findings: [], newSinceLastRound: "none" };
// Only a careful run plans; a trusted run's implementer owns the ticket end to end.
const planning: Record<string, unknown> = {
  falsify: { type: "sound", summary: "The marker module does not exist yet." },
  plan: { type: "planned", summary: "Add src/fixture-marker.ts and tests/fixture-marker.test.ts." },
  planReview: { type: "approved", summary: "Plan is ready." },
};

/** A local clone of this checkout at HEAD with the working tree's hermetic test helper, so its gates pass at the base. */
function clone(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rig-bridge-routes-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "rig-bridge");
  git(root, "clone", "-q", "--local", "--branch", "main", definingCheckout, repo);
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  copyFileSync(join(definingCheckout, "tests/helpers.ts"), join(repo, "tests/helpers.ts"));
  if (git(repo, "status", "--porcelain")) git(repo, "commit", "-qam", "Fixture baseline");
  return repo;
}

/** The owner's side of a stuck run: each question is recorded and answered "hand off". */
function owner() {
  const asked: string[] = [];
  return { asked, answer: (request: { prompt: string }) => { asked.push(request.prompt); return "hand off"; } };
}

async function ticket(context: TestContext, agents: Partial<Record<"tester" | "implementer" | "reviewer" | "falsify", Runner>>, extra = {}, human = owner()) {
  const repo = clone(context);
  const states: string[] = [];
  const called: string[] = [];
  const staged = (role: string) => async (request: Request): Promise<any> => {
    await Promise.resolve(); // the runtime starts a runner before it reports the state
    const state = states.at(-1)!;
    called.push(state);
    if (state === "falsify" && agents.falsify) return agents.falsify(request);
    if (state in planning) return planning[state];
    const runner = agents[role as "tester" | "implementer" | "reviewer"];
    if (!runner) throw new Error(`${role} has no work in ${state}`);
    return runner(request);
  };
  const input = ticketInput({ ticket: { id: "RB-T", title: "Add fixture marker", body }, maxRepairs: 0, ...extra }, { root: repo });
  const result = await runtime.run(ticketTask(runtime, input), {
    agents: Object.fromEntries(["investigator", "tester", "implementer", "reviewer"].map(role => [role, staged(role)])),
    human: human.answer,
    onState: state => states.push(String(state)),
  });
  const runs = join(String((input as any).evidenceRoot), ".machine-runs/machine-shop");
  const [id] = readdirSync(runs);
  const receipt = JSON.parse(readFileSync(join(runs, id!, "result.json"), "utf8"));
  const delivery = existsSync(join(runs, id!, "delivery.json")) ? JSON.parse(readFileSync(join(runs, id!, "delivery.json"), "utf8")) : undefined;
  const branches = git(repo, "branch", "--list", "ticket/*");
  return { repo, state: result.value, states, called, receipt, delivery, asked: human.asked, branches, worktree: join(String((input as any).worktreeRoot), "rig-bridge--rb-t") };
}

/** A trusted implementer writes the module and its test and reports what it decided by itself. */
const implement = (value: string, extra?: (cwd: string) => void): Runner => request => {
  writeFileSync(join(request.cwd!, "src/fixture-marker.ts"), `export const marker = ${JSON.stringify(value)};\n`);
  writeFileSync(join(request.cwd!, "tests/fixture-marker.test.ts"), markerTest);
  extra?.(request.cwd!);
  return { type: "completed", summary: "Added the marker and its test", assumptions: [], scopeAdditions: [], openQuestions: [] };
};

test("a ticket request passes the level, companions and forbidden paths; a careful tag selects careful", () => {
  const mapped = ticketInput({ ticket: { id: "RB-1", title: "A", body } }) as any;
  assert.equal(mapped.level, undefined, "no level leaves ticket-task's default, trusted");
  assert.deepEqual(mapped.repository.companions, ["tests/**", "docs/**", "README.md"]);
  assert.ok(mapped.repository.forbidden.includes("scripts/install-service.ts"));
  assert.equal(mapped.repository.checks.find((gate: { name: string }) => gate.name === "tests").focused, true);
  assert.equal(ticketInput({ ticket: { id: "RB-1", title: "A", body, metadata: { tags: ["careful"] } } }).level, "careful");
  assert.equal(ticketInput({ ticket: { id: "RB-1", title: "A", body, metadata: { tags: ["careful"] } }, level: "trusted" }).level, "trusted");
  assert.equal(ticketInput({ ticket: { id: "RB-1", title: "A", body }, continueImplementer: false }).continueImplementer, false);
  for (const level of [undefined, "careful", "trusted", "auto"]) assert.doesNotThrow(() => ticketTask(runtime, ticketInput({ ticket: { id: "RB-1", title: "A", body }, level })), String(level));
});

test("ticket: one implementer, the layered gates and one review deliver one commit on a local ticket branch", { timeout: 600_000 }, async context => {
  const run = await ticket(context, { tester: () => assert.fail("trusted has no tester"), implementer: implement("ready"), reviewer: () => approve });
  assert.equal(run.state, "delivered", JSON.stringify(run.receipt.reason));
  for (const state of ["implement", "gate", "review", "commit", "deliver"]) assert.ok(run.states.includes(state), state);
  for (const state of ["falsify", "plan", "red", "stuck"]) assert.equal(run.states.includes(state), false, state);
  // The tests gate ran only the test that names the changed module; smoke and tunnel fired because src/** changed.
  const [round] = run.receipt.checkRounds;
  assert.deepEqual(round.ran.find((check: { name: string }) => check.name === "tests").focused, ["tests/fixture-marker.test.ts"]);
  assert.deepEqual(round.ran.map((check: { name: string }) => check.name), ["lint", "types", "tests", "smoke", "tunnel"]);
  assert.match(run.branches, /ticket\/rb-t-add-fixture-marker/u);
  assert.equal(git(run.repo, "log", "-1", "--format=%s%n%b", "ticket/rb-t-add-fixture-marker").trim(), "Add fixture marker\nTicket: RB-T");
  assert.equal(git(run.repo, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(run.repo, "status", "--porcelain"), "");
  assert.deepEqual(run.asked, []);
});

test("ticket: a gate still failing after the repairs asks the owner, and hand off keeps the candidate uncommitted", { timeout: 600_000 }, async context => {
  const run = await ticket(context, { implementer: implement("wrong"), reviewer: () => assert.fail("review must not run after a failed gate") });
  assert.equal(run.state, "handedOff");
  assert.equal(run.asked.length, 1);
  assert.equal(run.called.includes("review"), false);
  assert.equal(readFileSync(join(run.worktree, "src/fixture-marker.ts"), "utf8").includes("wrong"), true);
  assert.equal(git(run.repo, "rev-list", "--count", "main..ticket/rb-t-add-fixture-marker"), "0");
});

test("ticket: an edit outside Scope is delivered and listed as a scope addition", { timeout: 600_000 }, async context => {
  const run = await ticket(context, {
    implementer: implement("ready", cwd => writeFileSync(join(cwd, "scripts/fixture-note.md"), "Why the marker exists.\n")),
    reviewer: () => approve,
  });
  assert.equal(run.state, "delivered", JSON.stringify(run.receipt.reason));
  assert.match(JSON.stringify(run.delivery?.scopeAdditions), /scripts\/fixture-note\.md/u);
  assert.deepEqual(run.asked, []);
});

test("ticket: an edit to a forbidden path stops before review and asks the owner", { timeout: 600_000 }, async context => {
  const run = await ticket(context, {
    implementer: implement("ready", cwd => writeFileSync(join(cwd, "scripts/install-service.ts"), "// changed\n")),
    reviewer: () => assert.fail("review must not run after a forbidden path changed"),
  });
  assert.equal(run.state, "handedOff");
  assert.equal(run.asked.length, 1);
  assert.match(run.asked[0]!, /scripts\/install-service\.ts/u);
  assert.equal(run.called.includes("review"), false);
});

test("ticket: a careful run's falsify questions ask the owner before any edit", { timeout: 600_000 }, async context => {
  const question = { text: "Should the marker be exported as default?", options: ["named", "default"], recommended: "named", assumable: false, why: "The ticket names neither" };
  const run = await ticket(context, {
    falsify: () => ({ type: "questions", summary: "One gap", questions: [question] }),
    tester: () => assert.fail("tester must not run"), implementer: () => assert.fail("implementer must not run"),
  }, { level: "careful" });
  assert.equal(run.state, "handedOff");
  assert.match(run.asked.join("\n"), /exported as default/u);
  assert.equal(existsSync(join(run.worktree, "tests/fixture-marker.test.ts")), false);
});
