import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateRepositoryCorpusIntake } from "./lib/repository-corpus.mjs";
import { deriveRepositoryReference } from "./lib/repository-reference.mjs";
import { validateRepositorySnapshot } from "./lib/repository-snapshot.mjs";
import { artifactPath, readArtifact } from "./lib/workflow-artifacts.mjs";
import { requireCondition } from "./lib/workflow-contract.mjs";
import { digest } from "./lib/workflow-plan.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";

const [screeningDirectory, repository, destination, productFile, runtimeFile, ...extra] =
  process.argv.slice(2);
if (
  !screeningDirectory ||
  !repository ||
  !destination ||
  !productFile ||
  !runtimeFile ||
  extra.length
)
  throw new Error(
    "Usage: qualify-corpus-repository.mjs SCREENING_DIRECTORY REPOSITORY_ID NEW_OUTPUT_DIRECTORY PRODUCT_RECEIPT RUNTIME_RECEIPT",
  );
if (repository !== "flask-reuploaded")
  throw new Error("No corpus qualifier is registered for that repository");
const output = path.resolve(destination);
if (!output.startsWith(path.resolve(workRoot) + path.sep) || existsSync(output))
  throw new Error("Choose an unused qualification directory inside tools/benchmark/.work");
const root = path.dirname(artifactPath(path.resolve(screeningDirectory), "screening.json"));
const intake = validateRepositoryCorpusIntake(
  JSON.parse(readArtifact(root, "intake.json").toString("utf8")),
);
const screening = JSON.parse(readArtifact(root, "screening.json").toString("utf8"));
const registration = JSON.parse(
  readFileSync(new URL("./cases/flask-reuploaded-cases.json", import.meta.url)),
);
const runtimeManifest = JSON.parse(
  readFileSync(new URL("./cases/flask-reuploaded-runtime.json", import.meta.url)),
);
const product = JSON.parse(readFileSync(path.resolve(productFile)));
const runtime = JSON.parse(readFileSync(path.resolve(runtimeFile)));
requireCondition(
  screening.schemaVersion === 1 &&
    screening.corpusId === intake.id &&
    screening.intakeSha256 === digest(intake) &&
    screening.scannerObserved === false &&
    screening.modelCalls === 0 &&
    screening.passed &&
    registration.corpusId === intake.id &&
    registration.intakeSha256 === digest(intake) &&
    registration.repository === repository &&
    registration.runtimeManifestSha256 === digest(runtimeManifest) &&
    runtime.id === registration.runtimeManifestSha256 &&
    digest(runtime.manifest) === registration.runtimeManifestSha256,
  "Corpus, screening, runtime, or case registration identity differs",
);
const items = intake.cases.filter((item) => item.repository.id === repository);
requireCondition(
  JSON.stringify(registration.cases.map((item) => item.id)) ===
    JSON.stringify(items.map((item) => item.id)),
  "Qualification case registration differs from the intake",
);
const sources = {};
for (const [index, item] of items.entries()) {
  const registered = registration.cases[index];
  const receipt = screening.cases.find((candidate) => candidate.id === item.id);
  requireCondition(
    receipt?.sourceCompatible && receipt.originVerified,
    `Case ${item.id} did not pass source screening`,
  );
  const baseline = validateRepositorySnapshot(
    JSON.parse(readArtifact(root, receipt.baselineSource).toString("utf8")),
  );
  const upstream = validateRepositorySnapshot(
    JSON.parse(readArtifact(root, receipt.upstreamSource).toString("utf8")),
  );
  const reference =
    item.kind === "negative_control"
      ? baseline
      : deriveRepositoryReference(
          baseline,
          upstream,
          item.editableFiles,
          registered.reference.regions,
        );
  requireCondition(
    baseline.commit === item.baselineCommit &&
      upstream.commit === item.upstreamCommit &&
      baseline.sha256 === registered.baselineSha256 &&
      upstream.sha256 === registered.upstreamSha256 &&
      reference.sha256 === registered.reference.sha256 &&
      (reference.kind ?? "unchanged") === registered.reference.kind &&
      registered.baselineAcceptancePass === (item.kind === "negative_control") &&
      baseline.files.some((file) => file.name === item.repository.licenseFile) &&
      upstream.files.some((file) => file.name === item.repository.licenseFile),
    `Case ${item.id} source or reference identity differs`,
  );
  sources[item.id] = { baseline, upstream, reference };
}

mkdirSync(output, { mode: 0o700 });
for (const [name, value] of [
  ["intake.json", intake],
  ["screening.json", screening],
  ["registration.json", registration],
  ["runtime-manifest.json", runtimeManifest],
  ["sources.json", sources],
  ["product.json", product],
  ["runtime.json", runtime],
])
  writeNewJson(path.join(output, name), value);
const harness = deployHarness();
writeNewJson(path.join(output, "harness.json"), harness);
process.stdout.write(`Qualifying ${items.length} ${repository} cases in the VM; no model calls.\n`);
const receipt = JSON.parse(
  guestCommand(
    [
      "sudo",
      "flock",
      "--nonblock",
      "/run/sitecmd-benchmark-execution.lock",
      "node",
      `${harness.directory}/qualify-corpus-repository.mjs`,
    ],
    {
      input: JSON.stringify({
        id: randomBytes(16).toString("hex"),
        intake,
        registration,
        sources,
        product,
        runtime,
      }),
      capture: true,
      timeout: 900000,
      maxBuffer: 32 * 1024 * 1024,
    },
  ),
);
receipt.harnessSha256 = harness.id;
writeNewJson(path.join(output, "qualification.json"), receipt);
for (const [caseId, variants] of Object.entries(receipt.results)) {
  const summary = Object.entries(variants)
    .map(
      ([variant, result]) =>
        `${variant} ${result.grades.filter((grade) => grade.acceptancePass).length}/3 acceptance, ${result.grades.filter((grade) => grade.regressionsPass).length}/3 regression, scanner ${result.scan.report ? "recorded" : "failed"}`,
    )
    .join("; ");
  process.stdout.write(`${caseId}: ${summary}\n`);
}
process.stdout.write(`Evidence: ${path.join(output, "qualification.json")}\n`);
if (!receipt.passed) process.exitCode = 1;
