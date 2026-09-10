import { readFileSync } from "node:fs";
import { requireCondition, validateStudy } from "./workflow-contract.mjs";
import { canonicalJson } from "./workflow-plan.mjs";

const policy = JSON.parse(
  readFileSync(new URL("../confirmatory-study-policy.json", import.meta.url), "utf8"),
);
export const confirmatoryStudyPolicy = policy;

function selections(items) {
  return items
    .map(({ agent, model }) => ({ agent, model }))
    .sort(
      (left, right) =>
        left.agent.localeCompare(right.agent) || left.model.localeCompare(right.model),
    );
}

export function validateConfirmatoryStudy(study) {
  const same = (actual, expected, label) =>
    requireCondition(
      canonicalJson(actual) === canonicalJson(expected),
      `confirmatory study ${label} differs from the registered policy`,
    );
  same(study?.id, policy.studyId, "id");
  for (const key of [
    "phase",
    "repeats",
    "arms",
    "limits",
    "billing",
    "registration",
    "sampleSizeRationale",
    "analysis",
  ])
    same(study?.[key], policy[key], key);
  same(study?.tasks?.map(({ id }) => id).sort(), [...policy.caseIds].sort(), "cases");
  same(selections(study?.configurations ?? []), selections(policy.models), "models");
  requireCondition(
    study.tasks.filter((task) => task.kind === "repair").length === 6 &&
      study.tasks.filter((task) => task.kind === "negative_control").length === 2 &&
      study.tasks.every(
        (task) =>
          task.confirmatory === true &&
          task.scannerObservedAtSelection === true &&
          task.holdout === true &&
          task.surface === "code" &&
          task.sourceFormat === "git-tree-v1" &&
          /^code_scan\.[a-z0-9.-]+$/.test(task.targetFinding?.checkId ?? "") &&
          typeof task.targetFinding?.relativePath === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(task.targetFinding?.fingerprint ?? ""),
      ),
    "confirmatory study tasks differ from the registered scanner-enriched design",
  );
  return validateStudy(study);
}
