export interface AgentDef {
  /** Stable identifier, used by `--agent` and stored in the global config. */
  id: string;
  /** Name shown when asking the user. */
  label: string;
  /** Instruction file this agent reads, relative to the project root. */
  file: string;
}

/**
 * The agents Orvix can write instructions for.
 *
 * Several read the same file — AGENTS.md is a shared convention — which is
 * why callers should go through `targetFiles` rather than mapping ids
 * themselves.
 */
export const AGENTS: readonly AgentDef[] = [
  { id: "claude", label: "Claude Code", file: "CLAUDE.md" },
  { id: "codex", label: "Codex", file: "AGENTS.md" },
  { id: "cursor", label: "Cursor", file: "AGENTS.md" },
  { id: "gemini", label: "Gemini CLI", file: "GEMINI.md" },
];

export function agentById(id: string): AgentDef | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

/**
 * The distinct files to write for a set of agents, sorted so a run is
 * reproducible and two agents sharing a file are written once.
 */
export function targetFiles(agentIds: string[]): string[] {
  const files = agentIds
    .map((id) => agentById(id)?.file)
    .filter((file): file is string => file !== undefined);

  return [...new Set(files)].sort();
}
