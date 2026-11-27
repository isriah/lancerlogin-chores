// Layout checks, the write allow-lists and the Core client wrapper. Synthetic data only.
import "./helpers/sdk-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { AppError, ChoresNotion, assertWritable, logWritable, mapChores, mapLog, mapPeople, mapTask, notionFailure, peopleProperties, peopleWritable, type Schema } from "../src/notion.ts";
import { CoreHttpError, CoreNotionError, createCoreNotion, type Cost } from "./helpers/core-notion-stub.ts";
import { choresSource, ids, logSource, peopleSource, stubNotion, taskSource } from "./helpers/notion-stub.ts";

const schema = (): Schema => ({
  chores: mapChores(choresSource(), ids.choresDatabase),
  log: mapLog(logSource(), ids.logDatabase, ids.choresSource),
  people: mapPeople(peopleSource(), ids.peopleDatabase),
  task: mapTask(taskSource(), ids.taskDatabase),
});

test("schema checks require only the listed properties: an extra Board column formula and other extras are allowed", () => {
  const log = logSource();
  assert.ok(log.properties["Board column"], "the fixture has the extra formula");
  const mapped = mapLog(log, ids.logDatabase, ids.choresSource);
  assert.deepEqual(Object.keys(mapped.properties).sort(), ["assignedBy", "chore", "date", "done", "name", "person", "status"]);
  // Any number of extra properties, of any type, anywhere.
  const people = peopleSource();
  people.properties["Grade"] = { id: "grde", type: "select", select: { options: [] } };
  people.properties["Board column"] = { id: "brdc", type: "formula", formula: {} };
  assert.equal(mapPeople(people, ids.peopleDatabase).properties.account.id, "acct");
  const chores = choresSource();
  chores.properties["Photo"] = { id: "phot", type: "files", files: {} };
  assert.equal(mapChores(chores, ids.choresDatabase).properties.days.type, "multi_select");
});

test("schema checks refuse a missing or retyped property, a missing Status option and a Chore relation to another database", () => {
  const people = peopleSource();
  delete people.properties["Notion account"];
  assert.throws(() => mapPeople(people, ids.peopleDatabase), (error: AppError) => error.code === "schema" && /Notion account/.test(error.message));
  const chores = choresSource();
  chores.properties["People needed"] = { id: "pndd", type: "rich_text", rich_text: {} };
  assert.throws(() => mapChores(chores, ids.choresDatabase), (error: AppError) => error.code === "schema" && /People needed/.test(error.message));
  const log = logSource();
  log.properties.Status.select.options.pop();
  assert.throws(() => mapLog(log, ids.logDatabase, ids.choresSource), (error: AppError) => error.code === "schema" && /Reassigned \(not checked in\)/.test(error.message));
  const related = logSource();
  related.properties.Chore.relation.data_source_id = ids.otherSource;
  assert.throws(() => mapLog(related, ids.logDatabase, ids.choresSource), (error: AppError) => error.code === "schema" && /relate/.test(error.message));
  assert.throws(() => mapTask({ id: ids.taskSource, properties: { Task: { id: "title", type: "title" } } }, ids.taskDatabase), (error: AppError) => error.code === "schema");
});

test("People writes are limited to Name, LancerLogin member ID, Active and Suggested account; Notion account never", () => {
  const s = schema();
  assert.deepEqual([...peopleWritable].sort(), ["active", "memberId", "name", "suggested"]);
  assert.ok(!(peopleWritable as readonly string[]).includes("account"));
  // Every value the plugin can build for People leaves Notion account out.
  const all = peopleProperties(s, { name: "Test Student A", memberId: "9001", active: true, suggested: ["c0000000-0000-4000-8000-00000000000a"] });
  assert.deepEqual(Object.keys(all).sort(), ["actv", "mbid", "sugg", "title"]);
  assertWritable(s, "people", all);
  // The account column is refused, alone, mixed in, or under its encoded ID.
  for (const properties of [{ acct: { people: [] } }, { title: { title: [] }, acct: { people: [] } }, { [encodeURIComponent("acct")]: { people: [] } }]) {
    assert.throws(() => assertWritable(s, "people", properties), (error: AppError) => error.code === "write_not_allowed");
  }
  // So is anything outside the list, and an empty write.
  assert.throws(() => assertWritable(s, "people", { need: { formula: {} } }), (error: AppError) => error.code === "write_not_allowed");
  assert.throws(() => assertWritable(s, "people", {}), (error: AppError) => error.code === "write_not_allowed");
});

test("Chore log writes are limited to the listed properties: Done is read only, and the Board column formula is never written", () => {
  const s = schema();
  assert.ok(!(logWritable as readonly string[]).includes("done"));
  assertWritable(s, "log", { title: {}, date: {}, chor: {}, "pe%3Ars": {}, stat: {}, asby: {} });
  assertWritable(s, "log", { "pe:rs": {} });
  assert.throws(() => assertWritable(s, "log", { done: { checkbox: true } }), (error: AppError) => error.code === "write_not_allowed");
  assert.throws(() => assertWritable(s, "log", { brdc: { formula: {} } }), (error: AppError) => error.code === "write_not_allowed");
});

test("a write outside the allow-list is refused before anything reaches Core or Notion", async () => {
  const notion = stubNotion();
  try {
    const core = createCoreNotion();
    core.connect();
    core.bind("people", { databaseId: ids.peopleDatabase, dataSourceId: ids.peopleSource, name: "Test People" });
    const cost: Cost = { d1: 0, external: 0, notion: 0 };
    const client = new ChoresNotion(core.service(cost) as any);
    const s = schema();
    await assert.rejects(client.createLogRow(s, { done: { checkbox: true } }), (error: AppError) => error.code === "write_not_allowed");
    assert.equal(notion.calls.length, 0);
    assert.equal(cost.notion, 0);
  } finally { notion.restore(); }
});

test("Core's failures become plugin codes with fixed messages; a paused delivery is its own code", () => {
  const service = createCoreNotion().service({ d1: 0, external: 0, notion: 0 }) as any;
  const rateLimited = notionFailure(service, new CoreNotionError("Notion said something private", "notion_429", { providerStatus: 429, retryAfterMs: 2500 }))!;
  assert.equal(rateLimited.code, "notion_429");
  assert.deepEqual(rateLimited.details, { retryAfterMs: 2500 });
  assert.doesNotMatch(rateLimited.message, /private/);
  assert.equal(notionFailure(service, new CoreNotionError("x", "notion_paused", { providerStatus: 429, retryAfterMs: 10 }))!.code, "notion_429");
  assert.equal(notionFailure(service, new CoreNotionError("x", "notion_unbound", { status: 409 }))!.code, "notion_unbound");
  const uncertain = notionFailure(service, new CoreNotionError("x", "notion_network", { uncertain: true }))!;
  assert.equal(uncertain.code, "notion_network");
  assert.equal(uncertain.uncertain, true);
  assert.equal(notionFailure(service, new CoreHttpError(409, "Outbound delivery is paused"))?.code, "delivery_paused");
  assert.equal(notionFailure(service, new Error("unrelated")), undefined);
});
