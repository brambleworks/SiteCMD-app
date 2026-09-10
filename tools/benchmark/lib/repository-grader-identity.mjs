import { digest } from "./workflow-plan.mjs";

const commonFiles = [
  "guest/browser-inputs.mjs",
  "guest/browser-runtime.mjs",
  "guest/candidate-sandbox.mjs",
  "guest/desktop-session.mjs",
  "guest/flask-reuploaded-grader.mjs",
  "guest/flask-reuploaded-runtime.mjs",
  "guest/linkding-browser-grader.mjs",
  "guest/linkding-grader.mjs",
  "guest/linkding-runtime.mjs",
  "guest/confirmatory-grader.mjs",
  "guest/repository-grader.mjs",
  "guest/tornado-grader.mjs",
  "guest/whoogle-grader.mjs",
  "guest/whoogle-runtime.mjs",
  "lib/repository-runtime.mjs",
  "lib/workflow-contract.mjs",
  "lib/workflow-plan.mjs",
];

const caseFiles = {
  "tornado-static-redirect": ["guest/tornado-candidate.py"],
  "linkding-asset-sandbox": [
    "cases/linkding-calibration.json",
    "guest/linkding-browser.py",
    "guest/linkding-candidate.py",
    "guest/webdriver-session.py",
  ],
  "whoogle-named-config-path": ["cases/whoogle-calibration.json", "guest/whoogle-candidate.py"],
  "claude-code-templates-shell-boundary": [
    "guest/confirmatory-node-candidate.mjs",
    "vendor/typescript.cjs",
  ],
  "material-search-suggestion-text": [
    "guest/confirmatory-node-candidate.mjs",
    "vendor/typescript.cjs",
  ],
  "lightrag-wildcard-cors-credentials": ["guest/confirmatory-python-candidate.py"],
  "glances-configurable-cors-credentials": ["guest/confirmatory-python-candidate.py"],
  "sagemaker-triton-tls-verification": ["guest/confirmatory-python-candidate.py"],
  "yamcs-extension-element-construction": [
    "guest/confirmatory-node-candidate.mjs",
    "vendor/typescript.cjs",
  ],
  "claude-code-templates-loopback-control": [
    "guest/confirmatory-node-candidate.mjs",
    "vendor/typescript.cjs",
  ],
  "liveatlas-entity-decoder-control": [
    "guest/confirmatory-node-candidate.mjs",
    "vendor/typescript.cjs",
  ],
};

export function repositoryGraderFiles(caseId) {
  const selected = caseFiles[caseId];
  if (!selected) throw new Error(`Unsupported repository grader: ${caseId}`);
  return [...commonFiles, ...selected].sort();
}

export function repositoryGraderIdentity(files, caseId) {
  const selected = Object.fromEntries(
    repositoryGraderFiles(caseId).map((name) => {
      if (typeof files[name] !== "string") throw new Error(`Missing grader file: ${name}`);
      return [name, files[name]];
    }),
  );
  return digest(selected);
}
