import { parseArgs } from "node:util";

export function repositoryStudyArguments(args) {
  const [qualificationDirectory, workflowDirectory, output, ...options] = args;
  if (!qualificationDirectory || !workflowDirectory || !output)
    throw new Error(
      "Usage: prepare-repository-study.mjs QUALIFICATION_DIRECTORY WORKFLOW_DIRECTORY NEW_RUN_DIRECTORY",
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
    qualificationDirectory,
    workflowDirectory,
    output,
    continueFrom: values["continue-from"],
    reason: values.reason,
  };
}
