// spec §3 (roles), §4.5 + D7 (per-role --allowedTools), D5 (per-role model
// defaults), D3 (artifact path convention)
//
// Roles are built into the controller, not a table (spec §3, CLAUDE.md
// banned list has no roles table). This is the one place role -> prompt
// file / tool scope / model default is decided; `cmdSpawn` in cli.ts reads
// it, nothing else should hardcode a role's tools or prompt path.

import { readFileSync } from "fs";

// Bun inlines text-imported files into `bun build --compile` binaries; a
// runtime path read (import.meta.dir + fs.readFileSync) resolves against
// $bunfs and fails once compiled (the same bug schema.sql hit in Phase 1 —
// see src/cli.ts), so every BUILT-IN prompt is a build-time string import
// instead. --prompt-file (below) is the one deliberate exception: it reads
// a real, dynamic filesystem path at runtime by design (spec §5).
import coderPrompt from "../prompts/coder.md" with { type: "text" };
import reviewerPrompt from "../prompts/reviewer.md" with { type: "text" };
import testerPrompt from "../prompts/tester.md" with { type: "text" };
import docWriterPrompt from "../prompts/doc-writer.md" with { type: "text" };

export const ROLES = ["coder", "reviewer", "tester", "doc-writer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

// D7: coder/doc-writer get Write+Edit; reviewer/tester are read-only plus
// the tools their job needs. reviewer additionally gets Bash(git *) — read
// commands only (git diff/status) per its prompt contract, not enforced by
// the pattern itself since git has no unprivileged read-only subset the
// allowlist can express; the prompt is the actual boundary there, same as
// doc-writer's artifacts-only Write scope. Bash(<synapse path> *) and
// Bash(printenv *) are implicit on every role — added by allowedToolsFor,
// not listed here — so this table matches spec §4.5's table verbatim.
const ALLOWED_TOOLS: Record<Role, string[]> = {
  coder: ["Write", "Edit", "Bash", "Read", "Glob", "Grep"],
  reviewer: ["Read", "Glob", "Grep", "Bash(git *)"],
  tester: ["Read", "Glob", "Grep", "Bash"],
  "doc-writer": ["Write", "Edit", "Read", "Glob", "Grep"],
};

// D5: manager and reviewer get the stronger model; everything else gets
// the default. No manager entry here — the manager is not spawned via
// `synapse spawn` (spec §4.4: the watcher resumes its session directly).
const STRONG_MODEL = "claude-opus-5";
const DEFAULT_MODEL = "claude-sonnet-5";

const MODEL_DEFAULTS: Record<Role, string> = {
  coder: DEFAULT_MODEL,
  reviewer: STRONG_MODEL,
  tester: DEFAULT_MODEL,
  "doc-writer": DEFAULT_MODEL,
};

// spec §4.5, D7 (rev 3, corrected by a real trial run — spec §9 #24/#25):
// Claude Code's Bash(pattern *) allowlist matches literal command TEXT, not
// shell-expanded output — Bash(synapse *) never matched an invocation of
// $SYNAPSE_BIN (denied as "Contains simple_expansion") or the binary's
// resolved absolute path (denied as requiring approval). The fix has two
// halves, both required: (1) the worker's prompt gets the synapse binary's
// REAL absolute path substituted as a literal string at spawn time — see
// cli.ts's PROMPT_SUBSTITUTIONS — so there is no variable for Bash to
// refuse to expand; (2) the allowlist grants Bash(<that same literal path>
// *), computed here per spawn rather than as a static "synapse" grant,
// since the path is only known at spawn time (D2: per-repo state, so the
// binary's path varies by checkout).
export function allowedToolsFor(role: Role, synapseBinPath: string): string[] {
  return [...ALLOWED_TOOLS[role], `Bash(${synapseBinPath} *)`, "Bash(printenv *)"];
}

export function defaultModelFor(role: Role): string {
  return MODEL_DEFAULTS[role];
}

// spec §5: --prompt-file is the escape hatch to try a variant prompt
// without editing the controller (a real filesystem path, read at runtime —
// unlike the built-in prompts, this is expected to be dynamic, so it is
// NOT build-time inlined).
const BUILT_IN_PROMPTS: Record<Role, string> = {
  coder: coderPrompt,
  reviewer: reviewerPrompt,
  tester: testerPrompt,
  "doc-writer": docWriterPrompt,
};

export function builtInPromptFor(role: Role): string {
  return BUILT_IN_PROMPTS[role];
}

// spec §5: --prompt-file overrides the built-in without a rebuild — a real
// runtime path read is exactly what that override needs.
export function loadPromptFile(path: string): string {
  return readFileSync(path, "utf-8");
}
