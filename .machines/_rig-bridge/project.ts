import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { jsonObject, object } from "../_machine-shop/task.ts";

/** The checkout whose .machines/ defined this route. */
export const definingCheckout = resolve(import.meta.dirname, "..", "..");

/** A gate as project.json gives it; layered fields (when, focused, group, after, ...) pass through to Machine Shop untouched. */
interface Gate { name: string; command: string[]; timeoutMs?: number; [layered: string]: unknown }
interface Project {
  checks: Gate[];
  ticket: {
    base: string; output: string; worktreeRoot: string; setup: Gate[];
    /** Paths every ticket may touch beside its own Scope. */
    companions?: string[];
    /** Path globs a revert cannot undo (credentials, the live services' install scripts); a change to one stops the run for the owner. */
    forbiddenPaths?: string[];
    /** Prose rules appended to every ticket's Forbidden section; they guide the Agents and stop nothing by themselves. */
    forbidden: string[];
    /** The standing level when a ticket names none; unset leaves Machine Shop's default, trusted. */
    level?: string;
  };
}

/** project.json is the one list of gates; every route reads it. */
export function project(): Project {
  return JSON.parse(readFileSync(join(import.meta.dirname, "..", "project.json"), "utf8")) as Project;
}

/** The named gates in project.json order, or all of them; an unknown name is refused rather than skipped. */
export function gates(names: string[] = []): Gate[] {
  const all = project().checks;
  const unknown = names.filter(name => !all.some(gate => gate.name === name));
  if (unknown.length > 0) throw new Error(`Unknown gate(s): ${unknown.join(", ")}; project.json has ${all.map(g => g.name).join(", ")}`);
  return all.filter(gate => names.length === 0 || names.includes(gate.name));
}

/**
 * Accepts a Machine Shop assignment as an object, JSON text, or plain task text
 * and fills the workspace with this checkout. Editing routes also get every
 * gate unless the assignment names its own; read-only routes get none.
 */
export function withGates(input: unknown, { checks = true }: { checks?: boolean } = {}): Record<string, unknown> {
  const assignment = typeof input === "string" ? jsonObject(input) ?? { task: input } : input;
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
    throw new Error("Input must be task text or a Machine Shop assignment object");
  }
  const filled: Record<string, unknown> = { workspace: definingCheckout, ...assignment };
  if (typeof filled.workspace === "string") filled.workspace = resolve(filled.workspace);
  if (checks && filled.checks === undefined) filled.checks = gates();
  return filled;
}

// maxReviewRounds, redGreen and assume only change a careful run; trusted and auto accept and ignore them.
const ticketKeys = ["ticket", "ticketFile", "output", "level", "continueImplementer", "maxRepairs", "maxReviewRounds", "resume", "assume", "stuck", "redGreen"];

/**
 * Maps a rig-bridge ticket request onto Machine Shop's ticket-task input.
 * The repository, base, setup, gates, companions, forbidden paths, worktree
 * root, and project-wide forbidden actions come from project.json; a request
 * supplies the ticket and may change the level, delivery mode and budgets.
 * The level is the request's `level`, else `careful` when the ticket is tagged
 * `careful`, else project.json's `ticket.level`; with none, ticket-task runs
 * `trusted` (docs/plans/trusted-by-default.md in machines-org).
 */
export function ticketInput(input: unknown, { cwd = process.cwd(), root = definingCheckout } = {}): Record<string, unknown> {
  const request = object(typeof input === "string" ? jsonObject(input) ?? fileRequest(input) : input, "input", ticketKeys);
  if ((request.ticket === undefined) === (request.ticketFile === undefined)) throw new Error("Supply exactly one of ticket or ticketFile");
  const ticket = request.ticketFile === undefined
    ? { ...object(request.ticket, "ticket", ["id", "title", "body", "source", "metadata"]) }
    : readTicket(resolve(cwd, String(request.ticketFile)));
  const config = project().ticket;
  if (typeof ticket.body === "string") ticket.body = `${ticket.body.trimEnd()}\n\n## Forbidden\n${config.forbidden.map(rule => `- ${rule}`).join("\n")}\n`;
  const worktreeRoot = resolve(root, config.worktreeRoot);
  const { ticket: _ticket, ticketFile: _file, output = config.output, level: asked, ...budgets } = request;
  const metadata = (ticket as { metadata?: { tags?: unknown } }).metadata;
  const tags = Array.isArray(metadata?.tags) ? metadata.tags : [];
  const level = asked ?? (tags.includes("careful") ? "careful" : config.level);
  return {
    ticket,
    ...(level === undefined ? {} : { level }),
    repository: {
      name: basename(root), path: root, base: config.base, output, setup: config.setup, checks: gates(),
      companions: config.companions ?? [], forbidden: config.forbiddenPaths ?? [],
    },
    worktreeRoot,
    // Evidence sits beside the worktrees, outside every checkout, so it is never committed.
    evidenceRoot: worktreeRoot,
    ...budgets,
  };
}

/** Plain text that is not JSON is a ticket file path. */
function fileRequest(input: string) {
  const path = input.trim();
  if (!path.endsWith(".md")) throw new Error("Text input must be a ticket .md path or a JSON request");
  return { ticketFile: path };
}

/** A ticket file is `<id>.md` whose first `# ` heading is the title; the rest is the body. */
export function readTicket(path: string): { id: string; title: string; body: string } {
  const text = readFileSync(path, "utf8");
  const heading = /^#\s+(.+?)\s*$/mu.exec(text);
  if (!heading) throw new Error(`${path} needs a first "# Title" heading`);
  return { id: basename(path, ".md"), title: heading[1]!, body: text.slice(heading.index + heading[0].length).trim() };
}
