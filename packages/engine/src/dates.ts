export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) return false;
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function daysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(`${startIso}T00:00:00.000Z`);
  const end = Date.parse(`${endIso}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`daysBetween: invalid date input (${startIso} -> ${endIso})`);
  }
  return Math.round((end - start) / 86_400_000);
}
