import { randomBytes } from "node:crypto";
import { executeCandidate } from "./candidate-sandbox.mjs";

function sandboxed(response) {
  const policy = response?.headers?.["content-security-policy"];
  if (response?.status !== 200 || typeof policy !== "string") return false;
  return policy.split(",").some((entry) => {
    const directives = entry
      .split(";")
      .map((value) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""));
    return (
      directives.find((value) => /^sandbox(?:[\t\n\f\r ]|$)/i.test(value))?.toLowerCase() ===
      "sandbox"
    );
  });
}

function delivered(response, asset, head = false) {
  return (
    response?.status === 200 &&
    response.base64 === (head ? "" : asset.base64) &&
    response.headers?.["content-type"] === asset.contentType &&
    response.headers?.["content-disposition"] === `inline; filename="${asset.filename}"`
  );
}

export function gradeLinkding(candidate, execute = executeCandidate, repositoryRuntime) {
  const nonce = randomBytes(12).toString("hex");
  const assets = [
    ["snapshot", "text/html", false],
    ["snapshot", "text/html", true],
    ["upload", "text/html", false],
    ["upload", "text/html", true],
    ["upload", "image/png", true],
  ].map(([type, contentType, gzip], index) => ({
    type,
    contentType,
    gzip,
    filename: `Asset-${nonce}-${index}.${contentType === "text/html" ? "html" : "png"}`,
    base64: (contentType === "text/html"
      ? Buffer.from(`<h1>${nonce}-${index}</h1><script>window.assetExecuted = true</script>`)
      : Buffer.concat([Buffer.from([137, 80, 78, 71, 0, 255]), Buffer.from(nonce)])
    ).toString("base64"),
  }));
  const item = { id: "linkding-asset-sandbox", runtime: "python", repositoryRuntime };
  const observed = execute(item, candidate, { operation: "assets", assets });
  const responses = Array.isArray(observed.assets) ? observed.assets : [];
  const acceptance = [
    ...responses.slice(0, assets.length),
    observed.shared,
    observed.public,
    observed.head,
  ];
  const checks = assets.map((asset, i) => ({
    name: `Asset ${i + 1} retains content, type and inline filename`,
    actual: responses[i] ?? observed,
    pass: delivered(responses[i], asset),
  }));
  for (const name of ["privateOther", "privateGuest", "missing", "missingFile"])
    checks.push({ name, actual: observed[name] ?? observed, pass: observed[name]?.status === 404 });
  for (const name of ["shared", "public", "head"])
    checks.push({
      name,
      actual: observed[name] ?? observed,
      pass: delivered(observed[name], assets[0], name === "head"),
    });
  const tests = execute(item, candidate, { operation: "public-tests" });
  checks.push({
    name: "Existing asset view, model and API tests",
    actual: tests,
    pass:
      tests.testsRun === 28 &&
      tests.failures === 0 &&
      tests.errors === 0 &&
      tests.skipped === 0 &&
      tests.expectedFailures === 0 &&
      tests.unexpectedSuccesses === 0,
  });
  return {
    acceptance: acceptance.map((response, i) => ({
      name: `Asset response ${i + 1} enforces sandbox restrictions`,
      actual: response ?? observed,
      pass: sandboxed(response),
    })),
    regressions: checks,
    acceptancePass: acceptance.length === assets.length + 3 && acceptance.every(sandboxed),
    regressionsPass: checks.every((check) => check.pass),
  };
}
