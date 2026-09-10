export function trialPrompt({
  task,
  arm,
  workspace,
  channel,
  publicTools,
  projectId,
  url,
  handoff,
  report,
  repositoryRuntime = false,
}) {
  if (!["normal", "report", "mcp"].includes(arm)) throw new Error("Unknown trial workflow");
  if (arm === "report" && (typeof report !== "string" || !report.trim()))
    throw new Error("A complete report is required before releasing the prompt");
  if (arm === "mcp") {
    if (!Number.isSafeInteger(projectId) || projectId <= 0)
      throw new Error("MCP requires a trial project");
    if (task.kind === "repair" && (typeof handoff !== "string" || !handoff.trim()))
      throw new Error("A repair handoff is required before releasing the prompt");
  }
  const submission =
    arm === "mcp" && task.kind === "repair"
      ? "Submit each candidate with the SiteCMD request_verification tool. Read get_fix_brief first and use get_fix_status to check the result."
      : `Submit each candidate, including an intentional no-op, with: node ${publicTools}/submit.mjs ${channel} "short summary"`;
  return [
    task.prompt,
    task.requirements,
    ...(task.editableFiles
      ? [
          `Permitted edit paths: ${task.editableFiles.join(", ") || "none (no-op only)"}. Preserve every other tracked file and all executable modes.`,
        ]
      : []),
    ...(repositoryRuntime
      ? [
          "The frozen project dependency environment is already active. Run tests with `python -m pytest`; do not install dependencies, run `./run test`, or override `STATIC_FOLDER` or `CONFIG_VOLUME`. Generated test data is redirected outside the checkout.",
        ]
      : []),
    `Work only in ${workspace}. Do not delegate, invoke another AI client, change tests or scanner suppressions, or access accounts and other workspaces. Use the existing tests and ordinary local tools.`,
    submission,
    "You may submit at most three candidates. Stop editing once you have submitted your final candidate. Explain the result and stop. Independent grader feedback is withheld in every workflow.",
    ...(arm === "report" ? ["Complete pretrial SiteCMD report:", report] : []),
    ...(arm === "mcp"
      ? [
          `SiteCMD project #${projectId}, URL ${url}. Desktop paths in briefs refer to a mount of your current working directory.`,
          handoff,
        ]
      : []),
  ].join("\n\n");
}
