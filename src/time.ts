// Local dates and hours in the installation's time zone, which Core provides through the SDK projection.
import { installationTimeZone, type D1Database } from "@lancerlogin/module-sdk/api";
import { installationId, type Database } from "./http.ts";

/** The installation's IANA time zone, or UTC when Core has none configured yet. */
export async function timeZone(db: Database): Promise<string> {
  try { return await installationTimeZone(db as unknown as D1Database, installationId); } catch { return "UTC"; }
}

type Parts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly second: number };

function parts(ms: number, zone: string): Parts {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour! % 24, minute: values.minute!, second: values.second! };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD in the zone. */
export function localDate(ms: number, zone: string): string {
  const { year, month, day } = parts(ms, zone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offset(ms: number, zone: string): number {
  const p = parts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The instant a local wall-clock hour starts. In a DST gap it lands on the first valid time after it. */
function localHourToUtc(year: number, month: number, day: number, hour: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - offset(wall, zone);
  return wall - offset(first, zone);
}

/** The next start of the given local hour strictly after `now`. */
export function nextLocalHour(now: number, zone: string, hour: number): number {
  const today = parts(now, zone);
  for (let add = 0; add < 3; add++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    const at = localHourToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, zone);
    if (at > now) return at;
  }
  return now + 24 * 60 * 60_000;
}
