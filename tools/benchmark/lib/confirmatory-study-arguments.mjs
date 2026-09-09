import { parseArgs } from "node:util";

export function confirmatoryStudyArguments(args) {
  const [
    screeningDirectory,
    eligibilityDirectory,
    qualificationDirectory,
    workflowDirectory,
    output,
    productFile,
    ...options
  ] = args;
  if (
    !screeningDirectory ||
    !eligibilityDirectory ||
    !qualificationDirectory ||
    !workflowDirectory ||
    !output ||
    !productFile
  )
    throw new Error(
      "Usage: prepare-confirmatory-study.mjs SCREENING_DIRECTORY ELIGIBILITY_DIRECTORY QUALIFICATION_DIRECTORY WORKFLOW_DIRECTORY NEW_RUN_DIRECTORY PRODUCT_RECEIPT",
    );
  const { values } = parseArgs({
    args: options,
    options: {
      "continue-from": { type: "string" },
      reason: { type: "string" },
    },
  });
  if (Boolean(values["continue-from"]) !== Boolean(values.reason))
    throw new Error("A continuation requires both --continue-from and --reason");
  return {
    screeningDirectory,
    eligibilityDirectory,
    qualificationDirectory,
    workflowDirectory,
    output,
    productFile,
    continueFrom: values["continue-from"],
    reason: values.reason,
  };
}
