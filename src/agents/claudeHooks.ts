/**
 * The hook configuration `orvix init` installs.
 *
 * Written into the project's own .claude/settings.json rather than handed to
 * the user to paste. An integration the user has to assemble by hand is one
 * most projects will simply not have.
 */

/** Marks our entries so they can be replaced without touching anyone else's. */
export const HOOK_MARKER = "orvix";

export interface HookCommand {
  type: "command";
  command: string;
  async?: boolean;
  timeout?: number;
  [key: string]: unknown;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/** `${CLAUDE_PROJECT_DIR}` keeps the config portable between machines. */
const SCRIPT = (name: string) =>
  `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}"`;

/**
 * The hooks, and why each is registered the way it is.
 *
 * Both `async` hooks do work nobody is waiting on, so they are kept off the
 * turn's critical path entirely. The compressor cannot be async: it has to
 * return replacement output before the model sees the original, which is the
 * whole point of doing this at PostToolUse instead of denying the call.
 */
export function orvixHooks(): Record<string, HookMatcher[]> {
  return {
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit",
        [HOOK_MARKER]: true,
        hooks: [{ type: "command", command: SCRIPT("orvix-dirty.mjs"), async: true }],
      },
      {
        // Bash is here because half of real searches are `rg` or `grep` run
        // through the shell rather than the native tool, and those were going
        // past uncompressed. Glob is not: it returns bare paths with no line
        // numbers, so there is nothing to resolve to a symbol, and registering
        // it only spawned a process to do nothing.
        matcher: "Read|Grep|Bash",
        [HOOK_MARKER]: true,
        hooks: [{ type: "command", command: SCRIPT("orvix-compress.mjs"), timeout: 10 }],
      },
    ],
    UserPromptSubmit: [
      {
        // Synchronous for the same reason as the compressor: the map has to
        // arrive with the prompt, or the model has already gone searching.
        [HOOK_MARKER]: true,
        hooks: [{ type: "command", command: SCRIPT("orvix-focus.mjs"), timeout: 10 }],
      },
    ],
    Stop: [
      {
        [HOOK_MARKER]: true,
        hooks: [{ type: "command", command: SCRIPT("orvix-reconcile.mjs"), async: true }],
      },
    ],
  };
}

/**
 * Merges Orvix's hooks into existing settings.
 *
 * Idempotent in the same way the markdown block is: our entries are recognised
 * by their marker and replaced wholesale, everything else in the file is left
 * exactly as it was, and running twice changes nothing. A settings file is the
 * user's, and an installer that clobbers it is worse than one that does
 * nothing.
 */
export function upsertHooks(existing: ClaudeSettings): ClaudeSettings {
  const merged: ClaudeSettings = { ...existing };
  const hooks: Record<string, HookMatcher[]> = { ...(existing.hooks ?? {}) };
  const ours = orvixHooks();

  for (const [event, entries] of Object.entries(ours)) {
    const theirs = (hooks[event] ?? []).filter((entry) => !entry[HOOK_MARKER]);
    hooks[event] = [...theirs, ...entries];
  }

  // An event we no longer register but previously owned: drop our entry and
  // keep the event only if the user has something of their own there.
  for (const [event, entries] of Object.entries(hooks)) {
    if (event in ours) continue;
    const theirs = entries.filter((entry) => !entry[HOOK_MARKER]);
    if (theirs.length > 0) hooks[event] = theirs;
    else delete hooks[event];
  }

  merged.hooks = hooks;
  return merged;
}
