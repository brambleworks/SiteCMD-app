import assert from "node:assert/strict";
import { test } from "node:test";
import { trialPrompt } from "./trial-prompt.mjs";

const options = {
  task: {
    kind: "repair",
    prompt: "Repair the handler",
    requirements: "Preserve local redirects",
    editableFiles: ["app/handler.py"],
  },
  workspace: "/workspace",
  channel: "/channel",
  publicTools: "/tools",
  projectId: 7,
  url: "http://localhost:4173",
  handoff: "Private handoff marker",
  report: "Private report marker",
};

test("the normal workflow retains the shared task without exposing SiteCMD evidence", () => {
  const prompt = trialPrompt({ ...options, arm: "normal" });
  assert.ok(prompt.startsWith(`${options.task.prompt}\n\n${options.task.requirements}\n\n`));
  assert.match(prompt, /Permitted edit paths: app\/handler.py/);
  assert.match(prompt, /node \/tools\/submit.mjs \/channel/);
  assert.doesNotMatch(prompt, /Private|project #7|get_fix_brief|request_verification/);
});

test("repository trials disclose the active dependency environment", () => {
  const prompt = trialPrompt({ ...options, arm: "normal", repositoryRuntime: true });
  assert.match(prompt, /project dependency environment is already active/i);
  assert.match(prompt, /do not install dependencies/i);
  assert.match(prompt, /python -m pytest/);
  assert.match(prompt, /override.*STATIC_FOLDER.*CONFIG_VOLUME/i);
});

test("report and MCP workflows require their own evidence before releasing a prompt", () => {
  const report = trialPrompt({ ...options, arm: "report" });
  assert.ok(report.endsWith(options.report));
  assert.doesNotMatch(report, /Private handoff marker|get_fix_brief/);
  const mcp = trialPrompt({ ...options, arm: "mcp" });
  assert.ok(mcp.endsWith(options.handoff));
  assert.doesNotMatch(mcp, /Private report marker/);
  assert.match(mcp, /request_verification/);
  for (const changes of [
    { arm: "unknown" },
    { arm: "report", report: "" },
    { arm: "mcp", handoff: "" },
    { arm: "mcp", projectId: null },
  ])
    assert.throws(() => trialPrompt({ ...options, ...changes }), /workflow|report|handoff|project/);
});
