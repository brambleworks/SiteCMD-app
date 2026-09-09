import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { validateRepositoryConfirmatoryCorpus } from "./lib/repository-corpus.mjs";
import { evaluateRepositoryScannerCase } from "./lib/repository-scanner-eligibility.mjs";
import { validateRepositorySnapshot } from "./lib/repository-snapshot.mjs";
import { artifactPath, readArtifact } from "./lib/workflow-artifacts.mjs";
import { requireCondition } from "./lib/workflow-contract.mjs";
import { digest } from "./lib/workflow-plan.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";

const [screeningDirectory, eligibilityDirectory, destination, productFile, ...extra] =
  process.argv.slice(2);
if (!screeningDirectory || !eligibilityDirectory || !destination || !productFile || extra.length)
  throw new Error(
    "Usage: qualify-confirmatory-corpus.mjs SCREENING_DIRECTORY ELIGIBILITY_DIRECTORY NEW_OUTPUT_DIRECTORY PRODUCT_RECEIPT",
  );
const output = path.resolve(destination);
requireCondition(
  path.dirname(output) === path.resolve(workRoot) &&
    /^[a-z0-9][a-z0-9.-]*$/.test(path.basename(output)) &&
    !existsSync(output),
  "Qualification output must be a new direct child of tools/benchmark/.work",
);
const screeningRoot = path.dirname(
  artifactPath(path.resolve(screeningDirectory), "screening.json"),
);
const eligibilityRoot = path.dirname(
  artifactPath(path.resolve(eligibilityDirectory), "eligibility.json"),
);
const corpus = validateRepositoryConfirmatoryCorpus(
  JSON.parse(readArtifact(screeningRoot, "intake.json").toString("utf8")),
);
const screening = JSON.parse(readArtifact(screeningRoot, "screening.json").toString("utf8"));
const eligibility = JSON.parse(readArtifact(eligibilityRoot, "eligibility.json").toString("utf8"));
const registration = JSON.parse(
  readArtifact(
    path.dirname(new URL(import.meta.url).pathname),
    "cases/repository-confirmatory-registration.json",
  ).toString("utf8"),
);
const product = JSON.parse(
  readArtifact(path.dirname(path.resolve(productFile)), path.basename(productFile)),
);
requireCondition(
  screening.corpusId === corpus.id &&
    screening.intakeSha256 === digest(corpus) &&
    screening.passed === true &&
    eligibility.corpusId === corpus.id &&
    eligibility.corpusSha256 === digest(corpus) &&
    eligibility.sourceScreeningSha256 === digest(screening) &&
    eligibility.passed === true &&
    eligibility.modelCalls === 0 &&
    registration.corpusId === corpus.id &&
    registration.corpusSha256 === digest(corpus) &&
    registration.eligibilitySha256 === digest(eligibility),
  "Confirmatory source, scanner, and registration identities differ",
);

mkdirSync(output, { mode: 0o700 });
mkdirSync(path.join(output, "cases"), { mode: 0o700 });
const harness = deployHarness();
for (const [name, value] of [
  ["intake.json", corpus],
  ["source-screening.json", screening],
  ["eligibility.json", eligibility],
  ["registration.json", registration],
  ["product.json", product],
  ["harness.json", harness],
])
  writeNewJson(path.join(output, name), value);

const runId = randomBytes(16).toString("hex");
const cases = [];
for (const item of corpus.cases) {
  const source = screening.cases.find((candidate) => candidate.id === item.id);
  const baseline = validateRepositorySnapshot(
    JSON.parse(readArtifact(screeningRoot, source.baselineSource).toString("utf8")),
  );
  const upstream = validateRepositorySnapshot(
    JSON.parse(readArtifact(screeningRoot, source.upstreamSource).toString("utf8")),
  );
  process.stdout.write(`Qualifying ${item.id} three times per variant.\n`);
  const result = JSON.parse(
    guestCommand(
      [
        "sudo",
        "flock",
        "--nonblock",
        "/run/sitecmd-benchmark-execution.lock",
        "node",
        `${harness.directory}/qualify-confirmatory-case.mjs`,
      ],
      {
        input: JSON.stringify({
          runId,
          caseId: item.id,
          corpus,
          screening,
          eligibility,
          registration,
          product,
          baseline,
          upstream,
        }),
        capture: true,
        timeout: 600000,
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  );
  const registered = registration.cases.find((candidate) => candidate.id === item.id);
  const scanner = evaluateRepositoryScannerCase(
    item,
    result.variants.baseline.scan.report,
    result.variants.reference.scan.report,
  );
  const baselinePassed = result.variants.baseline.grades.every(
    (grade) => grade.acceptancePass === registered.baselineAcceptancePass && grade.regressionsPass,
  );
  const referencePassed = result.variants.reference.grades.every(
    (grade) => grade.acceptancePass && grade.regressionsPass,
  );
  const passed = baselinePassed && referencePassed && scanner.eligible;
  const receipt = { ...result, scanner, baselinePassed, referencePassed, passed };
  writeNewJson(path.join(output, "cases", `${item.id}.json`), receipt);
  cases.push(receipt);
  process.stdout.write(`${item.id}: ${passed ? "qualified" : "rejected"}\n`);
}
const receipt = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  corpusId: corpus.id,
  corpusSha256: digest(corpus),
  eligibilitySha256: digest(eligibility),
  registrationSha256: digest(registration),
  purpose: "scanner-enriched confirmatory qualification before repair-agent trials",
  scannerObserved: true,
  modelCalls: 0,
  product: eligibility.product,
  harnessSha256: harness.id,
  cases: cases.map((item) => ({
    id: item.id,
    artifact: `cases/${item.id}.json`,
    sha256: digest(item),
    passed: item.passed,
  })),
  passed: cases.every((item) => item.passed),
};
writeNewJson(path.join(output, "qualification.json"), receipt);
process.stdout.write(`Evidence: ${path.join(output, "qualification.json")}\n`);
if (!receipt.passed) process.exitCode = 1;
