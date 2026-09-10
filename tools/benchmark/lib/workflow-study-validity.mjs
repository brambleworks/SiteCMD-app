import { readFileSync } from "node:fs";
import { requireCondition, requireSlug, requireText } from "./workflow-contract.mjs";

const registry = JSON.parse(
  readFileSync(new URL("../invalidated-studies.json", import.meta.url), "utf8"),
);

requireCondition(
  registry?.schemaVersion === 1,
  "invalidated study registry version is unsupported",
);
requireCondition(Array.isArray(registry.studies), "invalidated study registry is malformed");
for (const study of registry.studies) {
  requireSlug(study?.id, "invalidated study id");
  requireText(study?.reason, `invalidated study ${study?.id ?? "unknown"} reason`);
  requireCondition(
    study.evidenceUse === "diagnostic-only",
    `invalidated study ${study.id} must be diagnostic-only`,
  );
}
requireCondition(
  new Set(registry.studies.map(({ id }) => id)).size === registry.studies.length,
  "invalidated study ids must be unique",
);

export function invalidatedStudy(studyId) {
  return registry.studies.find(({ id }) => id === studyId) ?? null;
}

export function requireStudyRunnable(study) {
  const invalidated = invalidatedStudy(study?.id);
  requireCondition(
    invalidated === null,
    `study ${study?.id ?? "unknown"} is invalidated and retained for diagnostic use only`,
  );
  return study;
}
