// The counting rules from the plan's answers: required meetings only (Q4); picking counts days assigned, credit counts Done (Q10).
import test from "node:test";
import assert from "node:assert/strict";
import { assignedDays, choreMeetings, creditedDays, isChoreDay, pickingOrder, untickedPast, type LedgerRow } from "../src/ledger.ts";

const row = (memberId: string | null, runDate: string, status: LedgerRow["status"], done = false, dryRun = false): LedgerRow => ({ memberId, runDate, status, done, dryRun });

test("only required meetings get chores; no meetings, or Attendance unavailable, is no chore day", () => {
  const meetings = [{ id: "mt-1", required: false }, { id: "mt-2", required: true }];
  assert.deepEqual(choreMeetings(meetings).map((meeting) => meeting.id), ["mt-2"]);
  assert.equal(isChoreDay(meetings), true);
  assert.equal(isChoreDay([{ id: "mt-1", required: false }]), false, "an optional meeting alone is not a chore day");
  assert.equal(isChoreDay([]), false);
  assert.equal(isChoreDay(undefined), false);
});

test("picking counts days assigned, Done or not; credit counts only Done", () => {
  const rows = [
    row("m-a", "2026-11-02", "assigned", false), row("m-a", "2026-11-03", "assigned", true), row("m-a", "2026-11-04", "replacement", false),
    row("m-b", "2026-11-02", "assigned", true),
    // Reassigned-away and unfilled slots count for nobody; dry-run rows never count.
    row("m-c", "2026-11-02", "reassigned", true), row(null, "2026-11-02", "unfilled"), row("m-c", "2026-11-03", "assigned", true, true),
    // Two rows for one member on one day count once.
    row("m-b", "2026-11-05", "assigned", true), row("m-b", "2026-11-05", "replacement", true),
  ];
  assert.deepEqual(Object.fromEntries(assignedDays(rows, null)), { "m-a": 3, "m-b": 2 });
  assert.deepEqual(Object.fromEntries(creditedDays(rows, null)), { "m-a": 1, "m-b": 2 });
  // Only since the season start, and only before a given day when asked.
  assert.deepEqual(Object.fromEntries(assignedDays(rows, "2026-11-03")), { "m-a": 2, "m-b": 1 });
  assert.deepEqual(Object.fromEntries(assignedDays(rows, null, "2026-11-04")), { "m-a": 2, "m-b": 1 });
});

test("a member who never ticks Done is not picked again ahead of others for that reason", () => {
  const rows = [row("m-a", "2026-11-02", "assigned", false), row("m-a", "2026-11-03", "assigned", false), row("m-b", "2026-11-02", "assigned", true)];
  const order = pickingOrder(["m-a", "m-b", "m-c"], assignedDays(rows, null), () => 0);
  assert.deepEqual(order, ["m-c", "m-b", "m-a"]);
});

test("ties are broken by the run's seeded order, so the same inputs give the same order", () => {
  const seeded = new Map([["m-a", 0.7], ["m-b", 0.1], ["m-c", 0.4]]);
  const order = () => pickingOrder(["m-a", "m-b", "m-c", "m-a"], new Map(), (member) => seeded.get(member)!);
  assert.deepEqual(order(), ["m-b", "m-c", "m-a"]);
  assert.deepEqual(order(), order());
});

test("unticked past chores are listed for follow-up; today's are not yet", () => {
  const rows = [row("m-a", "2026-11-02", "assigned", false), row("m-a", "2026-11-03", "assigned", true), row("m-b", "2026-11-06", "assigned", false), row("m-c", "2026-11-02", "reassigned", false)];
  assert.deepEqual(untickedPast(rows, null, "2026-11-06").map((item) => `${item.memberId} ${item.runDate}`), ["m-a 2026-11-02"]);
});
