import { parseArgs } from "node:util";

const usage =
  "Usage: screen-repository-corpus.mjs INTAKE_JSON NEW_OUTPUT_DIRECTORY --repository ID=GIT_DIRECTORY [...]";

export function repositoryCorpusArguments(args, repositoryIds) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { repository: { type: "string", multiple: true } },
  });
  if (positionals.length !== 2) throw new Error(usage);
  const repositories = new Map();
  for (const mapping of values.repository ?? []) {
    const separator = mapping.indexOf("=");
    const id = mapping.slice(0, separator);
    const directory = mapping.slice(separator + 1);
    if (separator < 1 || !directory || repositories.has(id))
      throw new Error("Each repository mapping must be a unique ID=GIT_DIRECTORY pair");
    repositories.set(id, directory);
  }
  const expected = new Set(repositoryIds);
  if (repositories.size !== expected.size || [...repositories].some(([id]) => !expected.has(id)))
    throw new Error("Repository mappings must exactly cover the intake repositories");
  return { intake: positionals[0], output: positionals[1], repositories };
}
