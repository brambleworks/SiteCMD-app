import { requireCondition, requireHash, requireText } from "./workflow-contract.mjs";
import { readArtifact } from "./workflow-artifacts.mjs";
import { digest, validatePlan } from "./workflow-plan.mjs";
import { loadPlan, loadResults } from "./workflow-store.mjs";

export const CONTROLLER_AMENDMENT_FILE = "controller-amendment.json";

const CONTROLLER_FILES = new Set([
  "guest/run-trial.mjs",
  "guest/trial-evidence.mjs",
  "guest/update-quota.mjs",
  "host/run-next.mjs",
  "host/vm-harness.mjs",
  "lib/workflow-controller-amendment.mjs",
  "lib/workflow-quota.mjs",
]);

function runnerChanges(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = names.filter((name) => before[name] !== after[name]);
  requireCondition(changed.length > 0, "Controller amendment requires a runner change");
  requireCondition(
    changed.every((name) => CONTROLLER_FILES.has(name)),
    "Runner changed outside the controller allowlist",
  );
  requireCondition(
    changed.includes("lib/workflow-quota.mjs") && changed.includes("host/run-next.mjs"),
    "Controller amendment must include the quota evaluator and host runner",
  );
  return changed.map((name) => ({
    path: name,
    beforeSha256: before[name] === undefined ? null : digest(before[name]),
    afterSha256: after[name] === undefined ? null : digest(after[name]),
  }));
}

export function buildControllerAmendment({
  plan,
  frozenRunner,
  corrected,
  retained,
  baseline,
  reason,
}) {
  validatePlan(plan);
  requireText(reason, "controller amendment reason");
  requireHash(corrected?.id, "corrected runner digest");
  requireCondition(corrected.id === digest(corrected.files), "Corrected runner digest differs");
  requireCondition(
    plan.study.runnerSha256 === digest(frozenRunner),
    "Frozen runner differs from the study",
  );
  requireCondition(
    Array.isArray(retained) && retained.length > 0 && retained.length < plan.assignments.length,
    "Controller amendment requires a partial executed prefix",
  );
  for (const [index, record] of retained.entries()) {
    requireCondition(
      record.trialId === plan.assignments[index].id,
      "Controller amendment must retain the complete executed prefix",
    );
    requireHash(record.recordSha256, "retained record digest");
  }
  if (plan.study.phase === "confirmatory") {
    const primaryKinds = plan.study.analysis?.primaryKinds;
    requireCondition(
      Array.isArray(primaryKinds) &&
        primaryKinds.length > 0 &&
        retained.every((record) => {
          const assignment = plan.assignments.find((item) => item.id === record.trialId);
          const task = plan.study.tasks.find((item) => item.id === assignment?.task);
          return task && !primaryKinds.includes(task.kind);
        }),
      "A controller amendment cannot follow an assignment from the primary confirmatory population",
    );
  }
  return {
    schemaVersion: 1,
    kind: "quota-controller-correction",
    studySha256: plan.studySha256,
    sourceRunnerSha256: plan.study.runnerSha256,
    correctedRunnerSha256: corrected.id,
    quotaBaselineSha256: digest(baseline),
    reason,
    retained,
    changedFiles: runnerChanges(frozenRunner, corrected.files),
  };
}

function retainedPrefix(run, plan, count) {
  const results = new Map(loadResults(run, plan).map((record) => [record.trialId, record]));
  const length = count ?? results.size;
  requireCondition(
    length > 0 && length <= results.size,
    "Controller amendment retained prefix is unavailable",
  );
  const retained = plan.assignments.slice(0, length).map((assignment) => {
    requireCondition(
      results.has(assignment.id),
      "Controller amendment must retain the complete executed prefix",
    );
    const stored = JSON.parse(readArtifact(run, `trials/${assignment.id}/record.json`));
    return { trialId: assignment.id, recordSha256: stored.recordSha256 };
  });
  if (count === undefined)
    requireCondition(
      !plan.assignments.slice(length).some((assignment) => results.has(assignment.id)),
      "Controller amendment cannot skip an executed assignment",
    );
  return retained;
}

function inputs(run) {
  return {
    plan: loadPlan(run),
    frozenRunner: JSON.parse(readArtifact(run, "inputs/runner.json")),
    baseline: JSON.parse(readArtifact(run, "quota-baseline.json")),
  };
}

export function describeControllerAmendment(run, corrected, reason) {
  const state = inputs(run);
  return buildControllerAmendment({
    ...state,
    corrected,
    retained: retainedPrefix(run, state.plan),
    reason,
  });
}

export function verifyControllerAmendment(run, plan, corrected) {
  const receipt = JSON.parse(readArtifact(run, CONTROLLER_AMENDMENT_FILE));
  const state = inputs(run);
  requireCondition(state.plan.studySha256 === plan.studySha256, "Controller study changed");
  const expected = buildControllerAmendment({
    ...state,
    corrected,
    retained: retainedPrefix(run, plan, receipt.retained?.length),
    reason: receipt.reason,
  });
  requireCondition(digest(receipt) === digest(expected), "Controller amendment receipt changed");
  return receipt;
}
