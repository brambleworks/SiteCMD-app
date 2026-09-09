import { exportPinnedTree, inspectPinnedTree } from "./repository-snapshot.mjs";

function changedFiles(baseline, reference) {
  const left = new Map(baseline.files.map((file) => [file.name, file]));
  const right = new Map(reference.files.map((file) => [file.name, file]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((name) => {
      const before = left.get(name);
      const after = right.get(name);
      return before?.mode !== after?.mode || before?.base64 !== after?.base64;
    })
    .sort();
}

function exportSource(repository, inspection, exclusions) {
  if (!inspection.sourceCompatible)
    return {
      snapshot: null,
      details: {
        ...inspection,
        sourceError:
          "Repository snapshot exceeds the source size limit or uses unsupported entries",
      },
    };
  try {
    const snapshot = exportPinnedTree(repository, inspection.commit, { exclusions });
    return { snapshot, details: { ...inspection, sourceSha256: snapshot.sha256 } };
  } catch (error) {
    return { snapshot: null, details: { ...inspection, sourceError: error.message } };
  }
}

export function screenRepositoryCase(item, repository) {
  const exclusions = item.sourceExclusions ?? [];
  const baselineInspection = inspectPinnedTree(repository, item.baselineCommit, { exclusions });
  const upstreamInspection = inspectPinnedTree(repository, item.upstreamCommit, { exclusions });
  const baselineSource = exportSource(repository, baselineInspection, exclusions);
  const upstreamSource = exportSource(repository, upstreamInspection, exclusions);
  const changes =
    baselineSource.snapshot && upstreamSource.snapshot
      ? changedFiles(baselineSource.snapshot, upstreamSource.snapshot)
      : [];
  const licensePresent = [baselineInspection, upstreamInspection].every((inspection) =>
    inspection.licenseFiles.includes(item.repository.licenseFile),
  );
  const protectedPathsPresent = [baselineInspection, upstreamInspection].every((inspection) =>
    [...item.editableFiles, item.repository.licenseFile].every(
      (name) => !inspection.excludedEntries.some((entry) => entry.name === name),
    ),
  );
  const referenceScopeValid =
    item.kind === "negative_control"
      ? changes.length === 0 && baselineSource.snapshot?.sha256 === upstreamSource.snapshot?.sha256
      : item.editableFiles.every((name) => changes.includes(name));
  const sourceSnapshotsPresent = Boolean(baselineSource.snapshot && upstreamSource.snapshot);
  return {
    receipt: {
      id: item.id,
      repository: item.repository.id,
      baseline: baselineSource.details,
      upstream: upstreamSource.details,
      changedFiles: changes,
      licensePresent,
      sourceExclusions: exclusions.map((exclusion) => ({
        ...exclusion,
        baselineEntries: baselineInspection.excludedEntries.filter(
          (entry) => entry.name === exclusion.path || entry.name.startsWith(`${exclusion.path}/`),
        ).length,
        upstreamEntries: upstreamInspection.excludedEntries.filter(
          (entry) => entry.name === exclusion.path || entry.name.startsWith(`${exclusion.path}/`),
        ).length,
      })),
      referenceScopeValid,
      sourceCompatible:
        baselineInspection.sourceCompatible &&
        upstreamInspection.sourceCompatible &&
        sourceSnapshotsPresent &&
        licensePresent &&
        protectedPathsPresent &&
        referenceScopeValid,
    },
    sources: { baseline: baselineSource.snapshot, upstream: upstreamSource.snapshot },
  };
}
