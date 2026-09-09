import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  exportPinnedTree,
  inspectPinnedTree,
  materializeRepositorySnapshot,
  validateRepositorySnapshot,
} from "./repository-snapshot.mjs";
import { digest } from "./workflow-plan.mjs";

function repository(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-source-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Benchmark test");
  git("config", "user.email", "benchmark@example.invalid");
  mkdirSync(path.join(directory, ".github"));
  writeFileSync(path.join(directory, ".github/config.yml"), "enabled: true\n");
  writeFileSync(path.join(directory, ".gitattributes"), "LICENSE export-ignore\n");
  writeFileSync(path.join(directory, "LICENSE"), "Fixture license\n");
  writeFileSync(path.join(directory, "image.bin"), Buffer.from([0, 255, 10, 128]));
  writeFileSync(path.join(directory, "test project.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(directory, "test project.sh"), 0o755);
  git("add", ".");
  git("commit", "--quiet", "-m", "Create test repository");
  return { directory, git, commit: git("rev-parse", "HEAD") };
}

test("pinned trees preserve binary data, executable modes, hidden files and licenses", (t) => {
  const { directory, commit } = repository(t);
  writeFileSync(path.join(directory, "LICENSE"), "Uncommitted replacement\n");
  writeFileSync(path.join(directory, "untracked.txt"), "not source\n");
  const snapshot = exportPinnedTree(directory, commit);
  assert.equal(snapshot.commit, commit);
  assert.equal(snapshot.files.length, 5);
  assert.equal(validateRepositorySnapshot(snapshot), snapshot);
  const entries = Object.fromEntries(snapshot.files.map((file) => [file.name, file]));
  assert.equal(Buffer.from(entries.LICENSE.base64, "base64").toString(), "Fixture license\n");
  assert.deepEqual(
    Buffer.from(entries["image.bin"].base64, "base64"),
    Buffer.from([0, 255, 10, 128]),
  );
  assert.equal(entries["test project.sh"].mode, "100755");
  assert.ok(entries[".github/config.yml"]);
  assert.equal(exportPinnedTree(directory, commit).sha256, snapshot.sha256);
});

test("source inspection reports compatibility and provenance without exporting bytes", (t) => {
  const { directory, commit } = repository(t);
  const inspection = inspectPinnedTree(directory, commit);
  assert.equal(inspection.commit, commit);
  assert.equal(inspection.files, 5);
  assert.ok(inspection.bytes > 0);
  assert.equal(inspection.sourceCompatible, true);
  assert.deepEqual(inspection.licenseFiles, ["LICENSE"]);
  assert.deepEqual(inspection.dependencyFiles, []);
});

test("source inspection recognizes a license with an SPDX family prefix", (t) => {
  const { directory, git } = repository(t);
  git("mv", "LICENSE", "AGPL-LICENSE.txt");
  git("commit", "--quiet", "-m", "Use explicit license filename");
  const inspection = inspectPinnedTree(directory, git("rev-parse", "HEAD"));
  assert.deepEqual(inspection.licenseFiles, ["AGPL-LICENSE.txt"]);
});

test("tree export rejects floating revisions and unsupported entries", (t) => {
  const { directory, commit, git } = repository(t);
  assert.throws(() => exportPinnedTree(directory, "HEAD"), /commit/);
  git("update-index", "--add", "--cacheinfo", `160000,${commit},submodule`);
  git("commit", "--quiet", "-m", "Add unsupported submodule");
  assert.throws(() => exportPinnedTree(directory, git("rev-parse", "HEAD")), /mode/);
});

test("materializing a pinned tree preserves bytes and modes without overwriting a directory", (t) => {
  const { directory, commit } = repository(t);
  const snapshot = exportPinnedTree(directory, commit);
  const destination = path.join(directory, "materialized");
  const previousMask = process.umask(0o077);
  try {
    materializeRepositorySnapshot(snapshot, destination);
  } finally {
    process.umask(previousMask);
  }
  assert.equal(statSync(path.join(destination, ".github")).mode & 0o777, 0o755);
  for (const file of snapshot.files) {
    const target = path.join(destination, file.name);
    assert.deepEqual(readFileSync(target), Buffer.from(file.base64, "base64"));
    assert.equal(statSync(target).mode & 0o777, file.mode === "100755" ? 0o755 : 0o644);
  }
  assert.throws(() => materializeRepositorySnapshot(snapshot, destination), /EEXIST/);
});

test("snapshot validation rejects changed bytes, permissions and unsafe paths", (t) => {
  const { directory, commit } = repository(t);
  const original = exportPinnedTree(directory, commit);
  for (const update of [
    (value) => (value.files[0].base64 = "bmV3"),
    (value) => (value.files[0].mode = "100755"),
    (value) => (value.files[0].name = "../escape"),
    (value) => (value.files[0].name = "/absolute"),
    (value) => (value.files[0].name = ".git/config"),
    (value) => (value.files[0].name = "foo\\bar"),
    (value) => (value.files[0].name = "foo\nbar"),
    (value) => (value.files[0].base64 += "!"),
    (value) => (value.files[0].mode = "120000"),
    (value) => value.files.push(value.files[0]),
    (value) => (value.commit = "main"),
  ]) {
    const changed = structuredClone(original);
    update(changed);
    assert.throws(() => validateRepositorySnapshot(changed));
  }
});

test("validates a snapshot with hash-recorded excluded repository entries", () => {
  const data = {
    schemaVersion: 1,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    scope: {
      type: "repository-tree-with-recorded-exclusions",
      excludedEntries: [
        {
          name: "fixtures/screenshot.png",
          mode: "100644",
          type: "blob",
          object: "c".repeat(40),
          size: 1024,
          reason: "Visual fixture is outside the repair surface.",
        },
      ],
    },
    files: [{ name: "src/app.ts", mode: "100644", base64: Buffer.from("app").toString("base64") }],
  };
  const snapshot = { ...data, sha256: digest(data) };
  assert.equal(validateRepositorySnapshot(snapshot), snapshot);
  snapshot.scope.excludedEntries[0].name = "src/app.ts";
  const { sha256: _sha256, ...changed } = snapshot;
  snapshot.sha256 = digest(changed);
  assert.throws(() => validateRepositorySnapshot(snapshot), /excluded/i);
});

test("validates recorded exclusions from a large public repository", () => {
  const data = {
    schemaVersion: 1,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    scope: {
      type: "repository-tree-with-recorded-exclusions",
      excludedEntries: Array.from({ length: 15_001 }, (_, index) => ({
        name: `catalog/${index.toString().padStart(5, "0")}.md`,
        mode: "100644",
        type: "blob",
        object: index.toString(16).padStart(40, "0"),
        size: 100,
        reason: "Catalog content is outside the repair surface.",
      })),
    },
    files: [{ name: "src/app.ts", mode: "100644", base64: Buffer.from("app").toString("base64") }],
  };
  const snapshot = { ...data, sha256: digest(data) };
  assert.equal(validateRepositorySnapshot(snapshot), snapshot);
});
