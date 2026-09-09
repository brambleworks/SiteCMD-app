import { digest } from "../lib/workflow-plan.mjs";
import { executeCandidate } from "./candidate-sandbox.mjs";
import { gradeTornado } from "./tornado-grader.mjs";
import { gradeLinkding } from "./linkding-grader.mjs";
import { probeLinkdingBrowser } from "./linkding-browser-grader.mjs";

export function gradeRepository(item, candidate, execute = executeCandidate) {
  if (item.id === "tornado-static-redirect") return gradeTornado(candidate, execute);
  if (item.id !== "linkding-asset-sandbox") throw new Error("Unsupported repository grader");
  const django = gradeLinkding(candidate, execute, item.repositoryRuntime);
  const browser = probeLinkdingBrowser(
    candidate,
    item.repositoryRuntime,
    item.browserRuntime,
    execute,
  );
  return {
    ...django,
    browser,
    runtimeSha256: digest(item.repositoryRuntime),
    browserRuntimeSha256: digest(item.browserRuntime),
    acceptancePass: django.acceptancePass && browser.acceptancePass,
    regressionsPass: django.regressionsPass && browser.regressionsPass,
  };
}
