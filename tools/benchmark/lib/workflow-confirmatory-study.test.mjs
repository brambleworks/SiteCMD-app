import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureStudy } from "./workflow-fixture.mjs";
import { createPlan } from "./workflow-plan.mjs";
import {
  confirmatoryStudyPolicy,
  validateConfirmatoryStudy,
} from "./workflow-confirmatory-study.mjs";
import { validateRunnableStudy } from "./workflow-runnable-study.mjs";
import { agentVersions, reasoning } from "./trial-invocation.mjs";

function confirmatoryStudy() {
  const fixture = fixtureStudy();
  const template = fixture.tasks[0];
  const controlIds = new Set([
    "claude-code-templates-loopback-control",
    "liveatlas-entity-decoder-control",
  ]);
  return {
    ...fixture,
    id: confirmatoryStudyPolicy.studyId,
    phase: confirmatoryStudyPolicy.phase,
    repeats: confirmatoryStudyPolicy.repeats,
    arms: structuredClone(confirmatoryStudyPolicy.arms),
    limits: structuredClone(confirmatoryStudyPolicy.limits),
    billing: structuredClone(confirmatoryStudyPolicy.billing),
    registration: confirmatoryStudyPolicy.registration,
    sampleSizeRationale: confirmatoryStudyPolicy.sampleSizeRationale,
    analysis: structuredClone(confirmatoryStudyPolicy.analysis),
    sitecmd: { ...fixture.sitecmd, dirty: false },
    configurations: confirmatoryStudyPolicy.models.map(({ agent, model }) => ({
      id: `${agent}-${model.replaceAll(".", "-")}-${reasoning}`,
      agent,
      model,
      agentVersion: agentVersions[agent],
      reasoning,
      environment: "isolated confirmatory fixture",
    })),
    tasks: confirmatoryStudyPolicy.caseIds.map((id, index) => ({
      ...template,
      id,
      repository: id.startsWith("claude-code-templates-")
        ? "claude-code-templates"
        : `repository-${index}`,
      kind: controlIds.has(id) ? "negative_control" : "repair",
      holdout: true,
      confirmatory: true,
      scannerObservedAtSelection: true,
      sourceFormat: "git-tree-v1",
      editableFiles: ["src/entry.ts"],
      targetFinding: {
        checkId: "code_scan.unsafe-html",
        relativePath: "src/entry.ts",
        fingerprint: `sha256:${String(index).padStart(64, "0")}`,
      },
      baseline: controlIds.has(id)
        ? { acceptancePass: true, regressionsPass: true }
        : template.baseline,
    })),
  };
}

test("v2 confirmatory policy preserves its 96-assignment design and remains runnable", () => {
  const study = validateConfirmatoryStudy(confirmatoryStudy());
  const plan = createPlan(study);
  assert.equal(plan.plannedTrials, 96);
  assert.equal(study.tasks.filter((task) => task.kind === "repair").length, 6);
  assert.equal(study.tasks.filter((task) => task.kind === "negative_control").length, 2);
  assert.ok(study.configurations.some(({ model }) => model === "gpt-daybreak-blue-latest"));
  assert.equal(validateRunnableStudy(study), study);
});

test("confirmatory policy rejects post-registration changes", () => {
  for (const change of [
    (study) => study.tasks.pop(),
    (study) => {
      study.configurations[0].model = "latest";
    },
    (study) => {
      study.analysis.primaryEndpoint = "final-acceptance";
    },
    (study) => {
      study.limits.trialSeconds = 2400;
    },
    (study) => {
      study.tasks[0].scannerObservedAtSelection = false;
    },
    (study) => {
      study.tasks[0].holdout = false;
    },
  ]) {
    const study = confirmatoryStudy();
    change(study);
    assert.throws(() => validateConfirmatoryStudy(study), /confirmatory study|confirmatory tasks/);
  }
});
