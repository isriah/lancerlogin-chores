// The setup routes through Core's Notion connection: status, verifying the bound databases and the Person-write check.
import "./helpers/sdk-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/harness.ts";
import { botUser, guestPerson, ids, notionResponse, personA, stubNotion } from "./helpers/notion-stub.ts";
// After the hook, so the plugin's SDK import resolves to the stand-in.
const { default: api } = await import("../src/api.ts");

async function withHarness(run: (h: ReturnType<typeof createHarness>, notion: ReturnType<typeof stubNotion>) => Promise<void>) {
  const notion = stubNotion();
  try { await run(createHarness(api), notion); } finally { notion.restore(); }
}

const stepDone = async (h: ReturnType<typeof createHarness>, step: string) => (api as any).setup.stepValid(h.db, step);

test("status before Core's connection exists points at Settings > Integrations > Notion and makes no Notion request", () => withHarness(async (h, notion) => {
  const status = await h.setup("GET", "/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.problem, "notion_not_configured");
  assert.equal(status.body.core.connected, false);
  assert.deepEqual(status.body.bindings, { chores: null, log: null, people: null, task: null });
  assert.equal(notion.calls.length, 0);
  assert.doesNotMatch(status.text, /ntn_|token/i);
}));

test("setup routes are Admin only, and changes must come from the dashboard", () => withHarness(async (h) => {
  assert.equal((await h.call("GET", "/module-setup/chores/status", { role: "operator" })).status, 403);
  assert.equal((await h.call("POST", "/module-setup/chores/verify", { body: {} })).status, 403);
  assert.equal((await h.call("GET", "/module-setup/chores/unknown")).status, 404);
}));

test("verify refuses until every required binding is chosen, naming the first missing one, before any Notion request", () => withHarness(async (h, notion) => {
  h.core.connect();
  h.core.bind("chores", { databaseId: ids.choresDatabase, dataSourceId: ids.choresSource, name: "Test Chores" });
  const status = await h.setup("GET", "/status");
  assert.equal(status.body.problem, "log_unbound");
  const verify = await h.setup("POST", "/verify", {});
  assert.equal(verify.status, 409);
  assert.equal(verify.body.code, "notion_unbound");
  assert.equal(verify.body.field, "log");
  assert.equal(notion.calls.filter((call) => call.path.startsWith("/data_sources/") && !call.path.includes(ids.choresSource)).length, 0);
  assert.equal(await stepDone(h, "notion-connection"), false);
}));

test("verify reads every bound database through Core (at most four requests), allows extra properties and completes step 1", () => withHarness(async (h, notion) => {
  h.bindAll(true);
  const verify = await h.setup("POST", "/verify", {});
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.body.problem, null);
  assert.ok(verify.body.verifiedMs);
  assert.equal(verify.body.taskVerified, true);
  assert.deepEqual(notion.calls.map((call) => `${call.method} ${call.path}`), [ids.choresSource, ids.logSource, ids.peopleSource, ids.taskSource].map((id) => `GET /data_sources/${id}`));
  assert.equal(await stepDone(h, "notion-connection"), true);
  assert.equal(await stepDone(h, "person-write-check"), false);
  assert.equal(h.test.rows("SELECT action FROM audit_log").map((row: any) => row.action).join(), "chores.connection_verified");
}));

test("a layout mismatch saves nothing and names the binding; a binding moved in Core needs verifying again", () => withHarness(async (h, notion) => {
  h.bindAll();
  const people = notion.sources.get(ids.peopleSource);
  people.properties["LancerLogin member ID"].type = "number";
  const refused = await h.setup("POST", "/verify", {});
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "schema_mismatch");
  assert.equal(refused.body.field, "people");
  assert.equal(await stepDone(h, "notion-connection"), false);

  people.properties["LancerLogin member ID"].type = "rich_text";
  assert.equal((await h.setup("POST", "/verify", {})).status, 200);
  // An Admin picks another Chores database in Core: the saved layouts no longer describe what is bound.
  h.core.bind("chores", { databaseId: ids.choresDatabase, dataSourceId: ids.otherSource, name: "Other" });
  assert.equal((await h.setup("GET", "/status")).body.problem, "not_verified");
  // Choosing a task database later also needs a new check.
  h.core.bind("chores", { databaseId: ids.choresDatabase, dataSourceId: ids.choresSource, name: "Test Chores" });
  h.core.bind("task", { databaseId: ids.taskDatabase, dataSourceId: ids.taskSource, name: "Test Tasks" });
  assert.equal((await h.setup("GET", "/status")).body.problem, "not_verified");
}));

test("the Person-write check creates one TEST row with Person set, reads it back, trashes only it, through Core, in four requests", () => withHarness(async (h, notion) => {
  await h.connect();
  notion.calls.length = 0;
  const check = await h.setup("POST", "/person-write-check", { notionUserId: personA });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.body.writeCheck.state, "passed");
  assert.equal(check.body.writeCheck.cleanup, "trashed");
  const lines = notion.calls.map((call) => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/g, "<id>")}`);
  assert.deepEqual(lines, ["GET /users/<id>", "POST /pages", "GET /pages/<id>", "PATCH /pages/<id>"]);
  const create = notion.calls[1]!.body;
  assert.equal(create.parent.data_source_id, ids.logSource);
  assert.deepEqual(Object.keys(create.properties).sort(), ["date", "pe%3Ars", "title"], "Name, Date and Person only: no Status, no Done");
  assert.match(create.properties.title.title[0].text.content, /^TEST – Person write check – \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(notion.calls[3]!.body, { in_trash: true });
  assert.equal(notion.calls[3]!.path, `/pages/${notion.calls[2]!.path.split("/")[2]}`);
  // Only the created page was trashed.
  assert.equal([...notion.pages.values()].filter((page) => page.in_trash).length, 1);
  assert.equal(await stepDone(h, "person-write-check"), true);
  assert.equal(h.core.state.outOfScope.length, 0);
}));

test("a guest's account that Notion won't look up still passes when the row reads back right; a bot account is refused first", () => withHarness(async (h, notion) => {
  await h.connect();
  const guest = await h.setup("POST", "/person-write-check", { notionUserId: guestPerson });
  assert.equal(guest.body.writeCheck.state, "passed");
  notion.calls.length = 0;
  const bot = await h.setup("POST", "/person-write-check", { notionUserId: botUser });
  assert.equal(bot.status, 400);
  assert.deepEqual(notion.calls.map((call) => call.method), ["GET"], "nothing was created");
}));

test("an uncertain create is recorded and never retried; a failed read still trashes the row; a paused delivery records nothing", () => withHarness(async (h, notion) => {
  await h.connect();
  notion.on(/^POST \/pages$/, () => notionResponse({ object: "error", status: 502 }, 502));
  const uncertain = await h.setup("POST", "/person-write-check", { notionUserId: personA });
  assert.equal(uncertain.body.writeCheck.state, "uncertain");
  assert.equal(uncertain.body.writeCheck.cleanup, "none");
  assert.equal(notion.calls.filter((call) => call.method === "POST" && call.path === "/pages").length, 1);
  assert.equal(await stepDone(h, "person-write-check"), false);

  // Notion creates the row but drops Person.
  notion.on(/^POST \/pages$/, () => {
    const page = { object: "page", id: crypto.randomUUID(), url: "https://app.notion.com/p/x", parent: { type: "data_source_id", data_source_id: ids.logSource }, properties: {} };
    notion.pages.set(page.id, page);
    return notionResponse(page);
  });
  const unsaved = await h.setup("POST", "/person-write-check", { notionUserId: personA });
  assert.equal(unsaved.body.writeCheck.state, "failed");
  assert.equal(unsaved.body.writeCheck.code, "person_not_saved");
  assert.equal(unsaved.body.writeCheck.cleanup, "trashed");

  h.core.state.deliveryPausedUntil = Date.now() + 60_000;
  const before = h.test.rows("SELECT write_check_state AS state FROM chores_notion")[0];
  const paused = await h.setup("POST", "/person-write-check", { notionUserId: personA });
  assert.equal(paused.status, 409);
  assert.equal(paused.body.code, "delivery_paused");
  assert.deepEqual(h.test.rows("SELECT write_check_state AS state FROM chores_notion")[0], before);
}));

test("the write check refuses before verifying, and counts only for the Chore log it ran against", () => withHarness(async (h, notion) => {
  h.bindAll();
  assert.equal((await h.setup("POST", "/person-write-check", { notionUserId: personA })).status, 409);
  assert.equal(notion.calls.length, 0);
  assert.equal((await h.setup("POST", "/person-write-check", { notionUserId: "not-an-id" })).status, 400);
  await h.connect();
  await h.setup("POST", "/person-write-check", { notionUserId: personA });
  assert.equal(await stepDone(h, "person-write-check"), true);
  // Verifying again against the same Chore log keeps it.
  await h.setup("POST", "/verify", {});
  assert.equal(await stepDone(h, "person-write-check"), true);
  // A different Chore log clears it.
  const other = { ...notion.sources.get(ids.logSource), id: ids.otherSource };
  notion.sources.set(ids.otherSource, other);
  h.core.bind("log", { databaseId: ids.logDatabase, dataSourceId: ids.otherSource, name: "Other log" });
  assert.equal((await h.setup("POST", "/verify", {})).status, 200);
  assert.equal(await stepDone(h, "person-write-check"), false);
}));

test("the People accounts list for the write check is one request and leaves out email addresses", () => withHarness(async (h, notion) => {
  await h.connect();
  const { peopleRow, seed } = await import("./helpers/notion-stub.ts");
  seed(notion, ids.peopleSource, [
    peopleRow({ name: "Test Student A", memberId: "9001", accounts: [{ id: personA, name: "Test Student A" }] }),
    peopleRow({ name: "Test Student B", memberId: "9002" }),
  ]);
  notion.calls.length = 0;
  const accounts = await h.setup("POST", "/people-accounts", {});
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.body.accounts, [{ name: "Test Student A", notionUserId: personA, memberId: "9001" }]);
  assert.equal(notion.calls.length, 1);
  assert.doesNotMatch(accounts.text, /example\.test/);
}));

test("the People view link must be a Notion https link", () => withHarness(async (h) => {
  await h.connect();
  assert.equal((await h.setup("PUT", "/view", { url: "https://evil.example.test/x" })).status, 400);
  const saved = await h.setup("PUT", "/view", { url: "https://www.notion.so/test-view?v=1" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.needsAccountViewUrl, "https://www.notion.so/test-view?v=1");
  assert.equal((await h.setup("PUT", "/view", { url: null })).body.needsAccountViewUrl, null);
}));
