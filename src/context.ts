import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, hostname, platform, arch, userInfo } from "node:os";
import * as pi from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  try { return (await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { timeout: 5000, maxBuffer: 64_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim(); }
  catch { return null; }
}
async function exists(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }

const MAX_INSTRUCTION_BYTES = 64 * 1024;

export interface InstructionFile {
  path: string;
  content: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  directory: string;
  disable_model_invocation: boolean;
}

export async function loadContextFiles(cwd: string): Promise<InstructionFile[]> {
  const files: InstructionFile[] = [];
  const seen = new Set<string>();

  try {
    const loaded = pi.loadProjectContextFiles({ cwd, agentDir: pi.getAgentDir() });
    for (const f of loaded) {
      if (!seen.has(f.path)) {
        let content = f.content;
        if (content.length > MAX_INSTRUCTION_BYTES) {
          content = content.slice(0, MAX_INSTRUCTION_BYTES) + "\n\n[... Truncated: instruction file exceeds 64 KiB. Use read tool for full content ...]";
        }
        files.push({ path: f.path, content });
        seen.add(f.path);
      }
    }
  } catch { /* Fallback if project context files cannot be read */ }

  const supplementalNames = ["CONTEXT.md"];
  const supplementalFiles: InstructionFile[] = [];
  let parent = cwd;
  while (true) {
    for (const name of supplementalNames) {
      const path = join(parent, name);
      if (!seen.has(path) && await exists(path)) {
        try {
          let content = (await readFile(path, "utf-8")).trim();
          if (content.length > MAX_INSTRUCTION_BYTES) {
            content = content.slice(0, MAX_INSTRUCTION_BYTES) + "\n\n[... Truncated: instruction file exceeds 64 KiB. Use read tool for full content ...]";
          }
          supplementalFiles.unshift({ path, content });
          seen.add(path);
        } catch {}
      }
    }
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  files.push(...supplementalFiles);
  return files;
}

export function formatProjectContext(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  let out = "<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const file of files) {
    out += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
  }
  out += "</project_context>";
  return out.trim();
}

export function loadWorkspaceSkills(cwd: string) {
  try {
    const result = pi.loadSkills({
      cwd,
      agentDir: pi.getAgentDir(),
      skillPaths: [
        join(homedir(), ".agents/skills"),
        join(cwd, ".agents/skills"),
      ],
      includeDefaults: true,
    });
    return result.skills;
  } catch {
    return [];
  }
}

export function formatSkillsPrompt(skills: ReturnType<typeof loadWorkspaceSkills>): string {
  try {
    return pi.formatSkillsForPrompt(skills, "read").trim();
  } catch {
    return "";
  }
}

export async function orientation(cwd: string) {
  const instructionFiles = await loadContextFiles(cwd);
  const instructions = instructionFiles.map(f => f.path);
  const allSkills = loadWorkspaceSkills(cwd);
  const skills = allSkills.slice(0, 100).map(s => s.filePath);
  const skillDefinitions = allSkills.slice(0, 100).map(s => ({
    name: s.name,
    description: s.description,
    path: s.filePath,
    directory: s.baseDir,
    disable_model_invocation: s.disableModelInvocation,
  }));

  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const status = root === null ? null : await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  const repo = root === null ? null : {
    root, head: await git(cwd, ["rev-parse", "HEAD"]), branch: await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    dirty: status === null ? null : status.length !== 0,
  };
  return { cwd, hostname: hostname(), home: homedir(), account: userInfo().username, uid: process.getuid?.(),
    os: platform(), arch: arch(), shell: process.env.SHELL ?? "/bin/bash", repository: repo,
    instructions, instruction_files: instructionFiles,
    skills, skill_definitions: skillDefinitions, skills_truncated: allSkills.length >= 100,
    project_context: formatProjectContext(instructionFiles),
    skills_prompt: formatSkillsPrompt(allSkills),
    access: { profile: "account-administration", cwd_is_sandbox: false, elevation: "Use existing sudo -n or configured host mechanisms. Authentication is never automatically supplied." },
    context_note: "Project instructions are inlined above. Use read or skill_info to inspect skills and specific files. Context and reasoning stay in the calling assistant." };
}
