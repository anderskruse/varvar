const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local time as "2026-11-01T14:30", the format used in handoff front matter. */
export function localMinute(d: Date = new Date()): string {
  return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date as "2026-11-01". */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-11-01-1430", used as a handoff file name prefix. */
export function fileStamp(d: Date = new Date()): string {
  return `${localDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Parse the date formats we write and read (ISO, "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", "YYYY-MM-DD HH:mm"). */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const str = String(s).trim();
  // "YYYY-MM-DD HH:mm" is not reliably parsed by Date; normalise the separator.
  const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? str.replace(' ', 'T') : str;
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toTime(s: string | null | undefined): number {
  return parseDate(s)?.getTime() ?? 0;
}

/** "3 days ago" style, for UI and agent summaries. */
export function relativeTime(s: string | null | undefined, now: number = Date.now()): string {
  const t = toTime(s);
  if (!t) return 'never';
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = abs;
  let unit = 'second';
  for (const [size, name] of units) {
    unit = name;
    if (value < size) break;
    value /= size;
  }
  const n = Math.floor(value);
  if (unit === 'second' && n < 45) return diff >= 0 ? 'just now' : 'in a moment';
  const label = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

export function daysBetween(a: number, b: number): number {
  return Math.abs(a - b) / 86_400_000;
}
