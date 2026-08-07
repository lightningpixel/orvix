// Shown once after installation, to point at `orvix init`.
//
// Three rules this script must never break:
//   1. Never ask anything. npm runs postinstall without a terminal far more
//      often than with one, and a hidden prompt is an install that hangs.
//   2. Never fail. A broken notice must not break someone's install, so the
//      whole thing is wrapped and always exits 0.
//   3. Stay quiet where nobody is reading — CI logs, scripted installs.

try {
  const quiet =
    process.env.CI ||
    process.env.ORVIX_NO_POSTINSTALL ||
    !process.stdout.isTTY ||
    process.env.npm_config_loglevel === "silent";

  if (!quiet) {
    console.log(`
  orvix installed.

  Run \`orvix init\` inside a project to set it up:
  it writes the instructions your coding agents read, and builds the index.
`);
  }
} catch {
  // Never let a cosmetic notice fail an installation.
}
