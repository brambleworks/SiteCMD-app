import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlan, digest } from "./workflow-plan.mjs";
import { loadTrialSource } from "./trial-source.mjs";
import { fixtureStudy } from "./workflow-fixture.mjs";

function source() {
  const content = {
    schemaVersion: 1,
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    files: [
      { name: "src/handler.py", mode: "100644", base64: Buffer.from("before").toString("base64") },
      { name: "run.sh", mode: "100755", base64: Buffer.from("exit 0\n").toString("base64") },
      { name: "asset.bin", mode: "100644", base64: Buffer.from([0, 255]).toString("base64") },
      {
        name: ".github/workflows/test.yml",
        mode: "100644",
        base64: Buffer.from("test").toString("base64"),
      },
    ],
  };
  return { ...content, sha256: digest(content) };
}

test("repository trial sources decode pinned bytes, modes and the registered edit scope", () => {
  const snapshot = source();
  const task = {
    sourceFormat: "git-tree-v1",
    sourceSha256: snapshot.sha256,
    editableFiles: ["src/handler.py"],
  };
  const loaded = loadTrialSource(snapshot, task);
  assert.deepEqual(loaded.files["asset.bin"], Buffer.from([0, 255]));
  assert.equal(loaded.modes["run.sh"], "100755");
  assert.deepEqual(loaded.editableFiles, ["src/handler.py"]);
  assert.equal(Object.keys(loaded.files).length, 4);
});

test("repository source loading requires an exact registered edit policy and snapshot", () => {
  const snapshot = source();
  const task = {
    sourceFormat: "git-tree-v1",
    sourceSha256: snapshot.sha256,
    editableFiles: ["src/handler.py"],
  };
  for (const editableFiles of [
    undefined,
    ["../escape"],
    ["missing.py"],
    ["src/handler.py", "src/handler.py"],
  ])
    assert.throws(() => loadTrialSource(snapshot, { ...task, editableFiles }), /edit/);
  assert.throws(
    () => loadTrialSource(snapshot, { ...task, sourceSha256: "0".repeat(64) }),
    /source/,
  );
  const changed = structuredClone(snapshot);
  changed.files[0].mode = "100755";
  assert.throws(() => loadTrialSource(changed, task), /digest/);
  assert.throws(() => loadTrialSource(snapshot, { ...task, sourceFormat: "unknown" }), /format/);
  const legacy = { "app.mjs": "source" };
  assert.deepEqual(
    loadTrialSource(legacy, { sourceSha256: digest(legacy) }).files["app.mjs"],
    Buffer.from("source"),
  );
});

test("study registration rejects repository tasks without an explicit edit policy", () => {
  for (const fields of [
    { sourceFormat: "git-tree-v1" },
    { sourceFormat: "unknown", editableFiles: [] },
    { editableFiles: ["handler.py"] },
    { sourceFormat: "git-tree-v1", editableFiles: ["handler.py", "handler.py"] },
  ]) {
    const study = fixtureStudy();
    Object.assign(study.tasks[0], fields);
    assert.throws(() => createPlan(study), /source|edit/);
  }
});
