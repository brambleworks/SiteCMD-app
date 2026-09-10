import assert from "node:assert/strict";
import { test } from "node:test";
import { trialConfigurations, trialInvocation } from "./trial-invocation.mjs";
import { pilotPolicy } from "./workflow-pilot.mjs";
import { repositoryStudyPolicy } from "./workflow-repository-study.mjs";

const options = {
  workspace: "/srv/sitecmd-benchmark/workspaces/abc",
  channel: "/run/sitecmd-benchmark/abc",
  proxy: "/run/sitecmd-benchmark/proxy.mjs",
  arm: "normal",
};
const repositoryRuntime = {
  id: "a".repeat(64),
  installationId: "b".repeat(24),
  manifest: { caseId: "whoogle-named-config-path" },
};
repositoryRuntime.directory = `/opt/sitecmd-benchmark/repository-runtimes/${repositoryRuntime.id}/${repositoryRuntime.installationId}`;

test("every model and workflow disables incidental Python bytecode", () => {
  for (const selection of pilotPolicy.models) {
    for (const arm of pilotPolicy.arms) {
      const { args, env } = trialInvocation({ ...options, ...selection, arm });
      assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
      if (selection.agent === "codex")
        assert.ok(
          args.some(
            (value) =>
              value.startsWith("shell_environment_policy.set=") &&
              value.includes('PYTHONDONTWRITEBYTECODE="1"'),
          ),
        );
    }
  }
});

test("repository trials activate the frozen runtime and redirect Python caches", () => {
  for (const selection of repositoryStudyPolicy.models) {
    const { args, env } = trialInvocation({
      ...options,
      ...selection,
      repositoryRuntime,
    });
    const virtualEnvironment = `${repositoryRuntime.directory}/environment/venv`;
    assert.equal(env.VIRTUAL_ENV, virtualEnvironment);
    assert.equal(env.PYTHONPYCACHEPREFIX, "/tmp/sitecmd-python-cache");
    assert.equal(env.PYTEST_ADDOPTS, "-o cache_dir=/tmp/sitecmd-pytest-cache");
    assert.equal(env.STATIC_FOLDER, `${options.channel}/runtime/static`);
    assert.equal(env.CONFIG_VOLUME, `${options.channel}/runtime/config`);
    assert.ok(env.PATH.startsWith(`${virtualEnvironment}/bin:`));
    if (selection.agent === "codex") {
      assert.ok(
        args.some(
          (value) =>
            value.startsWith("permissions.benchmark=") &&
            value.includes(`${JSON.stringify(repositoryRuntime.directory)}="read"`) &&
            value.includes(`${JSON.stringify(`${options.channel}/runtime`)}="write"`),
        ),
      );
      assert.ok(
        args.some(
          (value) =>
            value.startsWith("shell_environment_policy.set=") &&
            value.includes('PYTHONPYCACHEPREFIX="/tmp/sitecmd-python-cache"'),
        ),
      );
    } else {
      const { sandbox } = JSON.parse(args[args.indexOf("--settings") + 1]);
      assert.ok(sandbox.filesystem.allowRead.includes(repositoryRuntime.directory));
      assert.ok(sandbox.filesystem.allowWrite.includes(`${options.channel}/runtime`));
    }
  }
});

test("Codex trials force subscription authentication, fresh state and no delegated agents", () => {
  const { args } = trialInvocation({ ...options, agent: "codex", model: "gpt-5.6-sol" });
  assert.ok(args.includes("gpt-5.6-sol"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(
    !args.some((value) => value.includes("dangerously") || value.includes("mcp_servers.sitecmd")),
  );
});

test("sandboxed clients use a file channel without Unix socket exceptions", () => {
  for (const selection of pilotPolicy.models) {
    const { args } = trialInvocation({ ...options, ...selection });
    assert.doesNotMatch(JSON.stringify(args), /unix_sockets|allowUnixSockets|allowAllUnixSockets/);
    if (selection.agent === "claude") {
      const { sandbox } = JSON.parse(args[args.indexOf("--settings") + 1]);
      assert.deepEqual(sandbox.filesystem.allowWrite, [`${options.channel}/requests`]);
      assert.ok(sandbox.filesystem.allowRead.includes(options.channel));
      assert.equal(sandbox.allowUnsandboxedCommands, false);
    } else {
      const permissions = args.find((value) => value.startsWith("permissions.benchmark="));
      assert.ok(permissions.includes(`${JSON.stringify(options.channel)}="read"`));
      assert.ok(permissions.includes(`${JSON.stringify(`${options.channel}/requests`)}="write"`));
    }
  }
});

test("Claude uses explicit subscription-compatible settings and only the assigned MCP server", () => {
  for (const arm of ["normal", "report", "mcp"]) {
    const { args, env } = trialInvocation({
      ...options,
      agent: "claude",
      model: "claude-opus-5",
      arm,
    });
    assert.ok(args.includes("claude-opus-5"));
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(!args.some((value) => /fallback|bypass|--bare|--safe-mode/.test(value)));
    const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    assert.equal(Object.hasOwn(mcp.mcpServers, "sitecmd"), arm === "mcp");
    assert.equal(env.DISABLE_AUTOUPDATER, "1");
  }
});

test("each workflow selects its exact approved model and rejects Fable without fallback", () => {
  for (const { agent, model } of pilotPolicy.models) {
    for (const arm of pilotPolicy.arms) {
      const { command, args } = trialInvocation({ ...options, agent, model, arm });
      assert.equal(command, agent);
      assert.equal(args[args.indexOf("--model") + 1], model);
    }
  }
  for (const selection of [
    { agent: "claude", model: "claude-fable-5-1" },
    { agent: "codex", model: "claude-opus-5" },
    { agent: "claude", model: "gpt-6-astra" },
    { agent: "codex", model: "latest" },
    { agent: "codex" },
    { agent: "claude" },
  ]) {
    assert.throws(() => trialInvocation({ ...options, ...selection }), /Unsupported/);
  }
});

test("repository calibration invokes every frozen model including Daybreak", () => {
  const configurations = trialConfigurations(
    "isolated repository calibration",
    repositoryStudyPolicy.models,
  );
  assert.equal(configurations.length, 4);
  for (const { agent, model } of repositoryStudyPolicy.models) {
    const { command, args } = trialInvocation({ ...options, agent, model });
    assert.equal(command, agent);
    assert.equal(args[args.indexOf("--model") + 1], model);
  }
});

test("unsupported agents and arms fail rather than choosing a fallback", () => {
  assert.throws(() => trialInvocation({ ...options, agent: "other" }), /Unsupported/);
  assert.throws(() => trialInvocation({ ...options, agent: "codex", arm: "brief" }), /Unsupported/);
});
