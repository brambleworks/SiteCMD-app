import { validateRepositorySnapshot } from "./repository-snapshot.mjs";
import { requireCondition, requireHash } from "./workflow-contract.mjs";
import { digest } from "./workflow-plan.mjs";

function captureTime(value) {
  requireCondition(
    typeof value === "string" &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Screening capture time must be an ISO timestamp",
  );
  return value;
}

export function createRepositoryCorpusScreening(corpus, screened, capturedAt) {
  const timestamp = captureTime(capturedAt);
  requireCondition(
    screened.length === corpus.cases.length &&
      screened.every((result, index) => result.receipt.id === corpus.cases[index].id),
    "Screening results must preserve the intake case order",
  );
  const sources = new Map();
  const register = (snapshot) => {
    if (!snapshot) return null;
    validateRepositorySnapshot(snapshot);
    requireHash(snapshot.sha256, "repository source digest");
    const artifact = `sources/${snapshot.sha256}.json`;
    sources.set(artifact, snapshot);
    return artifact;
  };
  const cases = screened.map((result) => {
    const baselineSource = register(result.sources.baseline);
    const upstreamSource = register(result.sources.upstream);
    requireCondition(
      !result.receipt.sourceCompatible || (baselineSource && upstreamSource),
      `Compatible case ${result.receipt.id} is missing a source snapshot`,
    );
    return { ...result.receipt, baselineSource, upstreamSource };
  });
  return {
    receipt: {
      schemaVersion: 1,
      corpusId: corpus.id,
      intakeSha256: digest(corpus),
      capturedAt: timestamp,
      scannerObserved: false,
      modelCalls: 0,
      sourceArtifacts: sources.size,
      cases,
      passed: cases.every((item) => item.sourceCompatible),
    },
    sources,
  };
}
