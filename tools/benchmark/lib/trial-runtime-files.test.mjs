import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureRuntimeFiles,
  prepareRuntimeFiles,
  withoutRuntimeFiles,
} from "../guest/trial-runtime-files.mjs";
import { compareCandidate, readCandidate } from "../guest/trial-snapshot.mjs";

test("shell protection files are captured before the prompt and do not become candidate edits", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-runtime-"));
  const original = { "app.mjs": "original source" };
  try {
    writeFileSync(path.join(directory, "app.mjs"), original["app.mjs"]);
    prepareRuntimeFiles(directory, original);
    const before = readCandidate(directory);
    const runtime = captureRuntimeFiles(original, before);
    assert.ok(runtime.includes(".bashrc"));
    assert.ok(runtime.includes(".mcp.json"));
    assert.ok(runtime.includes("scripts"));
    const normalized = withoutRuntimeFiles(readCandidate(directory).files, runtime);
    assert.deepEqual(Object.keys(normalized), ["app.mjs"]);
    assert.equal(compareCandidate(original, normalized).passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preparation covers protection files that the sandbox can create lazily", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-runtime-"));
  try {
    prepareRuntimeFiles(directory, {});
    const runtime = captureRuntimeFiles({}, readCandidate(directory));
    assert.ok(runtime.includes(".gitmodules"));
    assert.ok(runtime.includes(".env"));
    assert.ok(runtime.includes("package.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only known empty files captured before the prompt can be ignored", () => {
  const original = { "app.mjs": "original source" };
  const files = { "app.mjs": Buffer.from(original["app.mjs"]), ".env": Buffer.alloc(0) };
  const runtime = captureRuntimeFiles(original, { files, violations: [] });
  assert.deepEqual(runtime, [".env"]);
  assert.deepEqual(Object.keys(withoutRuntimeFiles(files, runtime)), ["app.mjs"]);
  files[".env"] = Buffer.from("modified");
  assert.ok(withoutRuntimeFiles(files, runtime)[".env"]);
});

test("unknown initialization files, changed source, nonempty files and links are rejected", () => {
  const original = { "app.mjs": "source" };
  for (const snapshot of [
    { files: { "app.mjs": Buffer.from("changed") }, violations: [] },
    { files: { "app.mjs": Buffer.from("source"), "unknown.txt": Buffer.alloc(0) }, violations: [] },
    {
      files: { "app.mjs": Buffer.from("source"), ".env": Buffer.from("not empty") },
      violations: [],
    },
    { files: { "app.mjs": Buffer.from("source") }, violations: ["Unsafe link"] },
  ])
    assert.throws(() => captureRuntimeFiles(original, snapshot));
});

test("preparation preserves existing content and does not authorize links or nonempty guards", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-runtime-"));
  try {
    writeFileSync(path.join(directory, "app.mjs"), "original source");
    writeFileSync(path.join(directory, ".bashrc"), "unexpected command");
    symlinkSync(path.join(directory, "app.mjs"), path.join(directory, ".zshrc"));
    prepareRuntimeFiles(directory, { "app.mjs": "original source" });
    assert.equal(readFileSync(path.join(directory, ".bashrc"), "utf8"), "unexpected command");
    assert.equal(readFileSync(path.join(directory, "app.mjs"), "utf8"), "original source");
    assert.throws(
      () => captureRuntimeFiles({ "app.mjs": "original source" }, readCandidate(directory)),
      /Unsafe/,
    );
    const changed = { ".mcp.json": Buffer.from("not empty") };
    assert.equal(compareCandidate({}, withoutRuntimeFiles(changed, [".mcp.json"])).passed, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initialization cannot change tracked modes or hide executable runtime files", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-runtime-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = { "run.sh": "exit 0\n" };
  writeFileSync(path.join(directory, "run.sh"), original["run.sh"]);
  assert.throws(
    () => captureRuntimeFiles(original, readCandidate(directory), { "run.sh": "100755" }),
    /mode/,
  );
  chmodSync(path.join(directory, "run.sh"), 0o755);
  prepareRuntimeFiles(directory, original);
  const before = readCandidate(directory);
  const runtime = captureRuntimeFiles(original, before, { "run.sh": "100755" });
  chmodSync(path.join(directory, ".bashrc"), 0o755);
  const changed = readCandidate(directory);
  assert.equal(
    Object.hasOwn(withoutRuntimeFiles(changed.files, runtime, changed.modes), ".bashrc"),
    true,
  );
});
