type ClaudeAgent = typeof import("@dna113p/machines/claude").claudeAgent;
type CodexAgent = typeof import("@dna113p/machines/codex").codexAgent;

// Agent presets for rig-bridge. Each runs an installed CLI (`claude`, `codex`) with
// its existing login and spends that plan. README.md in this directory records
// why each role has its preset; change model choices here, not in workflows.

// At a usage limit any preset may hand its request to these read-only presets, in order.
export const fallback = ["sol-review", "claude-review"];

export default ({ claudeAgent, codexAgent }: { claudeAgent: ClaudeAgent; codexAgent: CodexAgent }) => {
  // GPT-6.1 Sol through Codex, whose sandbox Codex enforces.
  const sol = (sandbox: "read-only" | "workspace-write", summary: string, fallback?: string[]) => ({
    description: summary,
    ...(fallback === undefined ? {} : { fallback }),
    harness: "codex",
    model: "gpt-6.1-sol",
    thinking: "high",
    runner: codexAgent("codex", [], { model: "gpt-6.1-sol", effort: "high", sandbox, output: "capture" }),
  });
  // Editing roles approve edits and shell commands themselves, so a run does not
  // depend on this computer's Claude Code allow rules. They run on the host in a
  // ticket worktree, where rig-bridge's tests can start servers and bind ports.
  const editor = (name: string, effort: string, summary: string) => ({
    description: `${summary}; edits files and runs commands in its workspace`,
    fallback: ["implementer-sol"],
    harness: "claude",
    model: name,
    thinking: effort,
    runner: claudeAgent("claude", [], {
      model: name, effort, permissionMode: "acceptEdits", allowedTools: ["Bash"], output: "capture",
    }),
  });
  // Read-only roles lose the editing tools. An allowed Bash can still write;
  // the Machine Shop unchanged-checkout guard detects that after the fact.
  const reader = (name: string, effort: string, summary: string, fallback?: string[]) => ({
    description: `${summary}; no file-editing tools`,
    ...(fallback === undefined ? {} : { fallback }),
    harness: "claude",
    model: name,
    thinking: effort,
    runner: claudeAgent("claude", [], { model: name, effort, disallowedTools: ["Edit", "Write", "NotebookEdit"], output: "capture" }),
  });

  return {
    "claude-review": reader("opus", "high", "Reviews and investigates with Opus"),
    "sol-review": sol("read-only", "Reviews and investigates with GPT-6.1 Sol in a read-only sandbox"),

    // Machine Shop roles. Opus edits; the other provider reviews.
    implementer: editor("opus", "high", "Implements scoped rig-bridge changes with Opus"),
    tester: editor("opus", "high", "Writes focused rig-bridge regression tests with Opus"),
    reviewer: sol("read-only", "Reviews changes and evidence with GPT-6.1 Sol in a read-only sandbox", ["reviewer-opus"]),
    investigator: reader("opus", "high", "Investigates and diagnoses rig-bridge questions with Opus"),

    // Mirrored pairing, per run: --agent implementer=implementer-sol --agent reviewer=reviewer-opus
    "implementer-sol": sol("workspace-write", "Implements scoped changes with GPT-6.1 Sol; edits its workspace", ["implementer"]),
    "reviewer-opus": reader("opus", "high", "Reviews changes and evidence with Opus", ["reviewer"]),
  };
};
