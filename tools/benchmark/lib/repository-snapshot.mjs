import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digest } from "./workflow-plan.mjs";

const commitPattern = /^[a-f0-9]{40}$/;
const maximumBytes = 16 * 1024 * 1024;
const maximumFileBytes = 4 * 1024 * 1024;
const maximumExcludedEntries = 25_000;

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".git")
  );
}

function normalizeExclusions(exclusions) {
  if (exclusions === undefined) return [];
  if (
    !Array.isArray(exclusions) ||
    exclusions.length > 100 ||
    new Set(exclusions.map((item) => item?.path)).size !== exclusions.length
  )
    throw new Error("Source exclusions must use unique relative paths");
  for (const exclusion of exclusions) {
    if (
      !safeRelativePath(exclusion?.path) ||
      typeof exclusion.reason !== "string" ||
      !exclusion.reason.trim()
    )
      throw new Error("Source exclusions require a safe path and reason");
    if (
      exclusions.some(
        (other) =>
          other !== exclusion &&
          (other.path === exclusion.path || exclusion.path.startsWith(`${other.path}/`)),
      )
    )
      throw new Error("Source exclusions must not overlap");
  }
  return exclusions.map(({ path: name, reason }) => ({ path: name, reason: reason.trim() }));
}

function partitionEntries(entries, exclusions) {
  const normalized = normalizeExclusions(exclusions);
  const matches = new Map(normalized.map((item) => [item.path, 0]));
  const included = [];
  const excluded = [];
  for (const entry of entries) {
    const exclusion = normalized.find(
      (item) => entry.name === item.path || entry.name.startsWith(`${item.path}/`),
    );
    if (!exclusion) included.push(entry);
    else {
      matches.set(exclusion.path, matches.get(exclusion.path) + 1);
      excluded.push({ ...entry, reason: exclusion.reason });
    }
  }
  if ([...matches.values()].some((count) => count === 0))
    throw new Error("Every source exclusion must match a repository entry");
  return { included, excluded, exclusions: normalized };
}

function readGit(repository, args, input) {
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
}

function repositoryEntries(repository, commit) {
  if (!commitPattern.test(commit)) throw new Error("An exact repository commit is required");
  if (readGit(repository, ["cat-file", "-t", commit]).toString().trim() !== "commit")
    throw new Error("Pinned source identity is not a commit");
  const listing = new TextDecoder("utf-8", { fatal: true }).decode(
    readGit(repository, ["ls-tree", "-rlz", commit]),
  );
  return listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("Invalid Git tree entry");
      const [, mode, type, object, rawSize, name] = match;
      return { name, mode, type, object, size: rawSize === "-" ? null : Number(rawSize) };
    });
}

export function inspectPinnedTree(repository, commit, { exclusions } = {}) {
  const repositoryFiles = repositoryEntries(repository, commit);
  const partition = partitionEntries(repositoryFiles, exclusions);
  const entries = partition.included;
  const bytes = entries.reduce((total, entry) => total + (entry.size ?? 0), 0);
  const unsupported = entries.filter(
    (entry) => !["100644", "100755"].includes(entry.mode) || entry.type !== "blob",
  );
  const largeFiles = entries.filter(
    (entry) => !Number.isSafeInteger(entry.size) || entry.size > maximumFileBytes,
  );
  return {
    commit,
    tree: readGit(repository, ["rev-parse", `${commit}^{tree}`])
      .toString()
      .trim(),
    files: entries.length,
    bytes,
    repositoryFiles: repositoryFiles.length,
    repositoryBytes: repositoryFiles.reduce((total, entry) => total + (entry.size ?? 0), 0),
    excludedEntries: partition.excluded,
    exclusions: partition.exclusions,
    unsupported,
    largeFiles,
    dependencyFiles: entries
      .filter((entry) =>
        /(^|\/)(package\.json|yarn\.lock|pnpm-lock\.yaml|package-lock\.json|pyproject\.toml|uv\.lock|requirements.*\.txt)$/.test(
          entry.name,
        ),
      )
      .map((entry) => entry.name),
    licenseFiles: entries
      .filter((entry) =>
        /(^|\/)(?:(?:[a-z0-9._-]+-)?licen[cs]e(?:[-.][^/]*)?|copying(?:[-.][^/]*)?|unlicense(?:[-.][^/]*)?)$/i.test(
          entry.name,
        ),
      )
      .map((entry) => entry.name),
    sourceCompatible:
      entries.length > 0 &&
      entries.length <= 1000 &&
      bytes <= maximumBytes &&
      partition.excluded.length <= maximumExcludedEntries &&
      unsupported.length === 0 &&
      largeFiles.length === 0,
  };
}

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
  if (snapshot.scope !== undefined) {
    if (
      snapshot.scope?.type !== "repository-tree-with-recorded-exclusions" ||
      !Array.isArray(snapshot.scope.excludedEntries) ||
      !snapshot.scope.excludedEntries.length ||
      snapshot.scope.excludedEntries.length > maximumExcludedEntries
    )
      throw new Error("Invalid excluded repository scope");
    const included = new Set(snapshot.files.map((file) => file.name));
    const excluded = new Set();
    for (const entry of snapshot.scope.excludedEntries) {
      if (
        !safeRelativePath(entry?.name) ||
        included.has(entry.name) ||
        excluded.has(entry.name) ||
        !/^[0-7]{6}$/.test(entry.mode ?? "") ||
        !["blob", "commit"].includes(entry.type) ||
        !commitPattern.test(entry.object ?? "") ||
        !(
          (entry.type === "commit" && entry.size === null) ||
          (entry.type === "blob" && Number.isSafeInteger(entry.size) && entry.size >= 0)
        ) ||
        typeof entry.reason !== "string" ||
        !entry.reason.trim()
      )
        throw new Error("Invalid excluded repository entry");
      excluded.add(entry.name);
    }
  }
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

export function exportPinnedTree(repository, commit, { exclusions } = {}) {
  const partition = partitionEntries(repositoryEntries(repository, commit), exclusions);
  const entries = partition.included;
  const tree = readGit(repository, ["rev-parse", `${commit}^{tree}`])
    .toString()
    .trim();
  for (const entry of entries)
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new Error(`Unsupported repository mode: ${entry.mode}`);
  if (
    entries.length > 1000 ||
    entries.some((entry) => !Number.isSafeInteger(entry.size) || entry.size > maximumFileBytes) ||
    entries.reduce((sum, entry) => sum + entry.size, 0) > maximumBytes
  )
    throw new Error("Repository snapshot exceeds the source size limit");
  const batch = readGit(
    repository,
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
  const content = {
    schemaVersion: 1,
    commit,
    tree,
    ...(partition.excluded.length
      ? {
          scope: {
            type: "repository-tree-with-recorded-exclusions",
            excludedEntries: partition.excluded,
          },
        }
      : {}),
    files,
  };
  return validateRepositorySnapshot({ ...content, sha256: digest(content) });
}
