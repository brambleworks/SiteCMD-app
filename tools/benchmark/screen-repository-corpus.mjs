import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { repositoryCorpusArguments } from "./lib/repository-corpus-arguments.mjs";
import { createRepositoryCorpusScreening } from "./lib/repository-corpus-receipt.mjs";
import { screenRepositoryCase } from "./lib/repository-corpus-screening.mjs";
import { validateRepositoryCorpusDefinition } from "./lib/repository-corpus.mjs";
import { requireCondition } from "./lib/workflow-contract.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";
import { workRoot } from "./lib/vm-guest.mjs";

function repositoryOrigin(repository) {
  const result = spawnSync(
    "git",
    ["-C", repository, "-c", "core.hooksPath=/dev/null", "remote", "get-url", "origin"],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0) throw new Error("Repository origin could not be read");
  return result.stdout
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

const rawIntake = JSON.parse(readFileSync(path.resolve(process.argv[2] ?? ""), "utf8"));
const intake = validateRepositoryCorpusDefinition(rawIntake);
const repositoryIds = [...new Set(intake.cases.map((item) => item.repository.id))].sort();
const args = repositoryCorpusArguments(process.argv.slice(2), repositoryIds);
const output = path.resolve(args.output);
const root = realpathSync(workRoot);
requireCondition(
  path.dirname(output) === root && /^[a-z0-9][a-z0-9.-]*$/.test(path.basename(output)),
  "Screening output must be a new direct child of tools/benchmark/.work",
);
requireCondition(!existsSync(output), "Screening output already exists");

const repositories = new Map(
  [...args.repositories].map(([id, repository]) => [id, realpathSync(path.resolve(repository))]),
);
const provenance = new Map();
for (const item of intake.cases) {
  const id = item.repository.id;
  if (!provenance.has(id))
    provenance.set(id, repositoryOrigin(repositories.get(id)) === item.repository.url);
}

const errors = [];
const screened = intake.cases.map((item) => {
  try {
    const result = screenRepositoryCase(item, repositories.get(item.repository.id));
    result.receipt.originVerified = provenance.get(item.repository.id);
    result.receipt.sourceCompatible &&= result.receipt.originVerified;
    return result;
  } catch (error) {
    errors.push(`${item.id}: ${error.message}`);
    return {
      receipt: {
        id: item.id,
        repository: item.repository.id,
        originVerified: provenance.get(item.repository.id),
        sourceCompatible: false,
        sourceError: "Pinned repository source could not be inspected",
      },
      sources: { baseline: null, upstream: null },
    };
  }
});
const screening = createRepositoryCorpusScreening(intake, screened, new Date().toISOString());
mkdirSync(output, { mode: 0o700 });
mkdirSync(path.join(output, "sources"), { mode: 0o700 });
writeNewJson(path.join(output, "intake.json"), intake);
for (const [name, source] of screening.sources) writeNewJson(path.join(output, name), source);
writeNewJson(path.join(output, "screening.json"), screening.receipt);

for (const error of errors) process.stderr.write(`${error}\n`);
const accepted = screening.receipt.cases.filter((item) => item.sourceCompatible).length;
process.stdout.write(
  `Screened ${screening.receipt.cases.length} cases; ${accepted} passed source intake.\n`,
);
if (!screening.receipt.passed) process.exitCode = 1;
