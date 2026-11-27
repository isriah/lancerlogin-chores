// The rules the picking engine (a later release) and the dashboard count by, decided in the plan's answers to Q4 and Q10.
// Pure functions, no network and no database, so they can be tested on their own and shared by the job and the routes.
//
// - Only required meetings get chores (Q4). Optional meetings are not chore days.
// - Picking counts days ASSIGNED: a day a member held a chore as Assigned or Replacement, whether or not Done was ticked
//   (Q10). Fewest assigned days since the season start goes first.
// - Credit counts Done: an assigned day with Done ticked in the Chore log. The dashboard shows it and lists unticked past
//   chores for follow-up; it never changes who is picked.
// - Dry-run rows and unfilled or reassigned-away slots count for nobody.

/** The fields of a day's meeting these rules read: Core's `DayMeeting` from `meetingsOnLocalDate` has them. */
export type MeetingLike = { readonly id: string; readonly required: boolean };

/** One holder of one chore slot on one day, as chores_assignments keeps it. */
export type LedgerRow = {
  readonly memberId: string | null; readonly runDate: string; readonly dryRun: boolean;
  readonly status: "assigned" | "replacement" | "reassigned" | "unfilled"; readonly done: boolean;
};

/** The day's meetings that get chores: required ones only. */
export const choreMeetings = <T extends MeetingLike>(meetings: readonly T[]): T[] => meetings.filter((meeting) => meeting.required === true);

/** Whether the day gets chores at all. Core answers `undefined` while Attendance is unavailable, which is never a chore day. */
export const isChoreDay = (meetings: readonly MeetingLike[] | undefined): boolean => Boolean(meetings && choreMeetings(meetings).length);

/** A live holding: a real (not dry-run) Assigned or Replacement row for a member, on or after the season start. */
const held = (row: LedgerRow, seasonStart: string | null, before?: string): row is LedgerRow & { memberId: string } =>
  !row.dryRun && row.memberId !== null && (row.status === "assigned" || row.status === "replacement")
  && (seasonStart === null || row.runDate >= seasonStart) && (before === undefined || row.runDate < before);

/** Distinct days per member that match, so two rows on one day (a slot moved during the day) count once. */
function countDays(rows: readonly LedgerRow[], keep: (row: LedgerRow & { memberId: string }) => boolean, seasonStart: string | null, before?: string): Map<string, number> {
  const days = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!held(row, seasonStart, before) || !keep(row)) continue;
    let set = days.get(row.memberId);
    if (!set) days.set(row.memberId, set = new Set());
    set.add(row.runDate);
  }
  return new Map([...days].map(([member, set]) => [member, set.size]));
}

/** Days each member was assigned a chore since the season start, Done or not. Picking goes by this. */
export const assignedDays = (rows: readonly LedgerRow[], seasonStart: string | null, before?: string) => countDays(rows, () => true, seasonStart, before);

/** Days each member was assigned a chore and ticked Done. Shown as credit; never used to pick. */
export const creditedDays = (rows: readonly LedgerRow[], seasonStart: string | null, before?: string) => countDays(rows, (row) => row.done, seasonStart, before);

/**
 * Members in picking order: fewest assigned days first, ties broken by `tieBreak` (the run's seeded random order), so the
 * same inputs always give the same order.
 */
export function pickingOrder(memberIds: readonly string[], assigned: ReadonlyMap<string, number>, tieBreak: (memberId: string) => number): string[] {
  return [...new Set(memberIds)].sort((a, b) => (assigned.get(a) ?? 0) - (assigned.get(b) ?? 0) || tieBreak(a) - tieBreak(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Past holdings left unticked, for the dashboard's follow-up list: before `today`, since the season start, Done empty. */
export const untickedPast = (rows: readonly LedgerRow[], seasonStart: string | null, today: string) =>
  rows.filter((row): row is LedgerRow & { memberId: string } => held(row, seasonStart, today) && !row.done);
