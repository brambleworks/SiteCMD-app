import { pilotPolicy } from "./workflow-pilot.mjs";

export function codexPilotWindows(reading) {
  const buckets = reading.rateLimitsByLimitId ?? { codex: reading.rateLimits };
  const primary = buckets.codex;
  if (
    primary?.limitId !== "codex" ||
    primary.credits?.hasCredits !== false ||
    primary.credits?.unlimited !== false ||
    primary.credits?.balance !== "0"
  )
    throw new Error("Codex quota or disabled extra-credit evidence unavailable");
  for (const [id, bucket] of Object.entries(buckets)) {
    if (id === "codex") continue;
    const excluded = {
      base_model_inference: "gpt-reserve",
      codex_bengalfox: "GPT-5.3-Codex-Spark",
    }[id];
    if (
      !excluded ||
      bucket.limitId !== id ||
      bucket.limitName !== excluded ||
      pilotPolicy.models.some(({ model }) => model.toLowerCase() === excluded.toLowerCase())
    )
      throw new Error("Unrecognized or applicable Codex quota bucket requires review");
  }
  return [primary.primary, primary.secondary].filter(Boolean).map((window) => {
    if (![300, 10080].includes(window.windowDurationMins) || !Number.isFinite(window.usedPercent))
      throw new Error("Codex returned an unsupported quota window");
    const kind = window.windowDurationMins === 10080 ? "weekly" : "session";
    return {
      id: `codex-${kind}`,
      kind,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
    };
  });
}
