import { createInterface } from "node:readline/promises";
import type { AgentDef } from "../agents/registry.js";

/**
 * Turns whatever the user typed into agent ids.
 *
 * Accepts menu numbers or names, in any mix, separated by commas or spaces —
 * people type `1,2`, `1 2` and `claude gemini` in roughly equal measure, and
 * none of them should be a mistake.
 *
 * An empty answer yields nothing, leaving the caller to apply its default.
 */
export function parseAgentSelection(
  answer: string,
  agents: readonly AgentDef[],
): string[] {
  const tokens = answer
    .split(/[\s,]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  const chosen: string[] = [];

  for (const token of tokens) {
    const byNumber = /^\d+$/.test(token)
      ? agents[Number(token) - 1]
      : undefined;
    const agent = byNumber ?? agents.find((candidate) => candidate.id === token);

    if (agent && !chosen.includes(agent.id)) chosen.push(agent.id);
  }

  return chosen;
}

/** True when there is a real terminal to ask a question on. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Asks once, on the terminal. Never called without `isInteractive()`. */
export async function askForAgents(
  agents: readonly AgentDef[],
): Promise<string[]> {
  const menu = agents
    .map((agent, index) => `  ${index + 1}. ${agent.label} (${agent.file})`)
    .join("\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(
      `Which coding agents do you use?\n${menu}\n` +
        `Numbers or names, comma-separated. Enter for AGENTS.md: `,
    );
    return parseAgentSelection(answer, agents);
  } finally {
    rl.close();
  }
}
