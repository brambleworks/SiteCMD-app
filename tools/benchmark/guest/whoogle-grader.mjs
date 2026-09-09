import { randomBytes } from "node:crypto";
import { executeCandidate } from "./candidate-sandbox.mjs";

function rejected(response) {
  return [400, 403, 404].includes(response?.status);
}

function body(response) {
  try {
    return JSON.parse(response?.body ?? "");
  } catch {
    return {};
  }
}

export function gradeWhoogle(candidate, execute = executeCandidate, repositoryRuntime) {
  const nonce = randomBytes(12).toString("hex");
  const input = {
    operation: "config-paths",
    writeMarker: `write-${nonce}`,
    readMarker: `read-${nonce}`,
  };
  const item = {
    id: "whoogle-named-config-path",
    runtime: "python",
    repositoryRuntime,
  };
  const observed = execute(item, candidate, input);
  const security = observed.security ?? {};
  const ordinary = observed.ordinary ?? {};
  const acceptance = [
    {
      name: "Traversal name cannot write outside the config directory",
      actual: security.traversalWrite ?? observed,
      pass: rejected(security.traversalWrite?.response) && !security.traversalWrite?.outsideExists,
    },
    {
      name: "Absolute name cannot write outside the config directory",
      actual: security.absoluteWrite ?? observed,
      pass: rejected(security.absoluteWrite?.response) && !security.absoluteWrite?.outsideExists,
    },
    {
      name: "Traversal name cannot load an outside configuration",
      actual: security.traversalRead ?? observed,
      pass:
        rejected(security.traversalRead) &&
        !String(security.traversalRead?.body ?? "").includes(input.readMarker),
    },
    {
      name: "Absolute name cannot load an outside configuration",
      actual: security.absoluteRead ?? observed,
      pass:
        rejected(security.absoluteRead) &&
        !String(security.absoluteRead?.body ?? "").includes(input.readMarker),
    },
    ...(security.invalidNames ?? []).map((response, index) => ({
      name: `Invalid configuration name ${index + 1} is rejected`,
      actual: response,
      pass: rejected(response),
    })),
  ];
  const unnamed = body(ordinary.unnamedGet);
  const named = body(ordinary.namedLoad);
  const after = body(ordinary.afterRejected);
  const regressions = [
    {
      name: "Unnamed configuration save keeps its redirect",
      actual: ordinary.unnamedSave ?? observed,
      pass:
        ordinary.unnamedSave?.status === 302 &&
        ordinary.unnamedSave?.location?.endsWith("/ordinary"),
    },
    {
      name: "Unnamed configuration remains readable",
      actual: ordinary.unnamedGet ?? observed,
      pass:
        ordinary.unnamedGet?.status === 200 &&
        unnamed.url === "/ordinary" &&
        unnamed.theme === "dark",
    },
    {
      name: "Valid named configuration is saved inside the config directory",
      actual: ordinary.namedSave ?? observed,
      pass: ordinary.namedSave?.response?.status === 302 && ordinary.namedSave?.insideExists,
    },
    {
      name: "Valid named configuration remains loadable",
      actual: ordinary.namedLoad ?? observed,
      pass: ordinary.namedLoad?.status === 200 && named.url === "/named" && named.theme === "light",
    },
    {
      name: "Configuration-disable policy remains enforced",
      actual: ordinary.disabled ?? observed,
      pass: ordinary.disabled?.status === 403,
    },
    {
      name: "Valid request works after rejected requests",
      actual: ordinary.afterRejected ?? observed,
      pass:
        ordinary.afterRejected?.status === 200 && after.url === "/named" && after.theme === "light",
    },
  ];
  return {
    acceptance,
    regressions,
    acceptancePass: acceptance.length === 6 && acceptance.every((check) => check.pass),
    regressionsPass: regressions.every((check) => check.pass),
  };
}
