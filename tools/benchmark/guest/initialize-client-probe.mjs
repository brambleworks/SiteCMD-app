import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function initializeClientProbe(invocation, workspace) {
  if (process.platform !== "linux" || process.getuid() !== 0)
    throw new Error("Client initialization probe requires the guest controller");
  if (invocation.command !== "claude") throw new Error("The initialization probe requires Claude");
  return new Promise((resolve, reject) => {
    let initialized = false;
    let failure;
    const child = spawn(
      "sudo",
      [
        "-u",
        "runner",
        "env",
        ...Object.entries(invocation.env).map(([key, value]) => `${key}=${value}`),
        "/usr/local/bin/claude",
        ...invocation.args,
      ],
      { cwd: workspace, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") failure = error;
      }
    };
    const stop = (error) => {
      failure = error;
      kill("SIGTERM");
    };
    const timer = setTimeout(() => stop(new Error("Client initialization probe timed out")), 30000);
    const hardStop = setTimeout(() => kill("SIGKILL"), 32000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      failure = error;
    });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "assistant")
        return stop(new Error("Unexpected inference event in initialization probe"));
      if (event.type !== "control_response" || event.response?.request_id !== "no-model-probe")
        return;
      if (event.response.subtype !== "success")
        return stop(new Error("Client initialization probe failed"));
      initialized = true;
      child.stdin.end();
    });
    child.once("close", () => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      lines.close();
      if (failure || !initialized) reject(failure ?? new Error("Client did not initialize"));
      else resolve();
    });
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "no-model-probe",
        request: { subtype: "initialize" },
      }) + "\n",
    );
  });
}
