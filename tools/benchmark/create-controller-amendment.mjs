import path from "node:path";
import {
  describeControllerAmendment,
  CONTROLLER_AMENDMENT_FILE,
} from "./lib/workflow-controller-amendment.mjs";
import { digest } from "./lib/workflow-plan.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";
import { harnessFiles } from "./lib/vm-harness.mjs";

const [directory, reason, ...extra] = process.argv.slice(2);
if (!directory || !reason || extra.length)
  throw new Error("Usage: create-controller-amendment.mjs RUN_DIRECTORY REASON");
const run = path.resolve(directory);
const files = harnessFiles();
const receipt = describeControllerAmendment(run, { id: digest(files), files }, reason);
writeNewJson(path.join(run, CONTROLLER_AMENDMENT_FILE), receipt);
console.log(`Recorded controller correction ${receipt.correctedRunnerSha256}.`);
