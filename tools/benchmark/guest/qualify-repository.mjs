import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  materializeRepositoryFiles,
  validateRepositorySnapshot,
} from "../lib/repository-snapshot.mjs";
import { deriveRepositoryReference } from "../lib/repository-reference.mjs";
import { digest } from "../lib/workflow-plan.mjs";
import { gradeRepository } from "./repository-grader.mjs";
import { verifyLinkdingRuntime } from "./linkding-runtime.mjs";
import { captureBrowserRuntime } from "./browser-runtime.mjs";
import { createWorkspace, mountDesktopWorkspace, closeWorkspace } from "./trial-workspace.mjs";

if (process.platform !== "linux" || process.getuid() !== 0)
  throw new Error("Repository qualification requires the isolated guest controller");
const { id, definition, sources, product, runtime } = JSON.parse(readFileSync(0, "utf8"));
const linkding = definition.id === "linkding-asset-sandbox";
if (!/^[a-f0-9]{32}$/.test(id) || (!linkding && definition.id !== "tornado-static-redirect"))
  throw new Error("Unsupported repository qualification");
const pinnedDefinition = JSON.parse(
  readFileSync(
    new URL(`../cases/${linkding ? "linkding" : "repository"}-calibration.json`, import.meta.url),
  ),
);
if (digest(definition) !== digest(pinnedDefinition))
  throw new Error("Repository definition differs from the frozen harness");
if (linkding) {
  verifyLinkdingRuntime(runtime);
  if (
    sources.upstream.commit !== definition.upstream.commit ||
    sources.upstream.sha256 !== definition.upstream.sha256 ||
    digest(sources.reference) !==
      digest(
        deriveRepositoryReference(sources.baseline, sources.upstream, definition.editableFiles),
      )
  )
    throw new Error("Derived reference differs from its pinned provenance");
}
if (
  !/^[a-f0-9]{40}$/.test(product.commit) ||
  product.cli !== `/opt/sitecmd-benchmark/products/${product.commit}/sitecmd_cli` ||
  digest(readFileSync(product.cli)) !== product.cliSha256
)
  throw new Error("The installed scanner differs from its product receipt");
const parent = "/srv/sitecmd-benchmark/repository-qualification";
mkdirSync(parent, { recursive: true, mode: 0o700 });
const output = path.join(parent, id);
mkdirSync(output, { mode: 0o700 });
const results = {};
const browserRuntime = linkding ? captureBrowserRuntime() : undefined;
for (const variant of ["baseline", "reference"]) {
  const snapshot = sources[variant];
  if (
    snapshot.commit !== definition[variant].commit ||
    snapshot.sha256 !== definition[variant].sha256 ||
    !snapshot.files.some((file) => file.name === definition.licenseFile)
  )
    throw new Error("Repository source differs from the pinned case");
  const candidate = path.join(output, variant);
  if (!linkding || variant === "baseline") validateRepositorySnapshot(snapshot);
  materializeRepositoryFiles(snapshot.files, candidate);
  const grades = Array.from({ length: 3 }, () =>
    gradeRepository({ id: definition.id, repositoryRuntime: runtime, browserRuntime }, candidate),
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
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
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
  results[variant] = { sourceSha256: snapshot.sha256, grades, scan };
  writeFileSync(path.join(output, `${variant}.json`), JSON.stringify(results[variant]), {
    flag: "wx",
    mode: 0o600,
  });
}
const receipt = {
  capturedAt: new Date().toISOString(),
  caseId: definition.id,
  definitionSha256: digest(definition),
  purpose: "runner-development qualification, not an agent trial",
  modelCalls: 0,
  output,
  product,
  ...(runtime ? { runtime } : {}),
  ...(browserRuntime ? { browserRuntime } : {}),
  environment: {
    node: process.version,
    python: runtime
      ? runtime.inventory.python
      : spawnSync("/usr/bin/python3", ["--version"], { encoding: "utf8" }).stdout.trim(),
    architecture: process.arch,
    platform: process.platform,
  },
  passed:
    results.baseline.grades.every(
      (grade) =>
        !grade.acceptancePass && grade.regressionsPass && (!linkding || grade.browser.unprotected),
    ) && results.reference.grades.every((grade) => grade.acceptancePass && grade.regressionsPass),
  results,
};
writeFileSync(path.join(output, "qualification.json"), JSON.stringify(receipt), {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify(receipt));
