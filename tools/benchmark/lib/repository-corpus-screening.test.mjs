import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { screenRepositoryCase } from "./repository-corpus-screening.mjs";

function repository(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-corpus-screen-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Corpus test");
  git("config", "user.email", "corpus@example.invalid");
  mkdirSync(path.join(directory, "src"));
  writeFileSync(path.join(directory, "LICENSE"), "Fixture license\n");
  writeFileSync(path.join(directory, "src", "handler.js"), "export const safe = false;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Add baseline");
  const baselineCommit = git("rev-parse", "HEAD");
  writeFileSync(path.join(directory, "src", "handler.js"), "export const safe = true;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Repair handler");
  return { directory, baselineCommit, upstreamCommit: git("rev-parse", "HEAD") };
}

test("screens pinned sources and proves the registered edit changed", (t) => {
  const source = repository(t);
  const item = {
    id: "fixture-repair",
    kind: "repair",
    repository: { id: "fixture", licenseFile: "LICENSE" },
    baselineCommit: source.baselineCommit,
    upstreamCommit: source.upstreamCommit,
    editableFiles: ["src/handler.js"],
  };
  const result = screenRepositoryCase(item, source.directory);
  assert.equal(result.receipt.sourceCompatible, true);
  assert.deepEqual(result.receipt.changedFiles, ["src/handler.js"]);
  assert.match(result.sources.baseline.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.sources.upstream.sha256, /^[a-f0-9]{64}$/);
});

test("records an oversized upstream source as rejected without aborting screening", (t) => {
  const source = repository(t);
  writeFileSync(path.join(source.directory, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
  const commit = spawnSync("git", ["add", "."], {
    cwd: source.directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(commit.status, 0, commit.stderr?.toString());
  const saved = spawnSync("git", ["commit", "--quiet", "-m", "Add oversized source"], {
    cwd: source.directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(saved.status, 0, saved.stderr?.toString());
  const upstreamCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: source.directory,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).stdout.trim();
  const result = screenRepositoryCase(
    {
      id: "oversized-repair",
      kind: "repair",
      repository: { id: "fixture", licenseFile: "LICENSE" },
      baselineCommit: source.upstreamCommit,
      upstreamCommit,
      editableFiles: ["large.bin"],
    },
    source.directory,
  );
  assert.equal(result.receipt.sourceCompatible, false);
  assert.equal(result.sources.upstream, null);
  assert.match(result.receipt.upstream.sourceError, /size limit/);
});

test("accepts an unchanged pinned source as a negative control", (t) => {
  const source = repository(t);
  const result = screenRepositoryCase(
    {
      id: "fixture-control",
      kind: "negative_control",
      repository: { id: "fixture", licenseFile: "LICENSE" },
      baselineCommit: source.upstreamCommit,
      upstreamCommit: source.upstreamCommit,
      editableFiles: ["src/handler.js"],
    },
    source.directory,
  );
  assert.equal(result.receipt.sourceCompatible, true);
  assert.deepEqual(result.receipt.changedFiles, []);
  assert.equal(result.sources.baseline.sha256, result.sources.upstream.sha256);
});

test("records explicit source exclusions and omits their bytes from the snapshot", (t) => {
  const source = repository(t);
  writeFileSync(path.join(source.directory, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
  const staged = spawnSync("git", ["add", "."], {
    cwd: source.directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(staged.status, 0, staged.stderr?.toString());
  const saved = spawnSync("git", ["commit", "--quiet", "-m", "Add excluded fixture"], {
    cwd: source.directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(saved.status, 0, saved.stderr?.toString());
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: source.directory,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).stdout.trim();
  const result = screenRepositoryCase(
    {
      id: "fixture-control",
      kind: "negative_control",
      repository: { id: "fixture", licenseFile: "LICENSE" },
      baselineCommit: commit,
      upstreamCommit: commit,
      editableFiles: ["src/handler.js"],
      sourceExclusions: [
        { path: "large.bin", reason: "Binary fixture is outside the repair surface." },
      ],
    },
    source.directory,
  );
  assert.equal(result.receipt.sourceCompatible, true);
  assert.deepEqual(result.receipt.sourceExclusions, [
    {
      path: "large.bin",
      reason: "Binary fixture is outside the repair surface.",
      baselineEntries: 1,
      upstreamEntries: 1,
    },
  ]);
  assert.equal(
    result.sources.baseline.files.some((file) => file.name === "large.bin"),
    false,
  );
  assert.equal(result.sources.baseline.scope.type, "repository-tree-with-recorded-exclusions");
  assert.equal(result.sources.baseline.scope.excludedEntries.length, 1);
  assert.deepEqual(
    {
      ...result.sources.baseline.scope.excludedEntries[0],
      object: undefined,
    },
    {
      name: "large.bin",
      mode: "100644",
      type: "blob",
      object: undefined,
      size: 16 * 1024 * 1024 + 1,
      reason: "Binary fixture is outside the repair surface.",
    },
  );
  assert.match(result.sources.baseline.scope.excludedEntries[0].object, /^[a-f0-9]{40}$/);
});
