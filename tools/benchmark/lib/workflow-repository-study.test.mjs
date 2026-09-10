import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureStudy } from "./workflow-fixture.mjs";
import { createPlan } from "./workflow-plan.mjs";
import { repositoryStudyPolicy, validateRepositoryStudy } from "./workflow-repository-study.mjs";
import { validateRunnableStudy } from "./workflow-runnable-study.mjs";
import { agentVersions, reasoning } from "./trial-invocation.mjs";

function repositoryStudy() {
  const study = fixtureStudy();
  study.id = repositoryStudyPolicy.studyId;
  study.phase = repositoryStudyPolicy.phase;
  study.billing = structuredClone(repositoryStudyPolicy.billing);
  study.limits = structuredClone(repositoryStudyPolicy.limits);
  study.repeats = repositoryStudyPolicy.repeats;
  study.arms = structuredClone(repositoryStudyPolicy.arms);
  study.configurations = repositoryStudyPolicy.models.map(({ agent, model }) => ({
    id: `${agent}-${model.replaceAll(".", "-")}-${reasoning}`,
    agent,
    model,
    agentVersion: agentVersions[agent],
    reasoning,
    environment: "isolated repository calibration fixture",
  }));
  study.tasks = [
    {
      ...study.tasks[0],
      id: "whoogle-named-config-path",
      repository: "whoogle-search",
      sourceFormat: "git-tree-v1",
      editableFiles: ["app/routes.py"],
    },
  ];
  return study;
}

test("repository calibration freezes Whoogle across four models and three workflows", () => {
  const study = validateRepositoryStudy(repositoryStudy());
  const plan = createPlan(study);
  assert.equal(plan.plannedTrials, 12);
  assert.ok(study.configurations.some(({ model }) => model === "gpt-daybreak-blue-latest"));
  for (const configuration of study.configurations)
    for (const arm of repositoryStudyPolicy.arms)
      assert.equal(
        plan.assignments.filter(
          (assignment) => assignment.configuration === configuration.id && assignment.arm === arm,
        ).length,
        1,
      );
});

test("repository calibration rejects changed models, cases, limits and repeats", () => {
  for (const change of [
    (study) => {
      study.configurations[0].model = "latest";
    },
    (study) => {
      study.tasks.pop();
    },
    (study) => {
      study.limits.trialSeconds = 2400;
    },
    (study) => {
      study.repeats = 2;
    },
    (study) => {
      study.phase = "confirmatory";
    },
  ]) {
    const study = repositoryStudy();
    change(study);
    assert.throws(() => validateRepositoryStudy(study), /repository study/);
  }
});

test("runnable study selection recognizes the frozen repository policy only by id", () => {
  assert.equal(validateRunnableStudy(repositoryStudy()).id, repositoryStudyPolicy.studyId);
  const unknown = repositoryStudy();
  unknown.id = "unregistered-repository-study";
  assert.throws(() => validateRunnableStudy(unknown), /registered execution policy/);
});
