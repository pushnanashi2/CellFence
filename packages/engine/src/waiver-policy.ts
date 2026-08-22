import { isIsoDate, todayIsoDate } from "./dates.js";

export const MAX_WAIVER_DAYS = 30;

const APPROVER_PATTERN = /^(?:@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDateToUtcTime(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function waiverExpiryErrors(expires: string, today = todayIsoDate()): string[] {
  if (!expires || !isIsoDate(expires)) return ["expires must be YYYY-MM-DD"];
  const daysUntilExpiry = Math.floor((isoDateToUtcTime(expires) - isoDateToUtcTime(today)) / MS_PER_DAY);
  const errors: string[] = [];
  if (daysUntilExpiry < 0) errors.push("waiver is expired");
  if (daysUntilExpiry > MAX_WAIVER_DAYS) {
    errors.push(`expires must be no more than ${MAX_WAIVER_DAYS} days in the future`);
  }
  return errors;
}

export function waiverApprovalErrors(approvedBy: string): string[] {
  if (!approvedBy) return ["approved-by is required"];
  if (approvedBy.toUpperCase() === "PENDING") {
    return ["approved-by:PENDING is a request placeholder, not an approval"];
  }
  if (!APPROVER_PATTERN.test(approvedBy)) {
    return ["approved-by must be a GitHub handle, email address, or team slug"];
  }
  return [];
}
