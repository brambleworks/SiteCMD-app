import path from "node:path";
import { readArtifact } from "./workflow-artifacts.mjs";
import { requireCondition, requireText } from "./workflow-contract.mjs";
import { digest } from "./workflow-plan.mjs";
import { loadPlan, loadResults } from "./workflow-store.mjs";

function comparableStudy(study) {
  const { runnerSha256: _runner, continuation: _continuation, ...contract } = study;
  return {
    ...contract,
    configurations: contract.configurations.map((configuration) => ({
      ...configuration,
      environment: configuration.environment.replace(/; controller [a-f0-9]{64}$/, ""),
    })),
  };
}

export function describeContinuation(sourceRun, study, reason, ancestors = new Set()) {
  const directory = path.resolve(sourceRun);
  requireCondition(
    !ancestors.has(directory) && ancestors.size < 16,
    "Invalid continuation ancestry",
  );
  const source = loadPlan(directory);
  requireText(reason, "continuation reason");
  verifyContinuation(directory, source, ancestors);
  requireCondition(
    digest(comparableStudy(source.study)) === digest(comparableStudy(study)),
    "Continuation changed the cases, models, protocol, environment or limits",
  );
  const records = new Map(loadResults(directory, source).map((record) => [record.trialId, record]));
  requireCondition(
    records.size > 0 && records.size < source.plannedTrials,
    "Continuation requires a partially executed source study",
  );
  const inherited = source.study.continuation;
  const prefix =
    inherited?.retained.map((record) => ({
      ...record,
      studySha256: record.studySha256 ?? inherited.sourceStudySha256,
    })) ?? [];
  const local = source.assignments.slice(0, records.size).map(({ id, ...assignment }) => {
    requireCondition(records.has(id), "Continuation must preserve the complete executed prefix");
    const stored = JSON.parse(readArtifact(directory, `trials/${id}/record.json`));
    return {
      ...assignment,
      trialId: id,
      recordSha256: stored.recordSha256,
      ...(inherited ? { studySha256: source.studySha256 } : {}),
    };
  });
  const baselineSha256 = digest(JSON.parse(readArtifact(directory, "quota-baseline.json")));
  requireCondition(
    readArtifact(directory, "quota-baseline.sha256").toString() === baselineSha256,
    "The original allowance baseline changed",
  );
  return {
    sourceRun: directory,
    sourceStudySha256: source.studySha256,
    baselineSha256,
    reason,
    retained: [...prefix, ...local],
  };
}

export function verifyContinuation(run, plan, ancestors = new Set()) {
  const continuation = plan.study.continuation;
  if (!continuation) return 0;
  const directory = path.resolve(run);
  requireCondition(
    !ancestors.has(directory) && ancestors.size < 16,
    "Invalid continuation ancestry",
  );
  const expected = describeContinuation(
    continuation.sourceRun,
    plan.study,
    continuation.reason,
    new Set([...ancestors, directory]),
  );
  requireCondition(
    digest(expected) === digest(continuation),
    "Retained continuation evidence changed",
  );
  requireCondition(
    digest(JSON.parse(readArtifact(run, "quota-baseline.json"))) === expected.baselineSha256,
    "Continuation must preserve the original allowance",
  );
  return expected.retained.length;
}
