import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { exportPinnedTree } from "./lib/repository-snapshot.mjs";
import { deriveRepositoryReference } from "./lib/repository-reference.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";

const args = process.argv.slice(2);
const workflow = args[0] === "--workflow";
if (workflow) args.shift();
const linkding = args[0] === "--linkding";
if (linkding) args.shift();
const [repository, destination, productFile, runtimeFile, ...extra] = args;
if (
  !repository ||
  !destination ||
  !productFile ||
  extra.length ||
  (linkding ? !runtimeFile : runtimeFile)
)
  throw new Error(
    "Usage: node tools/benchmark/qualify-repository.mjs [--workflow] [--linkding] SOURCE_GIT NEW_OUTPUT_DIRECTORY PRODUCT_RECEIPT [LINKDING_RUNTIME_RECEIPT]",
  );
const output = path.resolve(destination);
if (!output.startsWith(path.resolve(workRoot) + path.sep))
  throw new Error("Qualification evidence must stay in tools/benchmark/.work");
const definition = JSON.parse(
  readFileSync(
    new URL(`./cases/${linkding ? "linkding" : "repository"}-calibration.json`, import.meta.url),
  ),
);
const product = JSON.parse(readFileSync(productFile));
const runtime = linkding ? JSON.parse(readFileSync(runtimeFile)) : undefined;
const sources = {};
for (const variant of ["baseline", linkding ? "upstream" : "reference"]) {
  sources[variant] = exportPinnedTree(path.resolve(repository), definition[variant].commit);
  if (sources[variant].sha256 !== definition[variant].sha256)
    throw new Error(`Pinned ${variant} source digest mismatch`);
}
if (linkding) {
  sources.reference = deriveRepositoryReference(
    sources.baseline,
    sources.upstream,
    definition.editableFiles,
  );
  if (sources.reference.sha256 !== definition.reference.sha256)
    throw new Error("Derived reference differs from the pinned case");
}
mkdirSync(output, { mode: 0o700 });
writeNewJson(path.join(output, "definition.json"), definition);
writeNewJson(path.join(output, "sources.json"), sources);
writeNewJson(path.join(output, "product.json"), product);
if (runtime) writeNewJson(path.join(output, "runtime.json"), runtime);
const harness = deployHarness();
writeNewJson(path.join(output, "harness.json"), harness);
const id = randomBytes(16).toString("hex");
console.log(
  `${workflow ? "Checking desktop workflows for" : "Qualifying"} ${definition.id} in the VM; no model calls.`,
);
const receipt = JSON.parse(
  guestCommand(
    [
      "sudo",
      "flock",
      "--nonblock",
      "/run/sitecmd-benchmark-execution.lock",
      "node",
      `${harness.directory}/${workflow ? "repository-workflow" : "qualify-repository"}.mjs`,
    ],
    {
      input: JSON.stringify({ id, definition, sources, product, runtime }),
      capture: true,
      timeout: 600000,
      maxBuffer: 32 * 1024 * 1024,
    },
  ),
);
receipt.harnessSha256 = harness.id;
const receiptFile = path.join(output, workflow ? "workflow.json" : "qualification.json");
writeNewJson(receiptFile, receipt);
if (workflow) {
  for (const result of receipt.results)
    console.log(
      `${result.arm}: ${result.status}; source preserved: ${result.sourceUnchanged}; prompt released: ${result.prompt !== null}`,
    );
  console.log(`Evidence: ${receiptFile}`);
  if (!receipt.passed) process.exitCode = 1;
} else {
  for (const [variant, result] of Object.entries(receipt.results))
    console.log(
      `${variant}: ${result.grades.filter((grade) => grade.acceptancePass).length}/3 acceptance, ${result.grades.filter((grade) => grade.regressionsPass).length}/3 regression; scanner ${result.scan.report ? "recorded" : "failed"}`,
    );
  console.log(`Evidence: ${receiptFile}`);
  if (!receipt.passed || Object.values(receipt.results).some((result) => !result.scan.report))
    process.exitCode = 1;
}
