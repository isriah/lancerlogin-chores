// Fast checks of the declarations Core validates when it composes the plugin, so mistakes show up before Verify runs.
import "./helpers/sdk-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import manifest from "../src/manifest.ts";

const { default: api } = await import("../src/api.ts");
const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const release = JSON.parse(read(".github/plugin-release.json"));
const sources = (dir: string): string[] => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(`${dir}${entry.name}/`) : /\.(ts|tsx)$/.test(entry.name) ? [`${dir}${entry.name}`] : []);

test("package.json, the manifest and plugin-release.json agree", () => {
  assert.equal(manifest.id, "chores");
  assert.equal(manifest.id, pkg.lancerlogin.moduleId);
  assert.equal(manifest.contractVersion, pkg.lancerlogin.contract);
  assert.equal(manifest.tablePrefix, pkg.lancerlogin.tablePrefix);
  assert.equal(pkg.name, `lancerlogin-module-${manifest.id}`);
  // Core's people matching (SDK 1.10.0) ships in the beta after 2.1.0-beta.13. Until that beta is published this range lets
  // the plugin compose on the development Core that already has it; raise it to that beta before Chores is released.
  assert.equal(pkg.lancerlogin.core, ">=2.1.0-beta.13 <3.0.0");
  assert.equal(pkg.peerDependencies["@lancerlogin/module-sdk"], "^1.10.0", "services.notion, NotionBindingField and listNotionPeopleAccounts");
  assert.equal(release.repository, "isriah/lancerlogin-chores");
  assert.match(release.core.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.setup.version, 1, "Core cannot update an installed module's setup version, so raising it locks setup");
});

test("Notion: the two bindings with only the operations Chores calls, user lookup, no email and no People database", () => {
  assert.deepEqual(manifest.notion.users, ["retrieve"]);
  assert.deepEqual(manifest.notion.bindings.map((binding) => [binding.id, binding.required, binding.kind, [...binding.operations]]), [
    ["chores", true, "data_source", ["retrieve", "query"]],
    ["log", true, "data_source", ["retrieve", "query", "pages.create", "pages.retrieve", "pages.update", "pages.trash"]],
  ]);
  for (const binding of manifest.notion.bindings) {
    assert.ok(binding.label.length <= 80 && binding.label.trim() === binding.label);
    assert.ok(binding.reason.length <= 200 && binding.reason.trim() === binding.reason);
    assert.match(binding.id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  }
  // No Notion request leaves the plugin except through Core: no Notion host, headers or token handling anywhere, and no fetch
  // in the Worker. (The dashboard fetches only the plugin's own routes.)
  for (const name of sources("src/")) {
    const source = read(name);
    assert.doesNotMatch(source, /api\.notion\.com|Notion-Version|Bearer|services\.credentials|ntn_/, name);
    if (!name.startsWith("src/dashboard")) assert.doesNotMatch(source, /\bfetch\(/, name);
  }
});

test("the setup steps, routes and pages are declared and each has exactly one handler; no job until the picking engine", () => {
  assert.deepEqual(manifest.jobs, []);
  assert.deepEqual(Object.keys(api.jobs!), []);
  assert.deepEqual(manifest.setup.steps.map((step) => step.id), ["notion-connection", "person-write-check"]);
  assert.deepEqual(Object.keys(api.setup!.predicates).sort(), ["notion-connection", "person-write-check"]);
  assert.deepEqual(manifest.apiRoutes.map((route) => route.path), Object.keys(api.routes!));
  assert.deepEqual(manifest.settings, [{ label: "Chores", path: "/settings/chores" }]);
  assert.deepEqual(manifest.navigation, []);
  assert.deepEqual(manifest.capabilities, [{ id: "chores.manage", label: "Manage Chores (sees who is checked in today)", operator: true }]);
});

test("every table is prefixed, declared, classified for backup and cleaned up in the declared order", () => {
  const sql = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).map((name) => read(`migrations/${name}`)).join("\n");
  const dropped = new Set([...sql.matchAll(/DROP TABLE (\w+)/g)].map((match) => match[1]!));
  const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]!).filter((table) => !dropped.has(table));
  assert.deepEqual([...dropped], ["chores_people"], "People matching moved to Core");
  assert.deepEqual([...created].sort(), [...manifest.persistence.tables].sort());
  for (const table of created) {
    assert.ok(table.startsWith(manifest.tablePrefix), table);
    const portable = (manifest.backup.tables as readonly string[]).includes(table);
    const nonPortable = (manifest.backup.nonPortableTables as readonly string[]).includes(table);
    assert.ok(portable !== nonPortable, `${table} is either backed up or non-portable`);
    assert.ok((manifest.lifecycle.cleanupTargets as readonly string[]).includes(table), `${table} is cleaned up`);
  }
  assert.deepEqual(Object.keys(api.backup!.tables), [...manifest.backup.tables]);
  const steps = api.cleanup.steps.map((step: any) => step.kind === "assignments" ? "platform_module_assignments:chores" : step.table === "platform_module_setup_progress" ? "platform_module_setup_progress:chores" : step.table);
  assert.deepEqual(steps, [...manifest.lifecycle.cleanupTargets]);
});

test("no token or secret column: the Notion token lives in Core", () => {
  const sql = read("migrations/0001_create_chores_tables.sql");
  assert.doesNotMatch(sql, /^\s*(ciphertext|iv|token|secret)\b/im);
});

test("migrations are numbered from 0001 and match their reviewed hashes", () => {
  const files = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
  const reviewed = JSON.parse(read("migrations/reviewed.json")) as { name: string; sha256: string }[];
  assert.deepEqual(reviewed.map((entry) => entry.name), files);
  files.forEach((name, index) => {
    assert.match(name, new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`));
    const hash = createHash("sha256").update(read(`migrations/${name}`).replaceAll("\r\n", "\n")).digest("hex");
    assert.equal(reviewed[index]!.sha256, hash, `${name} changed after review; released migrations are never edited`);
  });
});
