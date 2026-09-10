import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateRepositoryConfirmatoryCorpus } from "./lib/repository-corpus.mjs";
import { createRepositoryScannerEligibility } from "./lib/repository-scanner-eligibility.mjs";
import { validateRepositorySnapshot } from "./lib/repository-snapshot.mjs";
import { artifactPath, readArtifact } from "./lib/workflow-artifacts.mjs";
import { requireCondition } from "./lib/workflow-contract.mjs";
import { digest } from "./lib/workflow-plan.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";

const [screeningDirectory, destination, productFile, ...extra] = process.argv.slice(2);
if (!screeningDirectory || !destination || !productFile || extra.length)
  throw new Error(
    "Usage: screen-repository-findings.mjs SCREENING_DIRECTORY NEW_OUTPUT_DIRECTORY PRODUCT_RECEIPT",
  );
const output = path.resolve(destination);
requireCondition(
  path.dirname(output) === path.resolve(workRoot) &&
    /^[a-z0-9][a-z0-9.-]*$/.test(path.basename(output)) &&
    !existsSync(output),
  "Scanner output must be a new direct child of tools/benchmark/.work",
);
const sourceRoot = path.dirname(artifactPath(path.resolve(screeningDirectory), "screening.json"));
const corpus = validateRepositoryConfirmatoryCorpus(
  JSON.parse(readArtifact(sourceRoot, "intake.json").toString("utf8")),
);
const screening = JSON.parse(readArtifact(sourceRoot, "screening.json").toString("utf8"));
requireCondition(
  screening.corpusId === corpus.id &&
    screening.intakeSha256 === digest(corpus) &&
    screening.passed === true &&
    screening.modelCalls === 0,
  "Source screening does not match the confirmatory corpus",
);
const product = JSON.parse(readFileSync(path.resolve(productFile), "utf8"));
const harness = deployHarness();
const scanned = [];
for (const item of corpus.cases) {
  const source = screening.cases.find((candidate) => candidate.id === item.id);
  requireCondition(
    source?.sourceCompatible && source.originVerified,
    `Case ${item.id} did not pass source screening`,
  );
  const baseline = validateRepositorySnapshot(
    JSON.parse(readArtifact(sourceRoot, source.baselineSource).toString("utf8")),
  );
  const upstream = validateRepositorySnapshot(
    JSON.parse(readArtifact(sourceRoot, source.upstreamSource).toString("utf8")),
  );
  requireCondition(
    baseline.commit === item.baselineCommit && upstream.commit === item.upstreamCommit,
    `Case ${item.id} source commits differ from the corpus`,
  );
  process.stdout.write(`Scanning ${item.id} with the pinned product.\n`);
  const response = JSON.parse(
    guestCommand(
      [
        "sudo",
        "flock",
        "--nonblock",
        "/run/sitecmd-benchmark-execution.lock",
        "node",
        `${harness.directory}/scan-cases.mjs`,
      ],
      {
        input: JSON.stringify({
          cases: [{ id: item.id, baselineSnapshot: baseline, upstreamSnapshot: upstream }],
          product,
        }),
        capture: true,
        timeout: 300000,
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  );
  requireCondition(
    response.length === 1 && response[0].id === item.id,
    `Case ${item.id} scanner response is invalid`,
  );
  scanned.push(response[0]);
}
const eligibility = createRepositoryScannerEligibility(
  corpus,
  screening,
  product,
  scanned,
  new Date().toISOString(),
);
mkdirSync(output, { mode: 0o700 });
mkdirSync(path.join(output, "scans"), { mode: 0o700 });
writeNewJson(path.join(output, "intake.json"), corpus);
writeNewJson(path.join(output, "source-screening.json"), screening);
writeNewJson(path.join(output, "product.json"), product);
writeNewJson(path.join(output, "harness.json"), harness);
for (const [name, bytes] of eligibility.artifacts)
  writeFileSync(path.join(output, name), bytes, { flag: "wx", mode: 0o600 });
writeNewJson(path.join(output, "eligibility.json"), eligibility.receipt);
for (const item of eligibility.receipt.cases)
  process.stdout.write(`${item.id}: ${item.eligible ? "eligible" : item.reasons.join(" ")}\n`);
process.stdout.write(`Evidence: ${path.join(output, "eligibility.json")}\n`);
if (!eligibility.receipt.passed) process.exitCode = 1;
