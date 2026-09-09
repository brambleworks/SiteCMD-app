import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runtimeTreeDigest } from "./repository-runtime.mjs";

test("Runtime identity covers dependencies and rejects links outside the isolated installation", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-runtime-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "python"));
  mkdirSync(path.join(directory, "environment/venv"), { recursive: true });
  writeFileSync(path.join(directory, "python/interpreter"), "python");
  const dependency = path.join(directory, "environment/venv/django.py");
  writeFileSync(dependency, "original");
  symlinkSync("../../python/interpreter", path.join(directory, "environment/venv/python"));
  const original = runtimeTreeDigest(directory);
  assert.equal(original, runtimeTreeDigest(directory));
  writeFileSync(dependency, "changed");
  assert.notEqual(original, runtimeTreeDigest(directory));
  symlinkSync(os.tmpdir(), path.join(directory, "python/escape"));
  assert.throws(() => runtimeTreeDigest(directory), /outside/);
});
