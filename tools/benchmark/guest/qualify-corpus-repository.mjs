import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateRepositoryCorpusIntake } from "../lib/repository-corpus.mjs";
import { deriveRepositoryReference } from "../lib/repository-reference.mjs";
import { materializeRepositoryFiles } from "../lib/repository-snapshot.mjs";
import { digest } from "../lib/workflow-plan.mjs";
import { gradeRepository } from "./repository-grader.mjs";
import { verifyFlaskReuploadedRuntime } from "./flask-reuploaded-runtime.mjs";
import { createWorkspace, mountDesktopWorkspace, closeWorkspace } from "./trial-workspace.mjs";

if (process.platform !== "linux" || process.getuid() !== 0)
  throw new Error("Corpus qualification requires the isolated guest controller");
const { id, intake, registration, sources, product, runtime } = JSON.parse(readFileSync(0, "utf8"));
if (!/^[a-f0-9]{32}$/.test(id) || registration.repository !== "flask-reuploaded")
  throw new Error("Unsupported corpus qualification");
const pinnedIntake = JSON.parse(
  readFileSync(new URL("../cases/repository-held-out-v1.json", import.meta.url)),
);
const pinnedRegistration = JSON.parse(
  readFileSync(new URL("../cases/flask-reuploaded-cases.json", import.meta.url)),
);
validateRepositoryCorpusIntake(intake);
if (digest(intake) !== digest(pinnedIntake) || digest(registration) !== digest(pinnedRegistration))
  throw new Error("Corpus qualification differs from the frozen harness");
verifyFlaskReuploadedRuntime(runtime);
if (
  runtime.id !== registration.runtimeManifestSha256 ||
  !/^[a-f0-9]{40}$/.test(product.commit) ||
  product.cli !== `/opt/sitecmd-benchmark/products/${product.commit}/sitecmd_cli` ||
  digest(readFileSync(product.cli)) !== product.cliSha256
)
  throw new Error("The runtime or installed scanner differs from its receipt");

const parent = "/srv/sitecmd-benchmark/corpus-qualification";
const output = path.join(parent, id);
mkdirSync(parent, { recursive: true, mode: 0o700 });
mkdirSync(output, { mode: 0o700 });
const results = {};
const items = intake.cases.filter((item) => item.repository.id === registration.repository);
for (const [index, item] of items.entries()) {
  const registered = registration.cases[index];
  const caseSources = sources[item.id];
  const derived =
    item.kind === "negative_control"
      ? caseSources.baseline
      : deriveRepositoryReference(
          caseSources.baseline,
          caseSources.upstream,
          item.editableFiles,
          registered.reference.regions,
        );
  if (
    caseSources.baseline.sha256 !== registered.baselineSha256 ||
    caseSources.upstream.sha256 !== registered.upstreamSha256 ||
    digest(derived) !== digest(caseSources.reference) ||
    derived.sha256 !== registered.reference.sha256
  )
    throw new Error(`Case ${item.id} source identity differs from its registration`);
  results[item.id] = {};
  for (const variant of ["baseline", "reference"]) {
    const snapshot = caseSources[variant];
    const candidate = path.join(output, item.id, variant);
    mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    materializeRepositoryFiles(snapshot.files, candidate);
    const grades = Array.from({ length: 3 }, () =>
      gradeRepository(
        {
          id: item.id,
          repository: registration.repository,
          runtime: item.runtime,
          repositoryRuntime: runtime,
        },
        candidate,
      ),
    );
    const files = Object.fromEntries(
      snapshot.files.map((file) => [file.name, Buffer.from(file.base64, "base64")]),
    );
    const workspaceId = randomBytes(16).toString("hex");
    const workspace = createWorkspace(workspaceId, files);
    let mounted;
    let scan;
    try {
      for (const file of snapshot.files)
        chmodSync(path.join(workspace, file.name), file.mode === "100755" ? 0o755 : 0o644);
      mounted = mountDesktopWorkspace(workspaceId, workspace);
      const result = spawnSync(
        "sudo",
        ["-u", "sitecmd", product.cli, "audit", mounted.path, "--format", "json"],
        { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      );
      scan = { exitCode: result.status, raw: result.stdout, stderr: result.stderr };
      if (result.error) scan.error = result.error.message;
      if (result.status === 0) scan.report = JSON.parse(result.stdout);
    } catch (error) {
      scan = { ...scan, error: error.message };
    } finally {
      try {
        mounted?.close();
      } finally {
        closeWorkspace(workspace);
      }
    }
    const result = { sourceSha256: snapshot.sha256, grades, scan };
    results[item.id][variant] = result;
    writeFileSync(path.join(output, `${item.id}-${variant}.json`), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
  }
}
const passed = items.every((item, index) => {
  const expectedBaseline = registration.cases[index].baselineAcceptancePass;
  const result = results[item.id];
  return (
    result.baseline.grades.every(
      (grade) => grade.acceptancePass === expectedBaseline && grade.regressionsPass,
    ) &&
    result.reference.grades.every((grade) => grade.acceptancePass && grade.regressionsPass) &&
    result.baseline.scan.report &&
    result.reference.scan.report
  );
});
const receipt = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  corpusId: intake.id,
  intakeSha256: digest(intake),
  repository: registration.repository,
  registrationSha256: digest(registration),
  purpose: "held-out case qualification before agent trials",
  scannerObserved: true,
  modelCalls: 0,
  output,
  product,
  runtime,
  environment: { node: process.version, architecture: process.arch, platform: process.platform },
  passed,
  results,
};
writeFileSync(path.join(output, "qualification.json"), JSON.stringify(receipt), {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify(receipt));
