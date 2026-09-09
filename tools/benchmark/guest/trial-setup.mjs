import { initializeMcp, openMcp } from "./mcp-session.mjs";

export const trialUrl = "http://localhost:4173";

class UnmappedHandoffError extends Error {
  constructor(projectId) {
    super("This repair has no registered SiteCMD check; no start_fix request was sent");
    this.name = "UnmappedHandoffError";
    this.stage = "handoff";
    this.projectId = projectId;
  }
}

class ProjectSetupError extends Error {
  constructor(stage, projectId, response) {
    super(
      `${stage === "scan" ? "Desktop scan did not complete" : "SiteCMD could not prepare the repair"}: ${JSON.stringify(response)}`,
    );
    this.name = "ProjectSetupError";
    this.stage = stage;
    this.projectId = projectId;
    this.response = response;
  }
}

export async function prepareProject(
  desktop,
  mounted,
  item,
  product,
  configuration,
  arm,
  log,
  { connect = openMcp } = {},
) {
  const projectId = await desktop.invoke("add_project", {
    name: item.id,
    path: mounted.path,
    framework: null,
    urls: [{ url: trialUrl, environment: "local", source: "benchmark" }],
  });
  const mcp = connect(product.mcp, desktop.database, (event) =>
    log(arm === "mcp" ? "mcp.jsonl" : "setup.jsonl", event),
  );
  try {
    await initializeMcp(mcp, configuration.agent);
    const scan = await mcp.call("run_scan", {
      project_id: projectId,
      url: trialUrl,
      scope: "code",
      wait: true,
    });
    if (
      scan.isError ||
      !/complete: execution #\d+ \(complete\)/.test(scan.content?.[0]?.text ?? "")
    )
      throw new ProjectSetupError("scan", projectId, scan);
    let handoff = "";
    if (arm === "mcp" && item.kind === "repair") {
      if (typeof item.rule !== "string" || !/^[a-z][a-z0-9-]*$/.test(item.rule))
        throw new UnmappedHandoffError(projectId);
      const result = await mcp.call("start_fix", {
        project_id: projectId,
        url: trialUrl,
        check_id: `code_scan.${item.rule}`,
        wait: true,
      });
      if (result.isError || !/Fix attempt #\d+ is briefed/.test(result.content?.[0]?.text ?? ""))
        throw new ProjectSetupError("handoff", projectId, result);
      handoff = result.content[0].text;
    }
    return { projectId, handoff };
  } finally {
    mcp.close();
  }
}
