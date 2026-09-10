import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repositoryStudyArguments } from "./lib/repository-study-arguments.mjs";
import { repositoryGraderIdentity } from "./lib/repository-grader-identity.mjs";
import { deriveRepositoryReference } from "./lib/repository-reference.mjs";
import { retainRepositoryReport } from "./lib/repository-report-continuity.mjs";
import { validateRepositorySnapshot } from "./lib/repository-snapshot.mjs";
import { trialConfigurations } from "./lib/trial-invocation.mjs";
import { digest } from "./lib/workflow-plan.mjs";
import {
  repositoryStudyPolicy,
  validateRepositoryStudy,
} from "./lib/workflow-repository-study.mjs";
import { createStudyRun, loadPlan, writeNewJson } from "./lib/workflow-store.mjs";
import { describeContinuation } from "./lib/workflow-continuation.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";

const { qualificationDirectory, workflowDirectory, output, continueFrom, reason } =
  repositoryStudyArguments(process.argv.slice(2));
const readJson = (directory, name) =>
  JSON.parse(readFileSync(path.join(path.resolve(directory), name)));
const definition = readJson(qualificationDirectory, "definition.json");
const sources = readJson(qualificationDirectory, "sources.json");
const product = readJson(qualificationDirectory, "product.json");
const runtime = readJson(qualificationDirectory, "runtime.json");
const qualification = readJson(qualificationDirectory, "qualification.json");
const workflow = readJson(workflowDirectory, "workflow.json");
const qualificationHarness = readJson(qualificationDirectory, "harness.json");
const workflowHarness = readJson(workflowDirectory, "harness.json");
const pinnedDefinition = JSON.parse(
  readFileSync(new URL("./cases/whoogle-calibration.json", import.meta.url)),
);
const same = (left, right, label) => {
  if (digest(left) !== digest(right)) throw new Error(`${label} differs between evidence sets`);
};

same(definition, pinnedDefinition, "Whoogle definition");
same(definition, readJson(workflowDirectory, "definition.json"), "Workflow definition");
same(sources, readJson(workflowDirectory, "sources.json"), "Workflow sources");
same(product, readJson(workflowDirectory, "product.json"), "Workflow product");
same(runtime, readJson(workflowDirectory, "runtime.json"), "Workflow runtime");
same(product, qualification.product, "Qualification product");
same(product, workflow.product, "Workflow receipt product");
same(runtime, qualification.runtime, "Qualification runtime");
same(runtime, workflow.runtime, "Workflow receipt runtime");
validateRepositorySnapshot(sources.baseline);
if (
  sources.baseline.commit !== definition.baseline.commit ||
  sources.baseline.sha256 !== definition.baseline.sha256 ||
  sources.upstream.commit !== definition.upstream.commit ||
  sources.upstream.sha256 !== definition.upstream.sha256
)
  throw new Error("Pinned repository sources differ from the Whoogle definition");
const reference = deriveRepositoryReference(
  sources.baseline,
  sources.upstream,
  definition.editableFiles,
  definition.reference.regions,
);
same(reference, sources.reference, "Derived reference");
if (reference.sha256 !== definition.reference.sha256)
  throw new Error("Derived reference digest differs from the Whoogle definition");

const harness = deployHarness();
const currentGraderIdentity = repositoryGraderIdentity(harness.files, definition.id);
let studyGraderIdentity = currentGraderIdentity;
let continuationSourceRun = null;
if (continueFrom) {
  const sourceRun = path.resolve(continueFrom);
  continuationSourceRun = sourceRun;
  const sourcePlan = loadPlan(sourceRun);
  const sourceRunner = readJson(path.join(sourceRun, "inputs"), "runner.json");
  if (digest(sourceRunner) !== sourcePlan.study.runnerSha256)
    throw new Error("Continuation source runner differs from its frozen identity");
  if (repositoryGraderIdentity(sourceRunner, definition.id) !== currentGraderIdentity)
    throw new Error("Continuation changed the repository grader");
  const sourceTask = sourcePlan.study.tasks.find((task) => task.id === definition.id);
  if (!sourceTask) throw new Error("Continuation source is missing the Whoogle task");
  studyGraderIdentity = sourceTask.graderSha256;
}
for (const [receipt, stored, label] of [
  [qualification, qualificationHarness, "qualification"],
  [workflow, workflowHarness, "workflow"],
]) {
  if (receipt.harnessSha256 !== harness.id || stored.id !== harness.id)
    throw new Error(`Current runner differs from the ${label} evidence`);
  same(stored.files, harness.files, `${label} runner files`);
  if (
    receipt.caseId !== definition.id ||
    receipt.definitionSha256 !== digest(definition) ||
    receipt.modelCalls !== 0 ||
    !receipt.passed
  )
    throw new Error(`${label} evidence did not pass without model calls`);
}
for (const [variant, expectedAcceptance] of [
  ["baseline", false],
  ["reference", true],
]) {
  const result = qualification.results?.[variant];
  if (
    result?.sourceSha256 !== sources[variant].sha256 ||
    result.grades?.length !== 3 ||
    !result.grades.every(
      (grade) =>
        grade.acceptancePass === expectedAcceptance &&
        grade.regressionsPass &&
        grade.runtimeSha256 === digest(runtime),
    ) ||
    result.scan?.exitCode !== 0 ||
    digest(JSON.parse(result.scan.raw)) !== digest(result.scan.report)
  )
    throw new Error(`${variant} qualification is incomplete`);
}
const targetCheck = `code_scan.${definition.rule}`;
const hasTarget = (variant) =>
  qualification.results[variant].scan.report.issues.some((issue) => issue.checkId === targetCheck);
if (!hasTarget("baseline") || hasTarget("reference"))
  throw new Error("SiteCMD must detect the baseline repair target and clear it in the reference");
if (
  !workflow.handoffAvailable ||
  workflow.results?.length !== 3 ||
  !["mcp", "normal", "report"].every((arm) =>
    workflow.results.some(
      (result) =>
        result.arm === arm && result.status === "ready" && result.sourceUnchanged && result.prompt,
    ),
  )
)
  throw new Error("Desktop workflow evidence is not ready for every study arm");

const protocol = readFileSync(
  new URL("../../docs/qa/agent-workflow-benchmark.md", import.meta.url),
);
const corpus = [
  {
    id: definition.id,
    repository: "whoogle-search",
    kind: definition.kind,
    runtime: "python",
    entry: definition.editableFiles[0],
    rule: definition.rule,
    baselineFiles: sources.baseline,
    referenceFiles: sources.reference,
    repositoryRuntime: runtime,
  },
];
let report = qualification.results.baseline.scan.raw;
if (continuationSourceRun) {
  const originalReport = readFileSync(
    path.join(continuationSourceRun, "inputs", `${definition.id}-report.json`),
    "utf8",
  );
  report = retainRepositoryReport(originalReport, report);
}
const study = {
  schemaVersion: 1,
  id: repositoryStudyPolicy.studyId,
  phase: repositoryStudyPolicy.phase,
  seed: 20260908,
  repeats: repositoryStudyPolicy.repeats,
  arms: repositoryStudyPolicy.arms,
  limits: repositoryStudyPolicy.limits,
  billing: repositoryStudyPolicy.billing,
  protocol: "agent-workflow-v1-repository-calibration",
  protocolSha256: digest(protocol),
  runnerSha256: harness.id,
  corpusSha256: digest(corpus),
  productSha256: digest(product),
  sitecmd: {
    version: product.version,
    commit: product.commit,
    dirty: false,
    mcpSha256: product.mcpSha256,
  },
  configurations: trialConfigurations(
    `${product.environment}; warm; controller ${harness.id}`,
    repositoryStudyPolicy.models,
  ),
  tasks: [
    {
      id: definition.id,
      repository: "whoogle-search",
      kind: definition.kind,
      runtime: "python",
      entry: definition.editableFiles[0],
      rule: definition.rule,
      surface: definition.surface,
      category: "security",
      prompt: definition.task,
      requirements: definition.task,
      provenance: `${definition.repository}; historical public repair ${definition.upstreamFix}; non-held-out runner calibration with possible model exposure`,
      holdout: false,
      sourceFormat: "git-tree-v1",
      editableFiles: definition.editableFiles,
      sourceSha256: sources.baseline.sha256,
      referenceSha256: sources.reference.sha256,
      graderSha256: studyGraderIdentity,
      reportSha256: digest(report),
      runtimeSha256: digest(runtime),
      baseline: { acceptancePass: false, regressionsPass: true },
      reference: { acceptancePass: true, regressionsPass: true },
      validatedBy:
        "Independent Flask and filesystem assertions, three baseline/reference repetitions, frozen runtime, scanner clearance, and desktop workflow smoke checks",
    },
  ],
};
if (continueFrom) study.continuation = describeContinuation(continueFrom, study, reason);
validateRepositoryStudy(study);
const plan = createStudyRun(study, output);
mkdirSync(path.join(output, "inputs"), { mode: 0o700 });
for (const [name, value] of [
  ["corpus.json", corpus],
  ["definition.json", definition],
  ["grades.json", qualification],
  ["product.json", product],
  ["runner.json", harness.files],
  ["runtime.json", runtime],
  ["sources.json", sources],
  ["workflow.json", workflow],
])
  writeNewJson(path.join(output, "inputs", name), value);
writeFileSync(path.join(output, "inputs", `${definition.id}-report.json`), report, {
  flag: "wx",
  mode: 0o600,
});
writeFileSync(path.join(output, "inputs", "protocol.md"), protocol, {
  flag: "wx",
  mode: 0o600,
});
const emptyQuota = JSON.parse(readFileSync(new URL("./quota-template.json", import.meta.url)));
for (const name of ["quota-baseline.json", "quota-current.json"])
  writeNewJson(
    path.join(output, name),
    study.continuation
      ? JSON.parse(readFileSync(path.join(study.continuation.sourceRun, name)))
      : emptyQuota,
  );
if (study.continuation) {
  writeFileSync(path.join(output, "quota-baseline.sha256"), study.continuation.baselineSha256, {
    flag: "wx",
    mode: 0o600,
  });
  const prior = path.join(study.continuation.sourceRun, "prior-attempts.json");
  if (existsSync(prior))
    writeNewJson(path.join(output, "prior-attempts.json"), JSON.parse(readFileSync(prior)));
}
console.log(
  `Frozen ${plan.plannedTrials} Whoogle assignments at ${path.resolve(output)}. No agent calls made. Fresh quota evidence is required before execution.`,
);
