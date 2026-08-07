import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Creates a throwaway project on disk from a { relativePath: contents } map.
 * Fixtures are built programmatically rather than committed, because committed
 * fixture .gitignore files interfere with the repo's own ignore rules.
 */
export async function makeProject(
  files: Record<string, string>,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "orvix-test-"));

  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(root, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
