import { digest } from "./workflow-plan.mjs";

function reportWithoutCaptureTime(raw) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error("Continuation scanner report is not valid JSON");
  }
  if (
    !report ||
    Array.isArray(report) ||
    typeof report !== "object" ||
    typeof report.checkedAt !== "string" ||
    !report.checkedAt
  )
    throw new Error("Continuation scanner report is missing its capture time");
  const { checkedAt: _checkedAt, ...stable } = report;
  return stable;
}

export function retainRepositoryReport(original, current) {
  if (digest(reportWithoutCaptureTime(original)) !== digest(reportWithoutCaptureTime(current)))
    throw new Error("Continuation scanner report changed beyond its capture time");
  return original;
}
