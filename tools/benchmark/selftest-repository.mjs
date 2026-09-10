import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { exportPinnedTree } from "./lib/repository-snapshot.mjs";
import { deriveRepositoryReference } from "./lib/repository-reference.mjs";
import { fixtureStudy } from "./lib/workflow-fixture.mjs";
import { pilotPolicy } from "./lib/workflow-pilot.mjs";
import { digest } from "./lib/workflow-plan.mjs";
import { createStudyRun, writeNewJson } from "./lib/workflow-store.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { exportGuestTrial } from "./lib/vm-trial-export.mjs";

const args = process.argv.slice(2);
const linkding = args[0] === "--linkding";
if (linkding) args.shift();
const whoogle = args[0] === "--whoogle";
if (whoogle) args.shift();
const runtimeCase = linkding || whoogle;
const [repository, runtimeFile, ...extra] = args;
if (!repository || extra.length || (runtimeCase ? !runtimeFile : runtimeFile))
  throw new Error(
    "Usage: pnpm benchmark:repository:selftest [--linkding|--whoogle] SOURCE_GIT [RUNTIME_RECEIPT]",
  );
const definition = JSON.parse(
  readFileSync(
    new URL(
      `./cases/${whoogle ? "whoogle" : linkding ? "linkding" : "repository"}-calibration.json`,
      import.meta.url,
    ),
  ),
);
const sources = {};
for (const variant of ["baseline", runtimeCase ? "upstream" : "reference"]) {
  sources[variant] = exportPinnedTree(path.resolve(repository), definition[variant].commit);
  assert.equal(sources[variant].sha256, definition[variant].sha256, `Pinned ${variant} digest`);
}
if (runtimeCase) {
  sources.reference = deriveRepositoryReference(
    sources.baseline,
    sources.upstream,
    definition.editableFiles,
    definition.reference.regions,
  );
  assert.equal(sources.reference.sha256, definition.reference.sha256, "Derived reference digest");
}
const harness = deployHarness();
const repositoryRuntime = runtimeCase ? JSON.parse(readFileSync(runtimeFile)) : undefined;
const browserRuntime = linkding
  ? JSON.parse(
      guestCommand(
        [
          "sudo",
          "node",
          "--input-type=module",
          "-e",
          `import {captureBrowserRuntime} from '${harness.directory}/browser-runtime.mjs';
  import {verifyLinkdingRuntime} from '${harness.directory}/linkding-runtime.mjs';
  import {readFileSync} from 'node:fs';
  verifyLinkdingRuntime(JSON.parse(readFileSync(0,'utf8')));
  console.log(JSON.stringify(captureBrowserRuntime()));`,
        ],
        { input: JSON.stringify(repositoryRuntime), capture: true, timeout: 60000 },
      ),
    )
  : undefined;
const study = fixtureStudy();
study.id = `repository-fixture-${randomBytes(8).toString("hex")}`;
study.billing = pilotPolicy.billing;
study.limits = { ...pilotPolicy.limits, trialSeconds: linkding ? 420 : whoogle ? 180 : 90 };
study.configurations = [
  {
    id: "scripted",
    agent: "codex",
    agentVersion: "fixture-process",
    model: "fixture-model",
    reasoning: "none",
    environment: "isolated guest; scripted process, no model calls",
  },
];
study.tasks = [
  {
    ...study.tasks[0],
    id: definition.id,
    repository: whoogle ? "whoogle-search" : linkding ? "linkding" : "tornado",
    prompt: definition.task,
    requirements: definition.task,
    provenance: `${definition.repository}; historical public repair, scripted runner test only`,
    sourceFormat: "git-tree-v1",
    editableFiles: definition.editableFiles,
    sourceSha256: sources.baseline.sha256,
    referenceSha256: sources.reference.sha256,
    graderSha256: harness.id,
    ...(runtimeCase
      ? {
          runtimeSha256: digest(repositoryRuntime),
          ...(browserRuntime ? { browserRuntimeSha256: digest(browserRuntime) } : {}),
        }
      : {}),
    validatedBy: "Fixture assertions inside the isolated guest; not a measured agent result",
  },
];
const run = path.join(workRoot, study.id);
const plan = createStudyRun(study, run);
mkdirSync(path.join(run, "inputs"), { mode: 0o700 });
writeNewJson(path.join(run, "definition.json"), definition);
writeNewJson(path.join(run, "sources.json"), sources);
writeNewJson(path.join(run, "harness.json"), harness);
const assignment = plan.assignments.find((item) => item.arm === "normal");
const item = {
  id: definition.id,
  runtime: "python",
  entry: definition.editableFiles[0],
  ...(runtimeCase ? { repositoryRuntime } : {}),
  ...(browserRuntime ? { browserRuntime } : {}),
};
const reference = Object.fromEntries(
  sources.reference.files
    .filter((file) => definition.editableFiles.includes(file.name))
    .map((file) => [file.name, file.base64]),
);
const executable = sources.baseline.files.find((file) => file.mode === "100755").name;
console.log(
  `Testing full-repository submissions in the VM; scripted process only. Evidence: ${run}`,
);
const result = JSON.parse(
  guestCommand(
    [
      "sudo",
      "flock",
      "-n",
      "/run/sitecmd-benchmark-execution.lock",
      "node",
      `${harness.directory}/executor-selftest.mjs`,
    ],
    {
      input: JSON.stringify({
        plan,
        assignment,
        item,
        mode: "repository",
        files: sources.baseline,
        reference,
        executable,
        protectedFile: definition.licenseFile,
      }),
      capture: true,
      timeout: linkding ? 480000 : whoogle ? 240000 : 150000,
    },
  ),
);
exportGuestTrial(run, plan, assignment, harness);
assert.equal(result.passed, true);
console.log(
  "PASS full-repository capture, reference repair, protected-file rejection, final mode-change detection and evidence import; zero model calls.",
);
