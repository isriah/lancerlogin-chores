// The People sync: matching by member ID (the roster's external ID), the writes that make People follow the roster, the
// task-database suggestions, and the job's slices through Core, including their budgets. Synthetic people only.
import "./helpers/sdk-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SliceCost } from "./helpers/harness.ts";
import { ids, notionResponse, peopleRow, personA, personB, seed, stubNotion, taskRow, type Stub } from "./helpers/notion-stub.ts";

const { default: api } = await import("../src/api.ts");
const { matchRows, planPeopleWrites, planSuggestions, mergeTaskPeople, normaliseName, maximumRequestsPerStep } = await import("../src/people.ts");

// Core's per-slice caps (scheduler-budget.ts scheduledSliceLimits) and its per-invocation Notion cap.
const sliceLimits = { total: 40, d1: 30, external: 12, notion: 8 };
const withinBudget = (cost: SliceCost, label: string) => {
  assert.ok(cost.total <= sliceLimits.total, `${label}: ${cost.total} subrequests`);
  assert.ok(cost.d1 <= sliceLimits.d1, `${label}: ${cost.d1} D1 queries`);
  assert.ok(cost.external <= sliceLimits.external, `${label}: ${cost.external} provider requests`);
  assert.ok(cost.notion <= sliceLimits.notion, `${label}: ${cost.notion} Notion requests`);
};

async function withHarness(run: (h: ReturnType<typeof createHarness>, notion: Stub) => Promise<void>) {
  const notion = stubNotion();
  try { await run(createHarness(api), notion); } finally { notion.restore(); }
}

const writes = (notion: Stub) => notion.calls.filter((call) => call.method === "POST" && call.path === "/pages" || call.method === "PATCH");
const accountWritten = (notion: Stub) => writes(notion).some((call) => Object.keys(call.body?.properties ?? {}).some((key) => decodeURIComponent(key) === "acct"));

test("a member matches only through one active People row with their member ID and exactly one Notion account", () => {
  const roster = [{ id: "m-a", externalId: "9001", firstName: "Test Student", lastName: "A" }, { id: "m-b", externalId: "9002", firstName: "Test Student", lastName: "B" }, { id: "m-c", externalId: "9003", firstName: "Test Student", lastName: "C" }];
  const rows = [
    { pageId: "p1", externalId: "9001", active: 1, accountCount: 1 },
    { pageId: "p2", externalId: " 9002 ", active: 1, accountCount: 0 },
    { pageId: "p3", externalId: "9003", active: 1, accountCount: 1 }, { pageId: "p4", externalId: "9003", active: 1, accountCount: 1 },
    { pageId: "p5", externalId: "", active: 1, accountCount: 1 },
    { pageId: "p6", externalId: "9999", active: 1, accountCount: 1 },
  ];
  assert.deepEqual(matchRows(rows, roster), [
    { pageId: "p1", memberId: "m-a", matchState: "matched" },
    { pageId: "p2", memberId: "m-b", matchState: "unmatched" },
    { pageId: "p3", memberId: "m-c", matchState: "ambiguous" }, { pageId: "p4", memberId: "m-c", matchState: "ambiguous" },
    { pageId: "p5", memberId: null, matchState: "unmatched" },
    { pageId: "p6", memberId: null, matchState: "unmatched" },
  ]);
  // An unticked row is not a match even with an account.
  assert.equal(matchRows([{ pageId: "p1", externalId: "9001", active: 0, accountCount: 1 }], roster)[0]!.matchState, "unmatched");
});

test("People follows the active roster: create, rename, re-tick and untick, never delete, and leave duplicates alone", () => {
  const roster = [{ id: "m-a", externalId: "9001", firstName: "Test Student", lastName: "A" }, { id: "m-b", externalId: "9002", firstName: "Test  Student", lastName: "B" }, { id: "m-d", externalId: "9004", firstName: "Test Student", lastName: "D" }, { id: "m-e", externalId: "9005", firstName: "Test Student", lastName: "E" }];
  const rows = [
    { pageId: "p1", externalId: "9001", name: "Test Student A", active: 1 },
    { pageId: "p2", externalId: "9002", name: "Old Name", active: 0 },
    { pageId: "p3", externalId: "9003", name: "Test Student C", active: 1 },
    { pageId: "p5", externalId: "9005", name: "x", active: 1 }, { pageId: "p6", externalId: "9005", name: "y", active: 1 },
    { pageId: "p7", externalId: "", name: "No ID", active: 1 },
  ];
  assert.deepEqual(planPeopleWrites(rows, roster), [
    { kind: "update", pageId: "p2", name: "Test Student B", active: true },
    { kind: "create", memberId: "m-d", externalId: "9004", name: "Test Student D" },
    { kind: "untick", pageId: "p3" },
  ]);
});

test("a suggestion needs a unique name on both sides, an empty Notion account and an account nobody has yet", () => {
  let found = mergeTaskPeople({}, [taskRow([{ id: personA, name: "Test Student A" }, { id: personB, name: "Test Student B" }, { id: "b1000000-0000-4000-8000-000000000000", name: "Bot", type: "bot" }])], ["ownr"]);
  found = mergeTaskPeople(found, [taskRow([{ id: "c0000000-0000-4000-8000-0000000000ff", name: "test student b" }])], ["ownr"]);
  assert.deepEqual(found, { [normaliseName("Test Student A")]: personA, [normaliseName("Test Student B")]: "*" });
  const rows = [
    { pageId: "p1", externalId: "9001", name: "Test Student A", active: 1, accountCount: 0, notionUserId: null, suggestedUserId: null },
    { pageId: "p2", externalId: "9002", name: "Test Student B", active: 1, accountCount: 0, notionUserId: null, suggestedUserId: null },
  ];
  assert.deepEqual(planSuggestions(rows, found), [{ pageId: "p1", notionUserId: personA }]);
  assert.deepEqual(planSuggestions([{ ...rows[0]!, accountCount: 1, notionUserId: "someone" }], found), []);
  assert.deepEqual(planSuggestions([{ ...rows[0]!, suggestedUserId: personA }], found), []);
  assert.deepEqual(planSuggestions([rows[0]!, { ...rows[0]!, pageId: "p9", externalId: "9009" }], found), [], "two rows with one name");
});

test("the job makes no Notion request while Chores is off, Core is not connected, or the databases are not verified as bound", () => withHarness(async (h, notion) => {
  assert.deepEqual((await h.slice()).outcome, { skipped: "disabled" });
  h.settings({ enabled: true, dryRun: false });
  assert.deepEqual((await h.slice()).outcome, { skipped: "notion_not_configured" });
  h.bindAll();
  assert.deepEqual((await h.slice()).outcome, { skipped: "not_verified" });
  await h.connect();
  h.core.bind("people", { databaseId: ids.peopleDatabase, dataSourceId: ids.otherSource, name: "Other" });
  assert.deepEqual((await h.slice()).outcome, { skipped: "not_verified" });
  h.core.state.connection!.readable = false;
  assert.deepEqual((await h.slice()).outcome, { skipped: "notion_unreadable" });
  assert.equal(notion.calls.filter((call) => !call.path.startsWith("/data_sources/a") || call.method !== "GET").length, 0);
}));

test("a sync creates rows for members without one, fixes names, unticks departed members, never writes Notion account, within slice budgets", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  const kept = peopleRow({ name: "Old Name", memberId: "9001", active: true, accounts: [{ id: personA, name: "Test Student A" }] });
  const departed = peopleRow({ name: "Test Student Z", memberId: "9099", active: true, accounts: [{ id: personB, name: "Test Student Z" }] });
  seed(notion, ids.peopleSource, [kept, departed]);
  notion.calls.length = 0;
  const slices = await h.runJob(true);
  assert.equal(slices.at(-1)!.outcome.done, true, JSON.stringify(slices.at(-1)!.outcome));
  slices.forEach((slice, index) => withinBudget(slice.cost, `slice ${index}`));
  assert.ok(slices.every((slice) => !slice.outcome.more || typeof slice.outcome.cursor === "string"), "each step answers { more, cursor }");

  const people = notion.rows.get(ids.peopleSource)!;
  assert.equal(people.length, 3, "one row created, none deleted");
  const created = people[2]!;
  assert.equal(created.properties.Name.title[0].plain_text, "Test Student B");
  assert.equal(created.properties["LancerLogin member ID"].rich_text[0].plain_text, "9002");
  assert.equal(created.properties.Active.checkbox, true);
  assert.equal(created.properties["Notion account"], undefined, "created without Notion account");
  assert.equal(kept.properties.Name.title[0].plain_text, "Test Student A");
  assert.equal(departed.properties.Active.checkbox, false);
  assert.equal(departed.in_trash, undefined);
  assert.equal(accountWritten(notion), false, "Notion account is never written");
  // Account columns came back untouched.
  assert.equal(kept.properties["Notion account"].people[0].id, personA);

  const matched = h.test.rows<any>("SELECT external_id AS externalId,match_state AS state,member_id AS memberId FROM chores_people ORDER BY external_id");
  assert.deepEqual(matched, [{ externalId: "9001", state: "matched", memberId: "m-a" }, { externalId: "9002", state: "unmatched", memberId: "m-b" }, { externalId: "9099", state: "unmatched", memberId: null }]);
  // Nothing names a person in the job's answers or Chores' event log.
  assert.doesNotMatch(JSON.stringify(slices.map((slice) => slice.outcome)) + JSON.stringify(h.test.rows("SELECT detail_json FROM chores_events")), /Test Student|9001|9002/);

  // A second run writes nothing new.
  h.test.run("UPDATE chores_sync SET next_due_ms=0");
  notion.calls.length = 0;
  await h.runJob(true);
  assert.equal(writes(notion).length, 0);
}));

test("the cron fallback does several steps in one run, stays under Core's Notion cap and the slice budget, and finishes the same", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  for (let index = 3; index <= 9; index++) h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES (?,'primary',?,'Test Student',?)", `m-${index}`, String(9000 + index), String.fromCharCode(64 + index));
  seed(notion, ids.peopleSource, Array.from({ length: 6 }, (_, index) => peopleRow({ name: `Wrong ${index}`, memberId: String(9001 + index), active: false })));
  const slices = await h.runJob(false);
  assert.equal(slices.at(-1)!.outcome.done, true);
  slices.forEach((slice, index) => withinBudget(slice.cost, `cron run ${index}`));
  assert.ok(slices.some((slice) => slice.cost.notion > maximumRequestsPerStep), "some runs did more than one step");
  assert.equal(notion.rows.get(ids.peopleSource)!.length, 9);
  assert.equal(accountWritten(notion), false);
}));

test("updates to rows read in an earlier slice pay Core's page check; every write stays inside the People binding", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  seed(notion, ids.peopleSource, [peopleRow({ name: "Old Name", memberId: "9001" })]);
  notion.calls.length = 0;
  await h.runJob(true);
  const patch = notion.calls.findIndex((call) => call.method === "PATCH");
  assert.ok(patch > 0);
  assert.equal(notion.calls[patch - 1]!.method, "GET", "Core read the page to check its database first");
  assert.equal(h.core.state.outOfScope.length, 0);
}));

test("dry-run reads People and counts what it would write, and writes nothing", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: true });
  seed(notion, ids.peopleSource, [peopleRow({ name: "Old Name", memberId: "9001" })]);
  notion.calls.length = 0;
  const slices = await h.runJob(true);
  assert.equal(slices.at(-1)!.outcome.dryRun, true);
  assert.equal(writes(notion).length, 0);
  const summary = JSON.parse(h.test.rows<any>("SELECT summary_json FROM chores_sync")[0].summary_json);
  assert.deepEqual(summary.planned, { created: 1, updated: 1, unticked: 0, suggested: 0 });
}));

test("with a task database, a unique name match writes only Suggested account, never Notion account", () => withHarness(async (h, notion) => {
  await h.connect(true);
  h.settings({ enabled: true, dryRun: false });
  const row = peopleRow({ name: "Test Student A", memberId: "9001" });
  seed(notion, ids.peopleSource, [row, peopleRow({ name: "Test Student B", memberId: "9002", accounts: [{ id: personB, name: "Test Student B" }] })]);
  seed(notion, ids.taskSource, [taskRow([{ id: personA, name: "Test Student A" }])]);
  const slices = await h.runJob(true);
  slices.forEach((slice, index) => withinBudget(slice.cost, `slice ${index}`));
  assert.deepEqual(row.properties["Suggested account"].people.map((person: any) => person.id), [personA]);
  assert.deepEqual(row.properties["Notion account"].people, []);
  assert.equal(accountWritten(notion), false);
}));

test("a rate limit keeps the sync's place and waits as long as Notion asked; a paused delivery waits without losing its place", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  notion.on(/^POST \/pages$/, () => notionResponse({ object: "error", status: 429 }, 429, { "retry-after": "30" }));
  const slices = await h.runJob(true);
  const last = slices.at(-1)!.outcome;
  assert.equal(last.failed, "notion_429");
  assert.equal(last.retryAfterMs, 30_000);
  const sync = h.test.rows<any>("SELECT phase,next_due_ms AS due FROM chores_sync")[0];
  assert.equal(sync.phase, "write");
  assert.ok(sync.due > Date.now() + 25_000);
  assert.deepEqual((await h.slice()).outcome, { skipped: "not due" });

  h.test.run("UPDATE chores_sync SET next_due_ms=0");
  h.core.state.pausedUntilMs = 0;
  h.core.state.deliveryPausedUntil = Date.now() + 60_000;
  const paused = await h.slice();
  assert.equal(paused.outcome.failed, "delivery_paused");
  assert.equal(h.test.rows<any>("SELECT phase FROM chores_sync")[0].phase, "write");
}));

test("an uncertain create is never sent again blindly: the next run reads People first and adopts the row", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  h.test.run("UPDATE members SET active=0 WHERE id='m-b'");
  let first = true;
  notion.on(/^POST \/pages$/, (call) => {
    if (!first) throw new Error("a second create was sent");
    first = false;
    // Notion made the row, then the answer was lost.
    const page = peopleRow({ name: "Test Student A", memberId: "9001" });
    seed(notion, ids.peopleSource, [page]);
    void call;
    return notionResponse({ object: "error", status: 502 }, 502);
  });
  const slices = await h.runJob(true);
  assert.equal(slices.at(-1)!.outcome.failed, "notion_502");
  assert.equal(h.test.rows<any>("SELECT phase FROM chores_sync")[0].phase, "idle");
  h.test.run("UPDATE chores_sync SET next_due_ms=0");
  const again = await h.runJob(true);
  assert.equal(again.at(-1)!.outcome.done, true);
  assert.equal(notion.rows.get(ids.peopleSource)!.length, 1);
}));

test("a 403 on reading People records lost access for the Admin, and the next good run clears it", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: true });
  notion.on(/^POST \/data_sources\/.*\/query$/, () => notionResponse({ object: "error", status: 403 }, 403));
  assert.equal((await h.slice()).outcome.failed, "notion_403");
  assert.equal((await h.setup("GET", "/status")).body.problem, "notion_access_lost");
  notion.on(/^POST \/data_sources\/.*\/query$/, () => notionResponse({ object: "list", results: [], has_more: false, next_cursor: null }));
  h.test.run("UPDATE chores_sync SET next_due_ms=0");
  await h.runJob(true);
  assert.equal((await h.setup("GET", "/status")).body.problem, null);
}));

test("Sync people now needs Chores on, is open to assigned Operators, and the People panel has counts only", () => withHarness(async (h) => {
  await h.connect();
  assert.equal((await h.admin("POST", "/people/sync", {}, "operator")).status, 409);
  h.settings({ enabled: true });
  const queued = await h.admin("POST", "/people/sync", {}, "operator");
  assert.equal(queued.status, 200);
  assert.equal(queued.body.activeMembers, 2);
  assert.doesNotMatch(queued.text, /Test Student|example\.test/);
  assert.equal((await h.admin("GET", "/settings", undefined, "operator")).status, 403);
}));

test("settings saves carry the revision the page read", () => withHarness(async (h) => {
  const first = await h.admin("GET", "/settings");
  assert.deepEqual(first.body, { enabled: false, dryRun: true, peopleSyncHour: 2, revision: 0 });
  assert.equal((await h.admin("PUT", "/settings", { revision: 0, enabled: true })).body.enabled, true);
  assert.equal((await h.admin("PUT", "/settings", { revision: 0, dryRun: false })).status, 409);
  assert.equal((await h.admin("PUT", "/settings", { revision: 1, peopleSyncHour: 24 })).status, 400);
}));

test("a create whose local record fails is not sent again: the next slice reads People and adopts the row", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  // The batch that records the created row fails once, as a D1 error or the scheduler's budget would.
  let failures = 1;
  h.state.fail = (sql) => sql.includes("INSERT INTO chores_people(installation_id,page_id,external_id,member_id") && failures-- > 0;
  await assert.rejects(h.runJob(true), /D1_ERROR/);
  assert.equal(notion.rows.get(ids.peopleSource)!.length, 1, "one row was created before the failure");
  h.state.fail = undefined;
  const slices = await h.runJob(true);
  assert.equal(slices.at(-1)!.outcome.done, true);
  const people = notion.rows.get(ids.peopleSource)!;
  assert.equal(people.length, 2, "one row per member, no duplicate");
  assert.deepEqual(people.map((row) => row.properties["LancerLogin member ID"].rich_text[0].plain_text).sort(), ["9001", "9002"]);
  assert.equal(h.test.rows<any>("SELECT count(*) AS n FROM chores_people WHERE match_state='ambiguous'")[0].n, 0);
}));

test("if even the fallback write fails (the run stopped), the pending-write marker sends the next slice back to reading", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  // Fail the record of the create, then the batch that would send the stream back to reading.
  let stage = 0;
  h.state.fail = (sql) => {
    if (stage === 0 && sql.includes("INSERT INTO chores_people(installation_id,page_id,external_id,member_id")) { stage = 1; return true; }
    if (stage === 1 && sql.startsWith("UPDATE chores_sync SET phase=?")) { stage = 2; return true; }
    return false;
  };
  await assert.rejects(h.runJob(true), /D1_ERROR/);
  h.state.fail = undefined;
  const marker = h.test.rows<any>("SELECT phase,pending_write AS pending FROM chores_sync")[0];
  assert.equal(marker.phase, "write");
  assert.ok(marker.pending, "the marker survived");
  h.test.run("UPDATE chores_sync SET lease_until_ms=0");
  notion.calls.length = 0;
  const next = await h.slice();
  assert.equal(next.outcome.cursor, "read");
  assert.equal(writes(notion).length, 0, "nothing was sent");
  await h.runJob(true);
  assert.equal(notion.rows.get(ids.peopleSource)!.length, 2);
}));

test("a member ID longer than 200 characters is skipped before any Notion call, with a recorded code", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  const long = "9".repeat(201);
  h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES ('m-long','primary',?,'Test Student','L')", long);
  const slices = await h.runJob(true);
  assert.equal(slices.at(-1)!.outcome.done, true);
  assert.ok(!notion.calls.some((call) => JSON.stringify(call.body ?? {}).includes(long.slice(0, 50))), "the long ID never reached Notion");
  assert.equal(notion.rows.get(ids.peopleSource)!.length, 2, "the other members still got rows");
  const summary = JSON.parse(h.test.rows<any>("SELECT summary_json FROM chores_sync")[0].summary_json);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.codes, ["member_id_too_long"]);
  assert.match(h.test.rows<any>("SELECT detail_json FROM chores_events WHERE kind='people_sync'")[0].detail_json, /member_id_too_long/);
}));

test("a full roster page (500) may be cut short, so nobody is unticked and the run records why", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: false });
  for (let index = 3; index <= 500; index++) h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES (?,'primary',?,'Test Student',?)", `m-${index}`, String(10_000 + index), `N${index}`);
  const rows = [
    peopleRow({ name: "Test Student A", memberId: "9001" }), peopleRow({ name: "Test Student B", memberId: "9002" }),
    ...Array.from({ length: 498 }, (_, offset) => peopleRow({ name: `Test Student N${offset + 3}`, memberId: String(10_003 + offset) })),
  ];
  const departed = peopleRow({ name: "Test Student Z", memberId: "9099", active: true });
  seed(notion, ids.peopleSource, [...rows, departed]);
  const slices = await h.runJob(true, 400);
  assert.equal(slices.at(-1)!.outcome.done, true);
  slices.forEach((slice, index) => withinBudget(slice.cost, `slice ${index}`));
  assert.equal(departed.properties.Active.checkbox, true, "not unticked");
  assert.equal(writes(notion).length, 0);
  assert.deepEqual(JSON.parse(h.test.rows<any>("SELECT summary_json FROM chores_sync")[0].summary_json).codes, ["roster_truncated"]);
}));

test("the lease outlasts the worst cron run, and a runner releases only its own lease", () => withHarness(async (h, notion) => {
  const { leaseMs, cronSlices } = await import("../src/people.ts");
  assert.ok(leaseMs > cronSlices * maximumRequestsPerStep * 20_000, "steps x requests x Core's 20 s Notion timeout");
  await h.connect();
  h.settings({ enabled: true, dryRun: true });
  // While this runner waits on Notion, another runner takes the lease over (as after an expiry).
  notion.on(/^POST \/data_sources\/.*\/query$/, () => {
    h.test.run("UPDATE chores_sync SET lease_token='other-runner',lease_until_ms=?", Date.now() + 120_000);
    return notionResponse({ object: "list", results: [], has_more: false, next_cursor: null });
  });
  await h.slice();
  const lease = h.test.rows<any>("SELECT lease_token AS token,lease_until_ms AS until,phase FROM chores_sync")[0];
  assert.equal(lease.token, "other-runner", "the other runner keeps its lease");
  assert.ok(lease.until > Date.now());
  assert.equal(lease.phase, "read", "and the first runner's stale step changed nothing");
}));

test("verifying a different People database keeps the sync row, moves to a new generation, and a slice still running for the old one changes nothing", () => withHarness(async (h, notion) => {
  await h.connect();
  h.settings({ enabled: true, dryRun: true });
  notion.pageSize = 1;
  seed(notion, ids.peopleSource, [peopleRow({ name: "Test Student A", memberId: "9001" }), peopleRow({ name: "Test Student B", memberId: "9002" })]);
  await h.slice();
  const before = h.test.rows<any>("SELECT generation FROM chores_sync")[0].generation;
  // A second People database, and the Admin verifies it while a slice is still reading the old one.
  notion.sources.set(ids.otherSource, { ...notion.sources.get(ids.peopleSource), id: ids.otherSource });
  notion.rows.set(ids.otherSource, []);
  let verifiedOnce = false;
  notion.on(new RegExp(`^POST /data_sources/${ids.peopleSource}/query$`), async () => {
    if (!verifiedOnce) {
      verifiedOnce = true;
      h.core.bind("people", { databaseId: ids.peopleDatabase, dataSourceId: ids.otherSource, name: "Other People" });
      const verified = await h.setup("POST", "/verify", {});
      assert.equal(verified.status, 200, verified.text);
    }
    return notionResponse({ object: "list", results: [peopleRow({ name: "Old Database", memberId: "9001" })], has_more: false, next_cursor: null });
  });
  await h.slice();
  const sync = h.test.rows<any>("SELECT phase,generation,lease_token AS token FROM chores_sync")[0];
  assert.equal(sync.phase, "idle", "the stale slice did not move the stream on");
  assert.ok(sync.generation > before, "the generation only grows");
  assert.equal(sync.token, null);
  // The next run reads the new, empty database, and nothing from the old one survives it.
  const slices = await h.runJob(true);
  assert.equal(slices.at(-1)!.outcome.done, true);
  assert.equal(h.test.rows<any>("SELECT count(*) AS n FROM chores_people")[0].n, 0, "the old database's rows are gone");
  assert.ok(h.test.rows<any>("SELECT generation FROM chores_sync")[0].generation > sync.generation);
}));
