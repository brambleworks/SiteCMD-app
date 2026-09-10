import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readCandidate,
  compareCandidate,
  candidatePatch,
  candidateRecord,
  candidateIdentity,
  materialize,
} from "../guest/trial-snapshot.mjs";

test("snapshots retain untracked binary additions and ignore only Git metadata", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sitecmd-snapshot-"));
  mkdirSync(path.join(directory, ".git"));
  writeFileSync(path.join(directory, ".git", "ignored"), "metadata");
  writeFileSync(path.join(directory, "data.bin"), Buffer.from([0, 255, 5]));
  const result = readCandidate(directory);
  assert.deepEqual(Object.keys(result.files), ["data.bin"]);
  assert.deepEqual(result.files["data.bin"], Buffer.from([0, 255, 5]));
  assert.deepEqual(result.violations, []);
});

test("the 1000-file source allowance does not count parent directories as files", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sitecmd-snapshot-tree-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let index = 0; index < 1000; index++) {
    const parent = path.join(directory, `group-${Math.floor(index / 10)}`);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, `file-${index}.txt`), String(index));
  }
  const result = readCandidate(directory);
  assert.equal(Object.keys(result.files).length, 1000);
});

test("snapshots do not follow symlinks or accept suppression-only changes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sitecmd-snapshot-"));
  symlinkSync("/outside/private", path.join(directory, "escape"));
  const result = readCandidate(directory);
  assert.equal(result.files.escape, undefined);
  assert.ok(result.violations[0].includes("escape"));
  const comparison = compareCandidate(
    { "app.mjs": "ok" },
    { ".sitecmd/config.json": Buffer.from("{}") },
  );
  assert.equal(comparison.passed, false);
});

test("snapshots record executable modes and preserve unusual tracked filenames", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sitecmd-modes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(directory, "run.sh"), 0o755);
  writeFileSync(path.join(directory, "__proto__"), Buffer.from([0, 255, 10]));
  const snapshot = readCandidate(directory);
  assert.equal(snapshot.modes["run.sh"], "100755");
  assert.equal(snapshot.modes.__proto__, "100644");
  assert.equal(Object.hasOwn(snapshot.files, "__proto__"), true);
  assert.deepEqual(snapshot.files.__proto__, Buffer.from([0, 255, 10]));
});

test("candidate patches retain binary bytes and executable-only changes", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sitecmd-mode-patch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = {
    "run.sh": Buffer.from("#!/bin/sh\nexit 0\n"),
    "asset.bin": Buffer.from([0, 255, 10]),
  };
  const candidate = { ...original, "asset.bin": Buffer.from([0, 254, 10]) };
  const patch = candidatePatch(directory, original, candidate, {
    originalModes: { "run.sh": "100755", "asset.bin": "100644" },
    candidateModes: { "run.sh": "100644", "asset.bin": "100644" },
  }).toString();
  assert.match(patch, /old mode 100755\nnew mode 100644/);
  assert.match(patch, /GIT binary patch/);
  assert.deepEqual(
    readFileSync(path.join(directory, "candidate/asset.bin")),
    candidate["asset.bin"],
  );
  assert.equal(statSync(path.join(directory, "original/run.sh")).mode & 0o777, 0o755);
});

test("a repository repair preserves existing hidden configuration under its frozen edit policy", () => {
  const original = {
    "src/handler.py": Buffer.from("before"),
    ".github/workflows/test.yml": Buffer.from("run tests"),
    "tests/test_handler.py": Buffer.from("assert safe"),
    LICENSE: Buffer.from("license"),
    "asset.bin": Buffer.from([0, 255]),
  };
  const candidate = { ...original, "src/handler.py": Buffer.from("after") };
  const result = compareCandidate(original, candidate, [], { editableFiles: ["src/handler.py"] });
  assert.equal(result.passed, true, result.reason);
});

test("registered scope rejects contract edits, empty-file deletion and mode-only changes", () => {
  const original = {
    "src/handler.py": Buffer.from("before"),
    "tests/test_handler.py": Buffer.from("assert safe"),
    ".github/workflows/test.yml": Buffer.from("run tests"),
    LICENSE: Buffer.from(""),
    "run.sh": Buffer.from("exit 0\n"),
  };
  const modes = Object.fromEntries(
    Object.keys(original).map((name) => [name, name === "run.sh" ? "100755" : "100644"]),
  );
  const options = {
    editableFiles: ["src/handler.py"],
    originalModes: modes,
    candidateModes: modes,
  };
  for (const name of [
    "tests/test_handler.py",
    ".github/workflows/test.yml",
    "LICENSE",
    ".sitecmd/config.json",
  ])
    assert.equal(
      compareCandidate(original, { ...original, [name]: Buffer.from("changed") }, [], options)
        .passed,
      false,
      name,
    );
  const withoutLicense = { ...original };
  delete withoutLicense.LICENSE;
  assert.equal(compareCandidate(original, withoutLicense, [], options).passed, false);
  assert.equal(
    compareCandidate(original, original, [], {
      ...options,
      candidateModes: { ...modes, "run.sh": "100644" },
    }).passed,
    false,
  );
});

test("final-candidate identity changes when only executable permissions change", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sitecmd-final-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "run.sh"), "exit 0\n");
  chmodSync(path.join(directory, "run.sh"), 0o755);
  const before = readCandidate(directory);
  chmodSync(path.join(directory, "run.sh"), 0o644);
  const after = readCandidate(directory);
  assert.notEqual(candidateIdentity(before), candidateIdentity(after));
  assert.equal(candidateRecord(before).modes["run.sh"], "100755");
  assert.equal(candidateRecord(before).files["run.sh"], Buffer.from("exit 0\n").toString("base64"));
  assert.throws(() => candidateIdentity({ files: before.files, violations: [] }), /mode/);
});

test("legacy integrity rejects deleting an empty protected test", () => {
  assert.equal(compareCandidate({ "test_empty.py": "" }, {}).passed, false);
});

test("candidate materialization validates all paths and modes before writing", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "sitecmd-materialize-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "candidate");
  assert.throws(() => materialize(target, { valid: "ok", "../escape": "no" }), /path/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(path.join(root, "escape")), false);
  assert.throws(() => materialize(target, { valid: "ok", link: "no" }, { link: "120000" }), /mode/);
  assert.equal(existsSync(target), false);
});
