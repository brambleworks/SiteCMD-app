import { requireCondition } from "./workflow-contract.mjs";
import { canonicalJson } from "./workflow-plan.mjs";

export function buildTrialItem(item, task) {
  for (const key of ["id", "repository", "runtime", "kind"])
    requireCondition(item?.[key] === task?.[key], `Case ${key} differs from the frozen study`);
  requireCondition(typeof item.entry === "string" && item.entry, "Case entry is required");
  const result = {
    id: item.id,
    repository: item.repository,
    entry: item.entry,
    runtime: item.runtime,
    rule: item.rule,
    kind: item.kind,
  };
  if (task.confirmatory === true) {
    requireCondition(item.confirmatory === true, "Confirmatory case marker is missing");
    requireCondition(
      canonicalJson(item.targetFinding) === canonicalJson(task.targetFinding) &&
        item.targetIssue?.checkId === task.targetFinding.checkId &&
        item.targetIssue?.relativePath === task.targetFinding.relativePath &&
        item.targetIssue?.fingerprint === task.targetFinding.fingerprint,
      "Confirmatory case target differs from the frozen study",
    );
    if (task.kind === "negative_control")
      requireCondition(
        /^[a-f0-9]{64}$/.test(item.controlSourceSha256 ?? ""),
        "Confirmatory negative control requires its frozen source identity",
      );
    Object.assign(result, {
      confirmatory: true,
      targetFinding: item.targetFinding,
      targetIssue: item.targetIssue,
      ...(item.controlSourceSha256 ? { controlSourceSha256: item.controlSourceSha256 } : {}),
    });
  }
  for (const key of ["repositoryRuntime", "browserRuntime"])
    if (item[key] !== undefined) result[key] = item[key];
  return result;
}
