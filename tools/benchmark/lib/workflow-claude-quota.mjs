import { digest } from "./workflow-plan.mjs";

export function claudePilotWindows(reading, now = Date.now()) {
  if (reading.extra_usage?.is_enabled !== false || reading.spend?.enabled !== false)
    throw new Error("Claude does not report paid usage disabled");
  return reading.limits.map((limit) => {
    if (!["session", "weekly"].includes(limit.group) || !Number.isFinite(limit.percent))
      throw new Error("Claude returned an unsupported quota window");
    const inactive =
      limit.group === "session" &&
      limit.is_active === false &&
      limit.percent === 0 &&
      limit.resets_at === null;
    const reset = Date.parse(limit.resets_at);
    if (!inactive && (!Number.isFinite(reset) || reset <= now))
      throw new Error("Claude quota reset is unavailable or expired");
    return {
      id: limit.kind + (limit.scope ? `-${digest(limit.scope).slice(0, 12)}` : ""),
      kind: limit.group,
      usedPercent: limit.percent,
      resetsAt: inactive ? null : new Date(Math.round(reset / 60000) * 60000).toISOString(),
      ...(inactive ? { inactive: true } : {}),
    };
  });
}
