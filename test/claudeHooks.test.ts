import { describe, expect, test } from "vitest";
import {
  HOOK_MARKER,
  orvixHooks,
  upsertHooks,
  type ClaudeSettings,
} from "../src/agents/claudeHooks.js";

describe("orvixHooks", () => {
  test("marks edits dirty without blocking the turn", () => {
    const entry = orvixHooks()["PostToolUse"]!.find((e) =>
      e.matcher?.includes("Edit"),
    )!;

    expect(entry.hooks[0]!.async).toBe(true);
  });

  test("keeps the compressor synchronous", () => {
    // It has to return replacement output before the model sees the original;
    // an async hook could not.
    const entry = orvixHooks()["PostToolUse"]!.find((e) =>
      e.matcher?.includes("Read"),
    )!;

    expect(entry.hooks[0]!.async).toBeUndefined();
  });

  test("reconciles in the background when the turn ends", () => {
    expect(orvixHooks()["Stop"]![0]!.hooks[0]!.async).toBe(true);
  });

  test("points at the project's own copy of the scripts", () => {
    for (const entries of Object.values(orvixHooks())) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toContain("CLAUDE_PROJECT_DIR");
          expect(hook.command).toContain(".claude/hooks/");
        }
      }
    }
  });
});

describe("upsertHooks", () => {
  test("adds the hooks to an empty settings file", () => {
    const merged = upsertHooks({});

    expect(Object.keys(merged.hooks!)).toEqual(["PostToolUse", "UserPromptSubmit", "Stop"]);
  });

  test("is idempotent", () => {
    const once = upsertHooks({});
    const twice = upsertHooks(once);

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  test("keeps settings that are nothing to do with hooks", () => {
    const merged = upsertHooks({
      permissions: { allow: ["Bash(npm test)"] },
      model: "opus",
    });

    expect(merged["permissions"]).toEqual({ allow: ["Bash(npm test)"] });
    expect(merged["model"]).toBe("opus");
  });

  test("keeps the user's own hooks on an event it also uses", () => {
    // The property that matters most: an installer that eats a user's
    // configuration is worse than one that does nothing at all.
    const mine: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] },
        ],
      },
    };

    const merged = upsertHooks(mine);
    const commands = merged.hooks!["PostToolUse"]!.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );

    expect(commands).toContain("./mine.sh");
    expect(commands.some((command) => command.includes("orvix-dirty"))).toBe(true);
  });

  test("keeps the user's hooks on events it does not touch", () => {
    const merged = upsertHooks({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "./start.sh" }] }],
      },
    });

    expect(merged.hooks!["SessionStart"]![0]!.hooks[0]!.command).toBe("./start.sh");
  });

  test("replaces a previous orvix entry rather than stacking another", () => {
    const stale: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit",
            [HOOK_MARKER]: true,
            hooks: [{ type: "command", command: "node old-path.mjs" }],
          },
        ],
      },
    };

    const merged = upsertHooks(stale);
    const commands = merged.hooks!["PostToolUse"]!.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );

    expect(commands).not.toContain("node old-path.mjs");
    expect(commands).toHaveLength(orvixHooks()["PostToolUse"]!.length);
  });

  test("drops an orvix entry on an event it no longer registers", () => {
    const merged = upsertHooks({
      hooks: {
        PreToolUse: [
          {
            matcher: "Grep",
            [HOOK_MARKER]: true,
            hooks: [{ type: "command", command: "node deny.mjs" }],
          },
        ],
      },
    });

    expect(merged.hooks!["PreToolUse"]).toBeUndefined();
  });
});
