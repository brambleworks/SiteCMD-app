import assert from "node:assert/strict";
import { test } from "node:test";
import { buildControllerAmendment } from "./workflow-controller-amendment.mjs";
import { fixtureStudy } from "./workflow-fixture.mjs";
import { createPlan, digest } from "./workflow-plan.mjs";

function amendmentFixture(firstKind = "negative_control") {
  const study = fixtureStudy();
  study.phase = "confirmatory";
  study.sitecmd.dirty = false;
  study.registration = "registered controller fixture";
  study.sampleSizeRationale = "Fixture coverage only";
  study.analysis = { primaryKinds: ["repair"] };
  study.tasks = study.tasks.map((task) => ({ ...task, holdout: true }));
  for (let seed = 0; seed < 1000; seed++) {
    study.seed = seed;
    const candidate = createPlan(study);
    const task = study.tasks.find((item) => item.id === candidate.assignments[0].task);
    if (task.kind === firstKind) break;
  }
  const sourceFiles = {
    "lib/workflow-quota.mjs": "old quota",
    "host/run-next.mjs": "old runner",
    "guest/update-quota.mjs": "old updater",
    "host/vm-harness.mjs": "old manifest",
  };
  study.runnerSha256 = digest(sourceFiles);
  const plan = createPlan(study);
  const correctedFiles = {
    ...sourceFiles,
    "lib/workflow-quota.mjs": "rolling quota",
    "host/run-next.mjs": "amendment-aware runner",
    "guest/update-quota.mjs": "continuity updater",
    "host/vm-harness.mjs": "corrected manifest",
    "lib/workflow-controller-amendment.mjs": "amendment verifier",
  };
  const retained = [
    {
      trialId: plan.assignments[0].id,
      recordSha256: digest("retained record"),
    },
  ];
  return {
    plan,
    sourceFiles,
    corrected: { id: digest(correctedFiles), files: correctedFiles },
    retained,
    baseline: { frozen: "allowance" },
  };
}

test("a quota controller amendment preserves the frozen study and nonprimary prefix", () => {
  const fixture = amendmentFixture();
  const receipt = buildControllerAmendment({
    ...fixture,
    frozenRunner: fixture.sourceFiles,
    reason: "Account for a rolling provider window without rerunning trials",
  });
  assert.equal(receipt.sourceRunnerSha256, fixture.plan.study.runnerSha256);
  assert.equal(receipt.correctedRunnerSha256, fixture.corrected.id);
  assert.equal(receipt.studySha256, fixture.plan.studySha256);
  assert.deepEqual(receipt.retained, fixture.retained);
  assert.equal(receipt.quotaBaselineSha256, digest(fixture.baseline));
  assert.ok(receipt.changedFiles.some((item) => item.path === "lib/workflow-quota.mjs"));
});

test("a controller amendment rejects treatment changes and primary assignments", () => {
  const changed = amendmentFixture();
  changed.corrected.files["guest/trial-prompt.mjs"] = "changed treatment";
  changed.corrected.id = digest(changed.corrected.files);
  assert.throws(
    () =>
      buildControllerAmendment({
        ...changed,
        frozenRunner: changed.sourceFiles,
        reason: "Invalid correction",
      }),
    /outside the controller allowlist/,
  );

  const primary = amendmentFixture("repair");
  assert.throws(
    () =>
      buildControllerAmendment({
        ...primary,
        frozenRunner: primary.sourceFiles,
        reason: "Invalid correction",
      }),
    /primary confirmatory population/,
  );
});
