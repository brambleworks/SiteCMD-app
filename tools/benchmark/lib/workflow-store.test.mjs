import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixtureStudy, writeFixtureEvidence } from "./workflow-fixture.mjs";
import { createStudyRun, importTrial, loadResults, appendReview } from "./workflow-store.mjs";
import { collectEvidence, readArtifact } from "./workflow-artifacts.mjs";
import { summarizeModelIdentity } from "./workflow-model-identity.mjs";
import { digest } from "./workflow-plan.mjs";

const CLI = fileURLToPath(new URL("../workflow-benchmark.mjs", import.meta.url));
const checks = {
  acceptance: { status: 0, log: "fixture acceptance log\n" },
  regressions: { status: 0, log: "fixture regression log\n" },
};

function workspace(t, study = fixtureStudy()) {
  const root = mkdtempSync(path.join(tmpdir(), "sitecmd-workflow-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  const plan = createStudyRun(study, run);
  const assignment = plan.assignments[0];
  const input = writeFixtureEvidence(path.join(root, "evidence"), plan, assignment, checks);
  return { root, run, plan, assignment, input };
}

test("trial import copies only referenced evidence and rejects overwrite", (t) => {
  const { root, run, plan, input } = workspace(t);
  writeFileSync(path.join(root, "evidence", "unrelated.txt"), "not benchmark evidence");
  assert.equal(importTrial(run, input), plan.assignments[0].id);
  assert.equal(loadResults(run).length, 1);
  const stored = JSON.parse(
    readFileSync(path.join(run, "trials", plan.assignments[0].id, "record.json")),
  );
  assert.equal(Object.hasOwn(stored.artifacts, "unrelated.txt"), false);
  assert.throws(() => importTrial(run, input), /EEXIST/);
  assert.throws(() => createStudyRun(fixtureStudy(), run), /EEXIST/);
});

test("tampered receipts and patch contents are rejected before import", (t) => {
  const { root, plan, assignment, input } = workspace(t);
  const record = JSON.parse(readFileSync(input));
  const evidenceRoot = path.join(root, "evidence");
  const changed = structuredClone(record);
  changed.submissions[0].acceptancePass = false;
  assert.throws(() => collectEvidence(changed, assignment, plan, evidenceRoot), /receipt/);
  changed.submissions[0].acceptancePass = true;
  changed.usage.costUsd = 0;
  assert.throws(() => collectEvidence(changed, assignment, plan, evidenceRoot), /receipt/);
  writeFileSync(path.join(evidenceRoot, "patch.diff"), "tampered");
  assert.throws(() => collectEvidence(record, assignment, plan, evidenceRoot), /patch digest/);
});

test("model identity receipts are imported and checked against the actual transcript", (t) => {
  const study = fixtureStudy();
  study.configurations[0].agent = "claude";
  const { root, run, plan, assignment, input } = workspace(t, study);
  const record = JSON.parse(readFileSync(input));
  const evidenceRoot = path.join(root, "evidence");
  const transcript = [
    { type: "assistant", message: { id: "fixture-message", model: record.model } },
    { type: "result", subtype: "success", is_error: false },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const identity = summarizeModelIdentity("claude", record.model, transcript, true);
  record.modelSelection = {
    requested: record.model,
    observed: identity.observed,
    source: "explicit-cli-request",
    receipt: "model-identity.json",
    verified: true,
  };
  writeFileSync(path.join(evidenceRoot, record.transcript), transcript);
  writeFileSync(path.join(evidenceRoot, "model-identity.json"), JSON.stringify(identity));
  writeFileSync(input, JSON.stringify(record));
  const artifacts = collectEvidence(record, assignment, plan, evidenceRoot);
  assert.equal(artifacts.has("model-identity.json"), true);
  importTrial(run, input);
  assert.equal(loadResults(run)[0].modelSelection.verified, true);
  identity.observations[0].line = 10;
  writeFileSync(path.join(evidenceRoot, "model-identity.json"), JSON.stringify(identity));
  assert.throws(
    () => collectEvidence(record, assignment, plan, evidenceRoot),
    /model identity.*receipt/,
  );
});

test("repository evidence import verifies captured modes and recomputes integrity", (t) => {
  const study = fixtureStudy();
  const content = {
    schemaVersion: 1,
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    files: [
      { name: "handler.py", mode: "100644", base64: Buffer.from("before").toString("base64") },
      { name: "LICENSE", mode: "100644", base64: Buffer.from("license").toString("base64") },
    ],
  };
  const source = { ...content, sha256: digest(content) };
  study.tasks = [
    {
      ...study.tasks[0],
      sourceFormat: "git-tree-v1",
      sourceSha256: source.sha256,
      editableFiles: ["handler.py"],
    },
  ];
  const { root, plan, assignment, input } = workspace(t, study);
  const directory = path.join(root, "evidence");
  const record = JSON.parse(readFileSync(input));
  const submission = record.submissions[0];
  const candidate = {
    files: {
      "handler.py": Buffer.from("after").toString("base64"),
      LICENSE: content.files[1].base64,
    },
    modes: { "handler.py": "100644", LICENSE: "100644" },
    violations: [],
  };
  submission.candidate = "candidate.json";
  submission.snapshotSha256 = digest(candidate);
  const grade = JSON.parse(readFileSync(path.join(directory, submission.receipt)));
  grade.snapshotSha256 = submission.snapshotSha256;
  const save = () => {
    writeFileSync(path.join(directory, "source.json"), JSON.stringify(source));
    writeFileSync(path.join(directory, submission.candidate), JSON.stringify(candidate));
    writeFileSync(path.join(directory, submission.receipt), JSON.stringify(grade));
  };
  save();
  const artifacts = collectEvidence(record, assignment, plan, directory);
  assert.equal(artifacts.has("candidate.json"), true);
  assert.equal(artifacts.has("source.json"), true);
  candidate.modes["handler.py"] = "100755";
  save();
  assert.throws(() => collectEvidence(record, assignment, plan, directory), /snapshot/);
  submission.snapshotSha256 = digest(candidate);
  grade.snapshotSha256 = submission.snapshotSha256;
  save();
  assert.throws(() => collectEvidence(record, assignment, plan, directory), /integrity/);
  delete submission.candidate;
  assert.throws(() => collectEvidence(record, assignment, plan, directory), /candidate/);
});

test("stored artifacts are rehashed whenever results are loaded", (t) => {
  const { run, assignment, input } = workspace(t);
  importTrial(run, input);
  writeFileSync(path.join(run, "trials", assignment.id, "artifacts", "transcript.txt"), "modified");
  assert.throws(() => loadResults(run), /artifact digests/);
});

test("runtime receipt import requires the identities frozen in the study", (t) => {
  const runtime = { fixture: "Python runtime" };
  const browser = { fixture: "browser runtime" };
  const study = fixtureStudy();
  for (const task of study.tasks) {
    task.runtimeSha256 = digest(runtime);
    task.browserRuntimeSha256 = digest(browser);
  }
  const { root, plan, assignment, input } = workspace(t, study);
  const directory = path.join(root, "evidence");
  const record = JSON.parse(readFileSync(input));
  const files = [
    ["repository-runtime.json", runtime],
    ["browser-runtime.json", browser],
  ];
  for (const [file, receipt] of files)
    writeFileSync(path.join(directory, file), JSON.stringify(receipt));
  for (const [file, receipt] of files) {
    writeFileSync(path.join(directory, file), JSON.stringify({ changed: true }));
    assert.throws(() => collectEvidence(record, assignment, plan, directory), /runtime.*receipt/);
    writeFileSync(path.join(directory, file), JSON.stringify(receipt));
  }
  const artifacts = collectEvidence(record, assignment, plan, directory);
  for (const [file] of files) assert.equal(artifacts.has(file), true);
});

test("artifact traversal, absolute paths, and symlinks are rejected", (t) => {
  const { root } = workspace(t);
  for (const name of ["../outside", "/etc/passwd", "nested/../file", "a//b", "a\\b"]) {
    assert.throws(() => readArtifact(root, name), /artifact path/);
  }
  symlinkSync(path.join(root, "evidence", "trial.json"), path.join(root, "linked.json"));
  assert.throws(() => readArtifact(root, "linked.json"), /symlink/);
});

test("blinded reviews append without rewriting trial evidence", (t) => {
  const { run, assignment, input } = workspace(t);
  const record = JSON.parse(readFileSync(input));
  record.reviews = [];
  writeFileSync(input, JSON.stringify(record));
  importTrial(run, input);
  const storedPath = path.join(run, "trials", assignment.id, "record.json");
  const before = readFileSync(storedPath);
  const review = {
    patchSha256: record.submissions[0].patchSha256,
    reviewer: "independent-reviewer",
    blinded: true,
    decision: "accept",
    reason: "Behavior and regression suite checked",
  };
  appendReview(run, assignment.id, review);
  assert.deepEqual(readFileSync(storedPath), before);
  assert.equal(loadResults(run)[0].reviews.length, 1);
  assert.throws(() => appendReview(run, assignment.id, review), /duplicate reviewer/);
  assert.throws(
    () => appendReview(run, assignment.id, { ...review, reviewer: "other", blinded: false }),
    /blinded/,
  );
});

test("the fixture CLI validates real owned checks without making paid calls", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "sitecmd-workflow-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  const fixture = spawnSync(process.execPath, [CLI, "fixture", "--out", run], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /Recorded 9\/9/);
  assert.match(fixture.stdout, /synthetic test inputs/);
  const validation = JSON.parse(readFileSync(path.join(run, "fixture-validation.json")));
  assert.notEqual(validation.baseline.status, 0);
  assert.equal(validation.baselineRegression.status, 0);
  assert.equal(validation.checks.acceptance.status, 0);
  assert.equal(validation.checks.regressions.status, 0);
  const report = spawnSync(process.execPath, [CLI, "report", "--run", run, "--json"], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).claimReviewReady, false);
  const unknown = spawnSync(process.execPath, [CLI, "report", "--run", run, "--skip-checks"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.notEqual(unknown.status, 0);
});

test("pilot and doctor commands expose limits and blockers without running trials", () => {
  const pilot = spawnSync(process.execPath, [CLI, "pilot"], { encoding: "utf8", timeout: 10000 });
  assert.equal(pilot.status, 0, pilot.stderr);
  const policy = JSON.parse(pilot.stdout);
  assert.equal(policy.caseCount, 5);
  assert.equal(policy.limits.studyCostUsd, 0);
  const doctor = spawnSync(process.execPath, [CLI, "doctor"], {
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: "" },
  });
  assert.equal(doctor.status, 2, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).readyToRun, false);
});

test("the quota CLI cannot pass missing evidence and pilot planning rejects fixture cases", (t) => {
  const { root } = workspace(t);
  const quotaFile = path.join(root, "quota.json");
  writeFileSync(quotaFile, JSON.stringify({ schemaVersion: 1 }));
  const quota = spawnSync(
    process.execPath,
    [CLI, "quota", "--baseline", quotaFile, "--current", quotaFile],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.notEqual(quota.status, 0);
  assert.match(quota.stderr, /capturedAt/);
  const studyFile = path.join(root, "study.json");
  writeFileSync(studyFile, JSON.stringify(fixtureStudy()));
  const plan = spawnSync(
    process.execPath,
    [CLI, "plan", "--pilot", "--study", studyFile, "--out", path.join(root, "pilot")],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.notEqual(plan.status, 0);
  assert.match(plan.stderr, /pilot phase/);
});
