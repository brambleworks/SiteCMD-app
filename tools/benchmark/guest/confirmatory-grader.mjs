import { executeCandidate } from "./candidate-sandbox.mjs";

function check(name, actual) {
  return { name, actual, pass: actual === true };
}

function unchanged(item, observed) {
  return check(
    "The negative-control source remains unchanged",
    observed.sourceSha256 === item.controlSourceSha256,
  );
}

function gradeClaudeShell(observed) {
  return {
    acceptance: [
      check("Malformed agent names are rejected before execution", observed.maliciousAgentRejected),
      check("Agent names remain literal process arguments", observed.agentArgumentsLiteral),
      check("Prompts remain literal process arguments", observed.promptArgumentsLiteral),
      check(
        "Windows command shims resolve without a command shell",
        observed.windowsCommandResolutionSafe,
      ),
    ],
    regressions: [
      check("Valid agent installation still starts", observed.validAgentPreserved),
      check("Valid local prompts still start", observed.validPromptPreserved),
      check("Task status and output still complete", observed.taskLifecyclePreserved),
    ],
  };
}

function gradeMaterial(observed) {
  return {
    acceptance: [
      check("Suggestion content cannot create active markup", observed.activeMarkupPrevented),
    ],
    regressions: [
      check("Ordinary suggestions remain visible", observed.ordinarySuggestionPreserved),
      check("Suggestion whitespace remains unchanged", observed.whitespacePreserved),
      check("Right-arrow suggestion acceptance remains available", observed.rightArrowPreserved),
    ],
  };
}

function gradeLightRag(observed) {
  return {
    acceptance: [
      check("Wildcard origins disable credentialed CORS", observed.wildcardCredentialsDisabled),
    ],
    regressions: [
      check("Explicit origin lists still parse correctly", observed.explicitOriginsParsed),
      check(
        "Explicit origin lists retain credential support",
        observed.explicitOriginsCredentialsPreserved,
      ),
      check("Existing CORS methods, headers, and exposures remain", observed.corsOptionsPreserved),
    ],
  };
}

function gradeGlances(observed) {
  return {
    acceptance: [
      check("Default wildcard CORS disables credentials", observed.defaultCredentialsDisabled),
      check(
        "Configured wildcard CORS cannot enable credentials",
        observed.configuredWildcardCredentialsDisabled,
      ),
    ],
    regressions: [
      check("Explicit origin configuration remains available", observed.explicitOriginsPreserved),
      check(
        "Configured CORS methods and headers remain available",
        observed.configuredMethodsHeadersPreserved,
      ),
    ],
  };
}

function gradeSageMaker(observed) {
  return {
    acceptance: [
      check(
        "Importing the backend preserves the default HTTPS context",
        observed.defaultHttpsContextPreserved,
      ),
    ],
    regressions: [
      check("The Triton model backend still imports", observed.moduleLoads),
      check("The Triton model class contract remains", observed.modelContractPreserved),
      check("Preflight diagnostics remain callable", observed.diagnosticsPreserved),
    ],
  };
}

function gradeYamcs(observed) {
  return {
    acceptance: [
      check("Malformed custom-element names are rejected", observed.malformedNameRejected),
      check("Extension route data cannot create markup", observed.markupInjectionPrevented),
    ],
    regressions: [
      check("Valid custom elements are still created", observed.validElementCreated),
      check(
        "Extension service and subroute properties remain assigned",
        observed.extensionPropertiesPreserved,
      ),
      check("Navigation reload behavior remains available", observed.reloadBehaviorPreserved),
    ],
  };
}

function gradeClaudeLoopback(item, observed) {
  return {
    acceptance: [
      unchanged(item, observed),
      check("The command server remains bound to loopback", observed.loopbackBound),
      check("Non-local browser origins remain rejected", observed.onlyLocalOriginsAllowed),
    ],
    regressions: [
      check("The localhost UI origin remains allowed", observed.localhostOriginPreserved),
      check("The numeric loopback UI origin remains allowed", observed.loopbackOriginPreserved),
      check("The local server still starts", observed.serverStarts),
    ],
  };
}

function gradeLiveAtlas(item, observed) {
  return {
    acceptance: [
      unchanged(item, observed),
      check("Decoded input cannot create active document markup", observed.activeMarkupPrevented),
    ],
    regressions: [
      check("Named HTML entities still decode", observed.namedEntitiesDecoded),
      check("Numeric HTML entities still decode", observed.numericEntitiesDecoded),
      check("Ordinary text remains unchanged", observed.ordinaryTextPreserved),
      check("The decoder remains detached from the document", observed.detachedDecoderPreserved),
    ],
  };
}

export function gradeConfirmatoryRepository(item, candidate, execute = executeCandidate) {
  const observed = execute(item, candidate, {
    operation: item.id,
    controlSourceSha256: item.controlSourceSha256,
  });
  const grades =
    item.id === "claude-code-templates-shell-boundary"
      ? gradeClaudeShell(observed)
      : item.id === "material-search-suggestion-text"
        ? gradeMaterial(observed)
        : item.id === "lightrag-wildcard-cors-credentials"
          ? gradeLightRag(observed)
          : item.id === "glances-configurable-cors-credentials"
            ? gradeGlances(observed)
            : item.id === "sagemaker-triton-tls-verification"
              ? gradeSageMaker(observed)
              : item.id === "yamcs-extension-element-construction"
                ? gradeYamcs(observed)
                : item.id === "claude-code-templates-loopback-control"
                  ? gradeClaudeLoopback(item, observed)
                  : item.id === "liveatlas-entity-decoder-control"
                    ? gradeLiveAtlas(item, observed)
                    : (() => {
                        throw new Error("Unsupported confirmatory repository grader");
                      })();
  return {
    ...grades,
    ...(observed?.error ? { probeError: observed } : {}),
    acceptancePass: grades.acceptance.every((grade) => grade.pass),
    regressionsPass: grades.regressions.every((grade) => grade.pass),
  };
}
