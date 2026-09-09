import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digest } from "./workflow-plan.mjs";

const commitPattern = /^[a-f0-9]{40}$/;
const maximumBytes = 16 * 1024 * 1024;
const maximumFileBytes = 4 * 1024 * 1024;

export function validateRepositoryFiles(files, { allowEmpty = false } = {}) {
  if (!Array.isArray(files) || (!allowEmpty && !files.length) || files.length > 1000)
    throw new Error("Repository snapshot must contain 1 to 1000 files");
  const names = new Set();
  let bytes = 0;
  for (const file of files) {
    if (
      typeof file.name !== "string" ||
      file.name.includes("\\") ||
      Array.from(file.name).some(
        (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
      ) ||
      file.name
        .split("/")
        .some((part) => !part || part === "." || part === ".." || /^\.git$/i.test(part)) ||
      names.has(file.name)
    )
      throw new Error("Unsafe or duplicate repository path");
    names.add(file.name);
    if (!["100644", "100755"].includes(file.mode))
      throw new Error(`Unsupported repository mode: ${file.mode}`);
    if (typeof file.base64 !== "string") throw new Error("Missing repository file content");
    const contents = Buffer.from(file.base64, "base64");
    if (contents.toString("base64") !== file.base64)
      throw new Error("Noncanonical repository file encoding");
    bytes += contents.length;
    if (contents.length > maximumFileBytes || bytes > maximumBytes)
      throw new Error("Repository snapshot exceeds the source size limit");
  }
  for (const name of names) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (names.has(parts.join("/"))) throw new Error("Repository file conflicts with directory");
    }
  }
}

export function validateRepositorySnapshot(snapshot) {
  if (
    snapshot?.schemaVersion !== 1 ||
    !commitPattern.test(snapshot.commit) ||
    !commitPattern.test(snapshot.tree)
  )
    throw new Error("Repository snapshot requires pinned commit and tree identities");
  validateRepositoryFiles(snapshot.files);
  const { sha256, ...content } = snapshot;
  if (sha256 !== digest(content)) throw new Error("Repository snapshot digest mismatch");
  return snapshot;
}

export function materializeRepositorySnapshot(snapshot, directory) {
  validateRepositorySnapshot(snapshot);
  materializeRepositoryFiles(snapshot.files, directory);
}

export function materializeRepositoryFiles(files, directory) {
  validateRepositoryFiles(files);
  mkdirSync(directory, { mode: 0o755 });
  chmodSync(directory, 0o755);
  for (const file of files) {
    const target = path.join(directory, file.name);
    let parent = directory;
    for (const part of file.name.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      mkdirSync(parent, { recursive: true, mode: 0o755 });
      chmodSync(parent, 0o755);
    }
    const mode = file.mode === "100755" ? 0o755 : 0o644;
    writeFileSync(target, Buffer.from(file.base64, "base64"), { flag: "wx", mode });
    chmodSync(target, mode);
  }
}

export function exportPinnedTree(repository, commit) {
  if (!commitPattern.test(commit)) throw new Error("An exact repository commit is required");
  const git = (args, input) => {
    const result = spawnSync("git", ["-C", repository, "-c", "core.hooksPath=/dev/null", ...args], {
      input,
      timeout: 30000,
      maxBuffer: 24 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.status !== 0) throw new Error(`Pinned source read failed: ${result.stderr}`);
    return result.stdout;
  };
  if (git(["cat-file", "-t", commit]).toString().trim() !== "commit")
    throw new Error("Pinned source identity is not a commit");
  const tree = git(["rev-parse", `${commit}^{tree}`])
    .toString()
    .trim();
  const listing = new TextDecoder("utf-8", { fatal: true }).decode(
    git(["ls-tree", "-rlz", commit]),
  );
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("Invalid Git tree entry");
      const [, mode, , object, size, name] = match;
      if (!["100644", "100755"].includes(mode))
        throw new Error(`Unsupported repository mode: ${mode}`);
      return { name, mode, object, size: Number(size) };
    });
  if (
    entries.length > 1000 ||
    entries.some((entry) => !Number.isSafeInteger(entry.size) || entry.size > maximumFileBytes) ||
    entries.reduce((sum, entry) => sum + entry.size, 0) > maximumBytes
  )
    throw new Error("Repository snapshot exceeds the source size limit");
  const batch = git(
    ["cat-file", "--batch"],
    entries.map((entry) => entry.object).join("\n") + "\n",
  );
  let offset = 0;
  const files = entries.map(({ name, mode, object, size }) => {
    const end = batch.indexOf(10, offset);
    if (end < 0 || batch.subarray(offset, end).toString() !== `${object} blob ${size}`)
      throw new Error("Unexpected Git object response");
    const contents = batch.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size;
    if (contents.length !== size || batch[offset++] !== 10)
      throw new Error("Truncated Git object response");
    return { name, mode, base64: contents.toString("base64") };
  });
  if (offset !== batch.length) throw new Error("Unexpected trailing Git object data");
  const content = { schemaVersion: 1, commit, tree, files };
  return validateRepositorySnapshot({ ...content, sha256: digest(content) });
}
