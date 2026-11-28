// The words and rules of the Admin pages, without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { bindingGuide, connected, problemText, setupNotes, writeCheckPassed, writeCheckText, type SetupStatus } from "../src/dashboard/chores-model.ts";

const status = (overrides: Partial<SetupStatus> = {}): SetupStatus => ({
  core: { connected: true, saved: true, enabled: true, readable: true, pausedUntilMs: null },
  bindings: { chores: { name: "Test Chores", databaseId: "x" }, log: { name: "Test Chore log", databaseId: "y" } },
  verifiedMs: 1, schemaError: null, problem: null, rejectedMs: null,
  writeCheck: { state: null, checkedMs: null, code: null, cleanup: null, pageUrl: null }, ...overrides,
});

test("setup notes tell coaches to check people in from the dashboard, not with an attendance correction", () => {
  const notes = setupNotes.join(" ");
  assert.match(notes, /coach checks them in from the dashboard: that counts as present/);
  assert.match(notes, /attendance correction does not count/);
  assert.match(notes, /required meeting/);
  assert.match(notes, /assigned a chore, whether or not they ticked Done/);
});

test("every problem points at the fix, and the token always at Settings > Integrations > Notion", () => {
  for (const problem of ["notion_not_configured", "notion_unreadable", "notion_disabled", "notion_token_rejected"]) assert.match(problemText(status({ problem }))!, /Settings > Integrations > Notion/);
  assert.match(problemText(status({ problem: "log_unbound" }))!, /Chore log database/);
  assert.match(problemText(status({ problem: "notion_schema_changed", schemaError: "Chore log: the property \"Done\" must exist." }))!, /Done/);
  assert.equal(problemText(status()), undefined);
  assert.equal(connected(status({ problem: "not_verified" })), false);
  assert.equal(connected(status({ problem: "notion_access_lost" })), true, "a refusal is shown but setup stays complete");
});

test("the write check result reads plainly, including an uncertain create to clean up by hand", () => {
  assert.equal(writeCheckPassed(status({ writeCheck: { state: "passed", checkedMs: 1, code: null, cleanup: "trashed", pageUrl: null } })), true);
  assert.match(writeCheckText({ state: "uncertain", checkedMs: null, code: "notion_network", cleanup: "none", pageUrl: null })!, /TEST – Person write check/);
  assert.match(writeCheckText({ state: "failed", checkedMs: null, code: "person_not_saved", cleanup: "failed", pageUrl: "https://www.notion.so/x" })!, /delete it in Notion/);
});

test("the guide lists each binding once, in the manifest's order, and Chores has no People or task database of its own", async () => {
  const { default: manifest } = await import("../src/manifest.ts");
  assert.deepEqual(bindingGuide.map((binding) => binding.id), manifest.notion.bindings.map((binding) => binding.id));
  assert.deepEqual(bindingGuide.map((binding) => binding.id), ["chores", "log"]);
});
