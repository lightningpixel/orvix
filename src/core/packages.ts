import { existsSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * Maps a project file to the directory of its nearest package.json, or "" for
 * the project root.
 *
 * Used to keep channel matching inside one package: a client and the server it
 * talks to share one, while a monorepo's unrelated examples each have their
 * own and reuse the same channel names. Memoised per directory, since every
 * file in a directory has the same answer.
 */
export function packageResolver(root: string): (file: string) => string {
  const memo = new Map<string, string>();

  const lookup = (dir: string): string => {
    const known = memo.get(dir);
    if (known !== undefined) return known;

    const found =
      dir === "" || dir === "."
        ? ""
        : existsSync(join(root, dir, "package.json"))
          ? dir
          : lookup(posix.dirname(dir) === "." ? "" : posix.dirname(dir));
    memo.set(dir, found);
    return found;
  };

  return (file) => {
    const dir = posix.dirname(file);
    return lookup(dir === "." ? "" : dir);
  };
}
