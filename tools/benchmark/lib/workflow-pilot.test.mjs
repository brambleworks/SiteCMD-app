import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureStudy } from "./workflow-fixture.mjs";
import { pilotPolicy, validatePilotStudy } from "./workflow-pilot.mjs";
import { trialConfigurations } from "./trial-invocation.mjs";
import { createPlan } from "./workflow-plan.mjs";

function studyForPolicyTest() {
  const study = fixtureStudy();
  study.phase = "calibration";
  study.billing = structuredClone(pilotPolicy.billing);
  study.limits = structuredClone(pilotPolicy.limits);
  study.configurations = trialConfigurations(study.configurations[0].environment);
  study.tasks.push(...["c", "d"].map((id) => ({ ...study.tasks[0], id: `repair-${id}` })));
  return study;
}

test("pilot planning rejects model fallback, extra trials, and weakened limits", () => {
  assert.equal(validatePilotStudy(studyForPolicyTest()).tasks.length, 5);
  for (const change of [
    (study) => {
      study.configurations[0].model = "latest";
    },
    (study) => {
      study.tasks.pop();
    },
    (study) => {
      study.tasks[2].kind = "repair";
    },
    (study) => {
      study.repeats = 2;
    },
    (study) => {
      study.limits.trialSeconds = 2400;
    },
    (study) => {
      study.billing.weeklyBudgetPercentagePoints = 50;
    },
    (study) => {
      study.phase = "confirmatory";
    },
  ]) {
    const study = studyForPolicyTest();
    change(study);
    assert.throws(() => validatePilotStudy(study), /pilot/);
  }
});

test("the pilot balances all workflows for each model with independent configuration IDs", () => {
  const study = studyForPolicyTest();
  const plan = createPlan(validatePilotStudy(study));
  assert.equal(plan.plannedTrials, 45);
  assert.equal(new Set(study.configurations.map(({ id }) => id)).size, 3);
  for (const configuration of study.configurations) {
    for (const arm of pilotPolicy.arms) {
      assert.equal(
        plan.assignments.filter(
          (item) => item.configuration === configuration.id && item.arm === arm,
        ).length,
        5,
      );
    }
  }
  study.configurations.reverse();
  assert.doesNotThrow(() => validatePilotStudy(study));
  study.configurations[0].model = "claude-fable-5-1";
  assert.throws(() => validatePilotStudy(study), /model configurations/);
});
