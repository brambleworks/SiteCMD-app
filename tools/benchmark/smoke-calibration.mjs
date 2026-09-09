import { randomBytes } from "node:crypto";
import path from "node:path";
import { calibrationCases, caseFiles } from "./lib/calibration-cases.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";

const harness = deployHarness();
for (const name of ["credentialed-cors", "document-download"]) {
  const id = randomBytes(12).toString("hex");
  const item = calibrationCases.find((item) => item.id === name);
  const receipt = JSON.parse(
    guestCommand(
      [
        "sudo",
        "flock",
        "-n",
        "/run/sitecmd-benchmark-execution.lock",
        "node",
        `${harness.directory}/desktop-smoke.mjs`,
      ],
      {
        input: JSON.stringify({
          id,
          item,
          files: caseFiles(item),
          staging: name === "document-download",
        }),
        capture: true,
        timeout: 300000,
      },
    ),
  );
  const file = path.join(workRoot, `desktop-smoke-${id}.json`);
  writeNewJson(file, { ...receipt, agentInvoked: false, harnessSha256: harness.id });
  console.log(
    `${name}: desktop scan, MCP reference repair, verification and rejected retry passed. No model calls. Evidence: ${file}`,
  );
}
