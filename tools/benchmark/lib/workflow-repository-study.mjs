import { readFileSync } from "node:fs";
import { requireCondition, validateStudy } from "./workflow-contract.mjs";
import { canonicalJson } from "./workflow-plan.mjs";

const policy = JSON.parse(
  readFileSync(new URL("../repository-study-policy.json", import.meta.url), "utf8"),
);
export const repositoryStudyPolicy = policy;

function modelSelections(items) {
  return items
    .map(({ agent, model }) => ({ agent, model }))
    .sort(
      (left, right) =>
        left.agent.localeCompare(right.agent) || left.model.localeCompare(right.model),
    );
}

export function validateRepositoryStudy(study) {
  const same = (actual, expected, label) =>
    requireCondition(
      canonicalJson(actual) === canonicalJson(expected),
      `repository study ${label} differs from the approved policy`,
    );
  for (const key of ["phase", "repeats", "arms", "limits", "billing"])
    same(study[key], policy[key], key);
  same(study.id, policy.studyId, "id");
  same(study.tasks?.map(({ id }) => id).sort(), [...policy.caseIds].sort(), "cases");
  same(
    modelSelections(study.configurations ?? []),
    modelSelections(policy.models),
    "model configurations",
  );
  requireCondition(
    study.tasks.every(
      (task) =>
        task.kind === "repair" &&
        task.surface === "code" &&
        task.sourceFormat === "git-tree-v1" &&
        !task.holdout,
    ),
    "repository study cases must be non-held-out Code Scan repairs",
  );
  return validateStudy(study);
}
