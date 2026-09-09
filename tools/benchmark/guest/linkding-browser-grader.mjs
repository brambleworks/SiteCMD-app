import { randomBytes } from "node:crypto";
import { executeCandidate } from "./candidate-sandbox.mjs";

export function gradeLinkdingBrowser(observed, assets, nonce) {
  const expected = [...assets, assets[0], assets[0]];
  const responses = Array.isArray(observed.assets) ? observed.assets : [];
  const control = observed.control;
  const regressions = [
    {
      name: "Browser identity and unsandboxed script/storage controls are live",
      actual: { capabilities: observed.capabilities, control, error: observed.error },
      pass:
        !observed.error &&
        observed.capabilities?.browserName === "MiniBrowser" &&
        observed.capabilities.browserVersion === "2.52.6" &&
        control?.marker === `control-${nonce}` &&
        control.executed === true &&
        control.cookieAccessible === true &&
        control.storageAccessible === true &&
        responses.length === expected.length,
    },
    {
      name: "WebKit web processes retain their OS sandbox",
      actual: observed.sandbox,
      pass:
        Array.isArray(observed.sandbox) &&
        observed.sandbox.length > 0 &&
        observed.sandbox.every(
          (process) =>
            process.seccomp === "2" &&
            process.noNewPrivileges === "1" &&
            process.separateMountNamespace === true,
        ),
    },
    {
      name: "Browser probes finish without task-limit or memory-limit failures",
      actual: observed.resources,
      pass:
        /^max 0\n$/.test(observed.resources?.["pids.events"] ?? "") &&
        ["max", "oom", "oom_kill"].every((key) =>
          new RegExp(`^${key} 0$`, "m").test(observed.resources?.["memory.events"] ?? ""),
        ),
    },
    ...expected.map((asset, i) => ({
      name: `Browser asset ${i + 1} loads and renders its original Django response`,
      actual: responses[i] ?? observed,
      pass:
        responses[i]?.marker === asset.marker &&
        responses[i]?.rendered === true &&
        responses[i]?.http?.status === 200 &&
        responses[i]?.http?.base64 === asset.base64,
    })),
  ];
  const acceptance = expected.map((_asset, i) => ({
    name: `Browser asset ${i + 1} blocks embedded scripts and application-origin storage`,
    actual: responses[i] ?? observed,
    pass:
      responses[i]?.executed === false &&
      responses[i]?.cookieError === "SecurityError" &&
      responses[i]?.storageError === "SecurityError",
  }));
  const regressionsPass = regressions.every((check) => check.pass);
  return {
    acceptance,
    regressions,
    acceptancePass: regressionsPass && acceptance.every((check) => check.pass),
    regressionsPass,
    unprotected:
      regressionsPass &&
      responses.every(
        (response) =>
          response.executed === true &&
          response.cookieAccessible === true &&
          response.storageAccessible === true,
      ),
  };
}

export function probeLinkdingBrowser(
  candidate,
  repositoryRuntime,
  browserRuntime,
  execute = executeCandidate,
) {
  const nonce = randomBytes(12).toString("hex");
  const assets = [
    ["snapshot", false],
    ["snapshot", true],
    ["upload", false],
    ["upload", true],
  ].map(([type, gzip], i) => {
    const marker = `${nonce}-${i}`;
    return {
      type,
      gzip,
      marker,
      contentType: "text/html",
      filename: `Asset-${marker}.html`,
      base64: Buffer.from(
        `<!doctype html><html><body><h1 id="asset">${marker}</h1><script>window.assetExecuted = true</script></body></html>`,
      ).toString("base64"),
    };
  });
  const observed = execute(
    { id: "linkding-asset-sandbox", runtime: "python", repositoryRuntime, browserRuntime },
    candidate,
    { operation: "browser", assets, nonce },
  );
  return { ...gradeLinkdingBrowser(observed, assets, nonce), observed };
}
