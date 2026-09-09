import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { validateCandidateFiles } from "../lib/trial-candidate.mjs";
export { candidateRecord, candidateIdentity, compareCandidate } from "../lib/trial-candidate.mjs";

export function readCandidate(directory) {
  const files = Object.create(null);
  const modes = Object.create(null);
  const violations = [];
  let bytes = 0;
  let entries = 0;
  const walk = (relative) => {
    const listing = readdirSync(path.join(directory, relative), { withFileTypes: true });
    for (const entry of listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = entry.name;
      if (!relative && name === ".git") continue;
      const key = path.join(relative, name);
      const file = path.join(directory, key);
      if (++entries > 1000) throw new Error("Candidate exceeds 1000 entries");
      if (entry.isSymbolicLink()) {
        violations.push(`Symlink ${key}: ${readlinkSync(file)}`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(key);
        continue;
      }
      // Read a no-follow descriptor so a swapped leaf cannot redirect capture.
      const handle = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = fstatSync(handle);
        if (!opened.isFile() || opened.nlink > 1) {
          violations.push(`Non-regular or hard-linked file: ${key}`);
          continue;
        }
        bytes += opened.size;
        if (opened.size > 4 * 1024 * 1024 || bytes > 16 * 1024 * 1024)
          throw new Error("Candidate exceeds snapshot byte limits");
        files[key] = readFileSync(handle);
        modes[key] = opened.mode & 0o111 ? "100755" : "100644";
      } finally {
        closeSync(handle);
      }
    }
  };
  walk("");
  return { files, modes, violations };
}

export function materialize(directory, files, modes = {}) {
  validateCandidateFiles(files, modes);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const mode = Object.hasOwn(modes, name) ? modes[name] : "100644";
    const permissions = mode === "100755" ? 0o755 : 0o644;
    writeFileSync(target, contents, { flag: "wx", mode: permissions });
    chmodSync(target, permissions);
  }
}

export function candidatePatch(
  directory,
  original,
  candidate,
  { originalModes, candidateModes } = {},
) {
  materialize(path.join(directory, "original"), original, originalModes);
  materialize(path.join(directory, "candidate"), candidate, candidateModes);
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      "original",
      "candidate",
    ],
    {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (![0, 1].includes(result.status)) throw new Error(`Patch generation failed: ${result.stderr}`);
  return result.stdout;
}
