import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, hostname, platform, arch, userInfo } from "node:os";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  try { return (await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { timeout: 5000, maxBuffer: 64_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim(); }
  catch { return null; }
}
async function exists(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }

export async function orientation(cwd: string) {
  const instructions: string[] = [];
  let parent = cwd;
  while (true) {
    for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
      const path = join(parent, name);
      if (await exists(path)) instructions.push(path);
    }
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  const skills: string[] = [];
  for (const base of [...new Set([join(homedir(), ".agents/skills"), join(homedir(), ".pi/agent/skills"), join(cwd, ".agents/skills"), join(cwd, ".pi/skills")])]) {
    try {
      for (const entry of (await readdir(base)).sort()) {
        const path = join(base, entry, "SKILL.md");
        if (await exists(path)) skills.push(path);
        if (skills.length >= 100) break;
      }
    } catch { /* A missing skill directory is ordinary. */ }
    if (skills.length >= 100) break;
  }
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const status = root === null ? null : await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  const repo = root === null ? null : {
    root, head: await git(cwd, ["rev-parse", "HEAD"]), branch: await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    dirty: status === null ? null : status.length !== 0,
  };
  return { cwd, hostname: hostname(), home: homedir(), account: userInfo().username, uid: process.getuid?.(),
    os: platform(), arch: arch(), shell: process.env.SHELL ?? "/bin/bash", repository: repo,
    instructions, skills, skills_truncated: skills.length >= 100,
    access: { profile: "account-administration", cwd_is_sandbox: false, elevation: "Use existing sudo -n or configured host mechanisms. Authentication is never automatically supplied." },
    context_note: "Read the relevant instruction and skill files with read. Context and reasoning stay in ChatGPT." };
}
