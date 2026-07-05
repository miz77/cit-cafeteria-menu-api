export function dateInAsiaTokyo(now = new Date()): string {
  return formatDateInTimeZone(now, "Asia/Tokyo");
}

export function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) throw new Error(`Failed to format date in ${timeZone}`);
  return `${year}-${month}-${day}`;
}

export function mondayWeekStart(dateString: string): string {
  const date = parseDateOnly(dateString);
  const day = date.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
}

export function parseDateOnly(dateString: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error(`Invalid date: ${dateString}`);
  }

  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) {
    throw new Error(`Invalid calendar date: ${dateString}`);
  }

  return date;
}

export function inferDateFromMonthDay(month: number, day: number, referenceDate: string): string {
  const reference = parseDateOnly(referenceDate);
  const referenceYear = reference.getUTCFullYear();
  const candidates = [referenceYear - 1, referenceYear, referenceYear + 1]
    .map((year) => new Date(Date.UTC(year, month - 1, day)))
    .filter((candidate) => candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day)
    .sort((a, b) => Math.abs(a.getTime() - reference.getTime()) - Math.abs(b.getTime() - reference.getTime()));

  const best = candidates[0];
  if (!best) throw new Error(`Invalid month/day: ${month}/${day}`);
  return best.toISOString().slice(0, 10);
}
