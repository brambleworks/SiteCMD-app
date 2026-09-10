import { randomBytes } from "node:crypto";
import { executeCandidate } from "./candidate-sandbox.mjs";

function safeRedirect(response) {
  if (!response || response.error) return false;
  const location = response.headers?.location;
  if ([400, 403, 404].includes(response.status)) return location === undefined;
  if (![301, 302, 303, 307, 308].includes(response.status) || typeof location !== "string")
    return false;
  if (
    !/^\/(?![/\\])/.test(location) ||
    Array.from(location).some(
      (character) => character.codePointAt(0) <= 32 || character.codePointAt(0) === 127,
    )
  )
    return false;
  try {
    return new URL(location, "http://sitecmd.example").origin === "http://sitecmd.example";
  } catch {
    return false;
  }
}

export function gradeTornado(candidate, execute = executeCandidate) {
  const index = `Index ${randomBytes(12).toString("hex")}\n`;
  const asset = `Asset ${randomBytes(12).toString("hex")}\n`;
  const requests = [
    { path: "//attacker.invalid/..//tmp/sitecmd-static/dir" },
    { path: "//second.invalid/..//tmp/sitecmd-static/dir" },
    { path: "///attacker.invalid/..//tmp/sitecmd-static/dir" },
    { path: "//attacker.invalid/..//tmp/sitecmd-static/dir", method: "HEAD" },
    { path: "/dir" },
    { path: "/dir/" },
    { path: "/dir/asset.txt" },
    { path: "/dir/asset.txt", method: "HEAD" },
    { path: "/missing" },
    { path: "/../outside.txt" },
    { path: "/" },
  ];
  const item = { id: "tornado-static-redirect", runtime: "python" };
  const observation = execute(item, candidate, { operation: "http", requests, index, asset });
  const responses = Array.isArray(observation.responses) ? observation.responses : [];
  const acceptance = requests.slice(0, 4).map((request, i) => ({
    name: `Reject ambiguous redirect ${i + 1}`,
    request,
    actual: responses[i] ?? observation,
    pass: safeRedirect(responses[i]),
  }));
  const regressionChecks = [
    [
      "Directory redirect remains local",
      (r) => r?.status === 301 && r.headers?.location === "/dir/",
    ],
    ["Directory index is served", (r) => r?.status === 200 && r.body === index],
    ["Static asset is served", (r) => r?.status === 200 && r.body === asset],
    ["HEAD returns no body", (r) => r?.status === 200 && r.body === ""],
    ["Missing file stays missing", (r) => r?.status === 404],
    ["Path traversal remains blocked", (r) => r?.status === 403],
    ["Root index is served", (r) => r?.status === 200 && r.body === index],
  ];
  const regressions = regressionChecks.map(([name, check], i) => ({
    name,
    request: requests[i + 4],
    actual: responses[i + 4] ?? observation,
    pass: check(responses[i + 4]),
  }));
  const tests = execute(item, candidate, { operation: "public-tests" });
  regressions.push({
    name: "Existing static-file and redirect tests",
    actual: tests,
    pass:
      tests.exitCode === 0 &&
      /^Ran [1-9]\d* tests? in /m.test(tests.stderr ?? "") &&
      /\nOK\s*$/.test(tests.stderr ?? ""),
  });
  return {
    acceptance,
    regressions,
    acceptancePass: acceptance.every((check) => check.pass),
    regressionsPass: regressions.every((check) => check.pass),
  };
}
