import { existsSync } from "node:fs";
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

const [screeningDirectory, repository, destination, ...extra] = process.argv.slice(2);
if (!screeningDirectory || !repository || !destination || extra.length)
  throw new Error(
    "Usage: prepare-corpus-runtime.mjs SCREENING_DIRECTORY REPOSITORY_ID NEW_RUNTIME_RECEIPT",
  );
if (repository !== "flask-reuploaded")
  throw new Error("No frozen corpus runtime is registered for that repository");
const output = path.resolve(destination);
if (!output.startsWith(path.resolve(workRoot) + path.sep) || existsSync(output))
  throw new Error("Choose an unused runtime receipt path inside tools/benchmark/.work");
const evidence = artifactPath(path.resolve(screeningDirectory), "screening.json");
const root = path.dirname(evidence);
const intake = validateRepositoryCorpusIntake(
  JSON.parse(readArtifact(root, "intake.json").toString("utf8")),
);
const screening = JSON.parse(readArtifact(root, "screening.json").toString("utf8"));
const definition = JSON.parse(
  readArtifact(
    path.dirname(new URL(import.meta.url).pathname),
    "cases/flask-reuploaded-cases.json",
  ).toString("utf8"),
);
const manifest = JSON.parse(
  readArtifact(
    path.dirname(new URL(import.meta.url).pathname),
    "cases/flask-reuploaded-runtime.json",
  ).toString("utf8"),
);
requireCondition(
  screening.schemaVersion === 1 &&
    screening.corpusId === intake.id &&
    screening.intakeSha256 === digest(intake) &&
    screening.scannerObserved === false &&
    screening.modelCalls === 0 &&
    screening.passed &&
    definition.corpusId === intake.id &&
    definition.intakeSha256 === digest(intake) &&
    definition.repository === repository &&
    definition.runtimeManifestSha256 === digest(manifest) &&
    manifest.repository === repository &&
    manifest.screeningIntakeSha256 === digest(intake),
  "Corpus screening, case definition, or runtime manifest identity differs",
);
const items = intake.cases.filter((item) => item.repository.id === repository);
requireCondition(
  JSON.stringify(definition.cases.map((item) => item.id)) ===
    JSON.stringify(items.map((item) => item.id)),
  "Runtime case registration differs from the intake",
);
for (const [index, item] of items.entries()) {
  const registered = definition.cases[index];
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
  requireCondition(
    baseline.commit === item.baselineCommit &&
      upstream.commit === item.upstreamCommit &&
      baseline.sha256 === registered.baselineSha256 &&
      upstream.sha256 === registered.upstreamSha256 &&
      baseline.files.some((file) => file.name === item.repository.licenseFile) &&
      upstream.files.some((file) => file.name === item.repository.licenseFile),
    `Case ${item.id} source identity differs`,
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
    reference.sha256 === registered.reference.sha256 &&
      (reference.kind ?? "unchanged") === registered.reference.kind &&
      registered.baselineAcceptancePass === (item.kind === "negative_control"),
    `Case ${item.id} reference identity differs`,
  );
  for (const source of [baseline, upstream]) {
    const pyproject = source.files.find((file) => file.name === "pyproject.toml");
    requireCondition(
      pyproject &&
        digest(Buffer.from(pyproject.base64, "base64")) ===
          manifest.sourcePyprojects[source.commit],
      `Case ${item.id} dependency metadata differs`,
    );
  }
}

const harness = deployHarness();
process.stdout.write("Preparing Flask-Reuploaded's isolated, locked runtime; no model calls.\n");
const runtime = JSON.parse(
  guestCommand(
    [
      "sudo",
      "flock",
      "--nonblock",
      "/run/sitecmd-benchmark-execution.lock",
      "node",
      `${harness.directory}/install-flask-reuploaded-runtime.mjs`,
    ],
    { capture: true, timeout: 1000000, maxBuffer: 8 * 1024 * 1024 },
  ),
);
writeNewJson(output, runtime);
writeNewJson(`${output}.harness.json`, harness);
process.stdout.write(`Runtime receipt: ${output}\n`);
