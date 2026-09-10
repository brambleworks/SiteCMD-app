import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryGraderFiles, repositoryGraderIdentity } from "./repository-grader-identity.mjs";

test("Whoogle grader identity excludes runner files but covers grader dependencies", () => {
  const files = Object.fromEntries(
    repositoryGraderFiles("whoogle-named-config-path").map((name) => [name, `bytes:${name}`]),
  );
  files["guest/run-trial.mjs"] = "old runner";
  const original = repositoryGraderIdentity(files, "whoogle-named-config-path");
  files["guest/run-trial.mjs"] = "new runner";
  assert.equal(repositoryGraderIdentity(files, "whoogle-named-config-path"), original);
  files["guest/whoogle-grader.mjs"] = "changed grader";
  assert.notEqual(repositoryGraderIdentity(files, "whoogle-named-config-path"), original);
});

test("grader identity rejects missing files and unknown cases", () => {
  assert.throws(
    () => repositoryGraderIdentity({}, "whoogle-named-config-path"),
    /Missing grader file/,
  );
  assert.throws(() => repositoryGraderFiles("unknown"), /Unsupported repository grader/);
});

test("confirmatory grader identities include the behavioral adapter and compiler", () => {
  for (const id of [
    "claude-code-templates-shell-boundary",
    "material-search-suggestion-text",
    "yamcs-extension-element-construction",
    "claude-code-templates-loopback-control",
    "liveatlas-entity-decoder-control",
  ]) {
    const selected = repositoryGraderFiles(id);
    assert.ok(selected.includes("guest/confirmatory-grader.mjs"));
    assert.ok(selected.includes("guest/confirmatory-node-candidate.mjs"));
    assert.ok(selected.includes("vendor/typescript.cjs"));
  }
  for (const id of [
    "lightrag-wildcard-cors-credentials",
    "glances-configurable-cors-credentials",
    "sagemaker-triton-tls-verification",
  ]) {
    const python = repositoryGraderFiles(id);
    assert.ok(python.includes("guest/confirmatory-grader.mjs"));
    assert.ok(python.includes("guest/confirmatory-python-candidate.py"));
    assert.ok(!python.includes("vendor/typescript.cjs"));
  }
});
