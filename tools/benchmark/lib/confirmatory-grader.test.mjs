import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeConfirmatoryRepository } from "../guest/confirmatory-grader.mjs";

const passing = {
  "claude-code-templates-shell-boundary": {
    maliciousAgentRejected: true,
    agentArgumentsLiteral: true,
    promptArgumentsLiteral: true,
    windowsCommandResolutionSafe: true,
    validAgentPreserved: true,
    validPromptPreserved: true,
    taskLifecyclePreserved: true,
  },
  "material-search-suggestion-text": {
    activeMarkupPrevented: true,
    ordinarySuggestionPreserved: true,
    whitespacePreserved: true,
    rightArrowPreserved: true,
  },
  "lightrag-wildcard-cors-credentials": {
    wildcardCredentialsDisabled: true,
    explicitOriginsParsed: true,
    explicitOriginsCredentialsPreserved: true,
    corsOptionsPreserved: true,
  },
  "glances-configurable-cors-credentials": {
    defaultCredentialsDisabled: true,
    configuredWildcardCredentialsDisabled: true,
    explicitOriginsPreserved: true,
    configuredMethodsHeadersPreserved: true,
  },
  "sagemaker-triton-tls-verification": {
    defaultHttpsContextPreserved: true,
    moduleLoads: true,
    modelContractPreserved: true,
    diagnosticsPreserved: true,
  },
  "yamcs-extension-element-construction": {
    malformedNameRejected: true,
    markupInjectionPrevented: true,
    validElementCreated: true,
    extensionPropertiesPreserved: true,
    reloadBehaviorPreserved: true,
  },
  "claude-code-templates-loopback-control": {
    sourceSha256: "control-source",
    loopbackBound: true,
    onlyLocalOriginsAllowed: true,
    localhostOriginPreserved: true,
    loopbackOriginPreserved: true,
    serverStarts: true,
  },
  "liveatlas-entity-decoder-control": {
    sourceSha256: "control-source",
    activeMarkupPrevented: true,
    namedEntitiesDecoded: true,
    numericEntitiesDecoded: true,
    ordinaryTextPreserved: true,
    detachedDecoderPreserved: true,
  },
};

function grade(id, observed = passing[id]) {
  return gradeConfirmatoryRepository(
    {
      id,
      repository: "fixture",
      runtime:
        id === "lightrag-wildcard-cors-credentials" ||
        id === "glances-configurable-cors-credentials" ||
        id === "sagemaker-triton-tls-verification"
          ? "python"
          : "node",
      controlSourceSha256: id.endsWith("control") ? "control-source" : undefined,
    },
    "/candidate",
    () => observed,
  );
}

test("passes every qualified repair and negative-control observation", () => {
  for (const id of Object.keys(passing)) {
    const result = grade(id);
    assert.equal(result.acceptancePass, true, id);
    assert.equal(result.regressionsPass, true, id);
    assert.ok(result.acceptance.length > 0, id);
    assert.ok(result.regressions.length > 0, id);
  }
});

test("fails each case when its primary acceptance property is false", () => {
  for (const [id, observed] of Object.entries(passing)) {
    const changed = structuredClone(observed);
    const key = Object.keys(changed).find((name) => name !== "sourceSha256");
    changed[key] = false;
    assert.equal(grade(id, changed).acceptancePass, false, id);
  }
});

test("requires negative controls to remain byte-for-byte unchanged", () => {
  for (const id of ["claude-code-templates-loopback-control", "liveatlas-entity-decoder-control"]) {
    const changed = structuredClone(passing[id]);
    changed.sourceSha256 = "modified-source";
    const result = grade(id, changed);
    assert.equal(result.acceptancePass, false, id);
    assert.match(JSON.stringify(result.acceptance), /unchanged/i);
  }
});

test("keeps compatibility behavior separate from primary acceptance", () => {
  const observed = structuredClone(passing["lightrag-wildcard-cors-credentials"]);
  observed.corsOptionsPreserved = false;
  const result = grade("lightrag-wildcard-cors-credentials", observed);
  assert.equal(result.acceptancePass, true);
  assert.equal(result.regressionsPass, false);
});

test("requires suggestion whitespace to survive the rendering fix", () => {
  const observed = structuredClone(passing["material-search-suggestion-text"]);
  observed.whitespacePreserved = false;
  const result = grade("material-search-suggestion-text", observed);
  assert.equal(result.acceptancePass, true);
  assert.equal(result.regressionsPass, false);
  assert.match(JSON.stringify(result.regressions), /whitespace/i);
});

test("requires shell-free Windows command-shim resolution", () => {
  const observed = structuredClone(passing["claude-code-templates-shell-boundary"]);
  observed.windowsCommandResolutionSafe = false;
  const result = grade("claude-code-templates-shell-boundary", observed);
  assert.equal(result.acceptancePass, false);
  assert.match(JSON.stringify(result.acceptance), /Windows/i);
});

test("rejects unknown confirmatory cases", () => {
  assert.throws(() => grade("unknown-case", {}), /unsupported/i);
});
