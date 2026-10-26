export const BLOCK_START = "<!-- orvix:start -->";
export const BLOCK_END = "<!-- orvix:end -->";

/**
 * The instructions written into an agent's context file.
 *
 * The negative half matters as much as the positive: without it an agent runs
 * `orvix show` on a JSON file, gets nothing back, and concludes the tool is
 * broken instead of falling back to reading the file.
 */
export function instructionBlock(): string {
  return `${BLOCK_START}
## Codebase navigation (orvix)

This project is indexed by orvix. Prefer it over \`grep\` and over reading whole files.

- \`orvix map --budget 2000\` — the project's symbols, most important first
- \`orvix map --focus <id|name|file>\` — the same map, centred on what your task touches
- \`orvix show <id>\` — one symbol's exact source. Do not read the whole file.
- \`orvix find <name>\` — locate a symbol when you don't have its id
- \`orvix who-calls <id>\` — every caller. Run this before changing a signature.
- \`orvix calls <id>\` — what a symbol depends on

Ids are short and stable across edits: reuse an id you were given earlier rather than
re-running \`map\`. Names work too — \`orvix show validate\`, \`orvix show Service.validate\`.

Queries answer from a prebuilt index and never reparse on their own, so run
\`orvix index\` after you change files. (Under Claude Code this is automatic: a hook marks
edited files and the next query picks them up.)

Do not use orvix for files outside TypeScript, TSX, JavaScript, Python, Go, Rust, Java,
C#, C++ and C — read those directly. Do not use it for anything that is not a symbol: string literals,
configuration keys, comments, TODOs. Use \`grep\` for those.
${BLOCK_END}
`;
}

/**
 * Writes the block into a document, replacing any previous one.
 *
 * Idempotent by construction: running `orvix init` twice must leave the file
 * byte-identical, and updating Orvix must refresh stale instructions in place
 * rather than stack a second copy underneath.
 */
export function upsertBlock(existing: string, block: string): string {
  const body = block.trimEnd();
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);

  if (start !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + BLOCK_END.length);
    return `${before}${body}${after}`.trimEnd() + "\n";
  }

  const prefix = existing.trimEnd();
  return prefix.length === 0 ? `${body}\n` : `${prefix}\n\n${body}\n`;
}
