import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { digest } from "../lib/workflow-plan.mjs";
import { writeNewJson } from "../lib/workflow-store.mjs";
import { loadTrialSource } from "../lib/trial-source.mjs";
import { trialPrompt } from "../lib/trial-prompt.mjs";
import { candidateIdentity, readCandidate } from "./trial-snapshot.mjs";
import { createWorkspace, mountDesktopWorkspace, closeWorkspace } from "./trial-workspace.mjs";
import { startDesktop } from "./desktop-session.mjs";
import { prepareProject, trialUrl } from "./trial-setup.mjs";
import { initializeMcp, openMcp } from "./mcp-session.mjs";
import { verifyControlIsolation } from "./trial-isolation.mjs";
import { verifyLinkdingRuntime } from "./linkding-runtime.mjs";
import { verifyWhoogleRuntime } from "./whoogle-runtime.mjs";

if (process.platform !== "linux" || process.getuid() !== 0)
  throw new Error("Repository workflow checks require the isolated guest controller");
const { id, definition, sources, product, runtime } = JSON.parse(readFileSync(0, "utf8"));
const linkding = definition.id === "linkding-asset-sandbox";
const whoogle = definition.id === "whoogle-named-config-path";
const pinned = JSON.parse(
  readFileSync(
    new URL(
      `../cases/${whoogle ? "whoogle" : linkding ? "linkding" : "repository"}-calibration.json`,
      import.meta.url,
    ),
  ),
);
if (!/^[a-f0-9]{32}$/.test(id) || digest(definition) !== digest(pinned))
  throw new Error("Repository definition differs from the frozen harness");
if (linkding) verifyLinkdingRuntime(runtime);
if (whoogle) verifyWhoogleRuntime(runtime);
if (
  !/^[a-f0-9]{40}$/.test(product.commit) ||
  product.binary !== "/usr/bin/sitecmd" ||
  product.mcp !== "/usr/lib/SiteCMD/sitecmd-mcp/sitecmd-mcp.mjs" ||
  product.cli !== `/opt/sitecmd-benchmark/products/${product.commit}/sitecmd_cli`
)
  throw new Error("Unexpected benchmark product paths");
for (const field of ["binary", "mcp", "cli"])
  if (digest(readFileSync(product[field])) !== product[`${field}Sha256`])
    throw new Error(`Installed ${field} differs from its product receipt`);
const task = {
  ...definition,
  sourceFormat: "git-tree-v1",
  sourceSha256: definition.baseline.sha256,
  prompt: definition.task,
  requirements: definition.task,
};
const { files, modes } = loadTrialSource(sources.baseline, task);
const expected = candidateIdentity({ files, modes, violations: [] });
const parent = "/srv/sitecmd-benchmark/repository-workflow";
mkdirSync(parent, { recursive: true, mode: 0o700 });
const output = path.join(parent, id);
mkdirSync(output, { mode: 0o700 });
writeNewJson(path.join(output, "input.json"), { definition, sources, product, runtime });
const results = [];
for (const arm of ["normal", "report", "mcp"]) {
  const sessionId = digest({ id, arm }).slice(0, 32);
  const trace = [];
  const result = {
    arm,
    sessionId,
    status: "infrastructure_error",
    prompt: null,
    sourceUnchanged: false,
    modelCalls: 0,
    sourceSha256: task.sourceSha256,
    trace,
  };
  let workspace, mounted, desktop, reader;
  try {
    workspace = createWorkspace(sessionId, files, modes);
    mounted = mountDesktopWorkspace(sessionId, workspace);
    const scan = spawnSync(
      "sudo",
      ["-u", "sitecmd", product.cli, "audit", mounted.path, "--format", "json"],
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    result.report = { exitCode: scan.status, raw: scan.stdout, stderr: scan.stderr };
    if (scan.status !== 0)
      throw new Error(`CLI report failed: ${scan.error?.message ?? scan.stderr}`);
    JSON.parse(scan.stdout);
    desktop = await startDesktop(sessionId, product.binary);
    verifyControlIsolation();
    result.database = desktop.database;
    try {
      const prepared = await prepareProject(
        desktop,
        mounted,
        definition,
        product,
        { agent: "codex" },
        arm,
        (name, event) => trace.push({ name, ...event }),
      );
      result.projectId = prepared.projectId;
      result.prompt = trialPrompt({
        task,
        arm,
        workspace,
        channel: `/run/sitecmd-benchmark/${sessionId}`,
        publicTools: "/usr/local/lib/sitecmd-benchmark",
        projectId: prepared.projectId,
        url: trialUrl,
        handoff: prepared.handoff,
        report: scan.stdout,
      });
      result.status = "ready";
    } catch (error) {
      if (!["ProjectSetupError", "UnmappedHandoffError"].includes(error.name)) throw error;
      result.status = error.name === "UnmappedHandoffError" ? "handoff_unmapped" : "product_error";
      result.stage = error.stage;
      result.projectId = error.projectId;
      result.response = error.response;
      result.error = error.message;
    }
    reader = openMcp(product.mcp, desktop.database, (event) =>
      trace.push({ name: "diagnostic", ...event }),
    );
    result.initialization = await initializeMcp(reader);
    result.issues = await reader.call("get_issues", { url: trialUrl });
    if (result.issues.isError)
      throw new Error(`Issue retrieval failed: ${JSON.stringify(result.issues)}`);
    result.snapshotSha256 = candidateIdentity(readCandidate(workspace));
    result.sourceUnchanged = result.snapshotSha256 === expected;
    if (!result.sourceUnchanged) throw new Error("Workflow setup changed tracked source or modes");
  } catch (error) {
    result.status = "infrastructure_error";
    result.error = error.message;
  } finally {
    reader?.close();
    try {
      desktop?.close();
    } finally {
      try {
        mounted?.close();
      } finally {
        if (workspace) closeWorkspace(workspace);
      }
    }
  }
  results.push(result);
  writeNewJson(path.join(output, `${arm}.json`), result);
}
const receipt = {
  capturedAt: new Date().toISOString(),
  purpose: "Full-repository workflow smoke test, not an agent trial",
  modelCalls: 0,
  agentInvoked: false,
  caseId: definition.id,
  definitionSha256: digest(definition),
  product,
  ...(runtime ? { runtime } : {}),
  output,
  results,
  passed: results.every(
    (result) =>
      result.sourceUnchanged &&
      (result.status === "ready" ||
        (result.arm === "mcp" &&
          ["product_error", "handoff_unmapped"].includes(result.status) &&
          result.stage === "handoff")),
  ),
  handoffAvailable: results.find((result) => result.arm === "mcp").status === "ready",
};
writeNewJson(path.join(output, "workflow.json"), receipt);
console.log(JSON.stringify(receipt));
