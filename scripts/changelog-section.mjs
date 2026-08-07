// Pulls one version's notes out of CHANGELOG.md, for the release workflow.
//
// Kept as plain JavaScript rather than TypeScript so the release job can run
// it straight from a checkout, without depending on a build having succeeded.

/**
 * Returns the body of the section for `version`, or undefined when there is
 * no such section or it is empty.
 *
 * Matches `## [1.2.3] - date`, `## [1.2.3]` and `## 1.2.3` alike, and accepts
 * a `v` prefix so a git tag can be passed in unchanged.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | undefined}
 */
export function changelogSection(changelog, version) {
  const wanted = version.replace(/^v/, "");
  if (wanted.toLowerCase() === "unreleased") return undefined;

  const lines = changelog.split("\n");
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (headingVersion(lines[index]) === wanted) {
      start = index + 1;
      break;
    }
  }

  if (start === -1) return undefined;

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (headingVersion(lines[index]) !== undefined) {
      end = index;
      break;
    }
  }

  const body = lines.slice(start, end).join("\n").trim();
  return body.length > 0 ? body : undefined;
}

/**
 * The version a `## ` heading declares, or undefined when the line is not
 * such a heading. Anchored so `0.1` never matches the `0.1.0` heading.
 *
 * @param {string | undefined} line
 * @returns {string | undefined}
 */
function headingVersion(line) {
  const match = /^##\s+\[?([^\]\s]+)\]?/.exec(line ?? "");
  return match?.[1];
}
