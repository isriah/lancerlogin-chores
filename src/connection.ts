// Chores' side of Core's Notion connection, and the Admin setup routes for it.
//
// Core holds the Notion token (Settings > Integrations > Notion) and the database an Admin chose for each of Chores'
// bindings; every Notion request goes through `services.notion`. Chores keeps only what is its own: the checked layout of
// the bound databases, when it was checked, what Notion last refused, the People view link and the Person-write check.
//
// These routes live under /module-setup, not /admin: Core refuses /admin/<module> until setup is complete, and they are how
// setup completes. Core keeps /module-setup open to Admins afterwards.
import type { NotionBinding, NotionService, NotionServiceStatus } from "@lancerlogin/module-sdk/api";
import { audit, installationId, json, object, refuse, type Database, type Statement } from "./http.ts";
import { AppError, ChoresNotion, bindingIds, canonicalId, requiredBindings, validNotionUrl, type BindingId, type Schema } from "./notion.ts";
import { readPeopleAccounts } from "./people.ts";
import { personWriteCheck } from "./write-check.ts";

/** What Core gives a route or job. */
export type NotionServices = { readonly notion: NotionService };

export type ConnectionRow = {
  readonly schemaJson: string | null; readonly verifiedMs: number | null; readonly schemaError: string | null;
  readonly rejectionCode: string | null; readonly rejectedMs: number | null; readonly viewUrl: string | null;
  readonly writeCheckMs: number | null; readonly writeCheckState: string | null; readonly writeCheckCode: string | null;
  readonly writeCheckCleanup: string | null; readonly writeCheckPageUrl: string | null; readonly writeCheckLogSource: string | null;
};

export const readConnection = (db: Database) => db.prepare(`SELECT schema_json AS schemaJson,verified_ms AS verifiedMs,schema_error AS schemaError,
  rejection_code AS rejectionCode,rejected_ms AS rejectedMs,needs_account_view_url AS viewUrl,write_check_ms AS writeCheckMs,write_check_state AS writeCheckState,
  write_check_code AS writeCheckCode,write_check_cleanup AS writeCheckCleanup,write_check_page_url AS writeCheckPageUrl,write_check_log_source AS writeCheckLogSource
  FROM chores_notion WHERE installation_id=?`).bind(installationId).first<ConnectionRow>();

export const parseSchema = (row: ConnectionRow | null): Schema | undefined => {
  if (!row?.schemaJson) return undefined;
  try { return JSON.parse(row.schemaJson) as Schema; } catch { return undefined; }
};

// ---- Core's connection and bindings

export type CoreState = { readonly status: NotionServiceStatus; readonly bindings: Readonly<Record<BindingId, NotionBinding | undefined>> };

/** Core's connection and every binding: one D1 read by Core, shared by every later Notion call in this request or run. */
export async function readCore(notion: NotionService): Promise<CoreState> {
  const [status, ...found] = await Promise.all([notion.status(), ...bindingIds.map((id) => notion.binding(id))]);
  return { status, bindings: Object.fromEntries(bindingIds.map((id, index) => [id, found[index]])) as Record<BindingId, NotionBinding | undefined> };
}

const sameId = (a: unknown, b: unknown) => canonicalId(a) !== undefined && canonicalId(a) === canonicalId(b);

/** The saved layouts describe the databases Core has bound now, the optional task database included or left out alike. */
export function verifiedForBindings(row: ConnectionRow | null, core: CoreState): boolean {
  const schema = parseSchema(row);
  if (!schema || !row?.verifiedMs) return false;
  const checked: Record<BindingId, string | undefined> = { chores: schema.chores?.dataSourceId, log: schema.log?.dataSourceId, people: schema.people?.dataSourceId, task: schema.task?.dataSourceId };
  return bindingIds.every((id) => core.bindings[id] ? sameId(checked[id], core.bindings[id]!.dataSourceId) : checked[id] === undefined);
}

/**
 * Why Chores cannot use Notion, if anything, in the order an Admin fixes it: Core's connection, then each binding, then this
 * plugin's check of the layouts. A recorded refusal is reported separately (refusalProblem), since it does not stop setup.
 */
export function connectionProblem(row: ConnectionRow | null, core: CoreState): string | undefined {
  const { status } = core;
  if (!status.saved) return "notion_not_configured";
  if (!status.readable) return "notion_unreadable";
  if (!status.enabled) return "notion_disabled";
  const unbound = requiredBindings.find((id) => !core.bindings[id]);
  if (unbound) return `${unbound}_unbound`;
  if (!verifiedForBindings(row, core)) return "not_verified";
  if (row!.schemaError) return "notion_schema_changed";
  return undefined;
}

export const refusalProblem = (row: ConnectionRow | null) => !row?.rejectionCode ? undefined : row.rejectionCode === "notion_401" ? "notion_token_rejected" : "notion_access_lost";

/**
 * Remember that Notion refused a call: 401, 403 or 404. Other failures, such as a 500 or a 429, and Core's own refusals say
 * nothing about access. `verified_ms` in the WHERE means a slow call made before an Admin verified again cannot mark the new
 * layout. A failure to write this never changes the caller's answer.
 */
export async function recordRefusal(db: Database, row: ConnectionRow | null, code: string, now: number): Promise<void> {
  if (code !== "notion_401" && code !== "notion_403" && code !== "notion_404" || !row?.verifiedMs || row.rejectionCode === code) return;
  await db.prepare("UPDATE chores_notion SET rejection_code=?,rejected_ms=? WHERE installation_id=? AND verified_ms=?").bind(code, now, installationId, row.verifiedMs).run().catch(() => undefined);
}

/** A Notion call worked, so whatever refused it before has passed. No write unless a refusal is recorded. */
export async function clearRefusal(db: Database, row: ConnectionRow | null): Promise<void> {
  if (!row?.rejectionCode) return;
  await db.prepare("UPDATE chores_notion SET rejection_code=NULL,rejected_ms=NULL WHERE installation_id=?").bind(installationId).run().catch(() => undefined);
}

/**
 * The setup steps. A layout is only ever saved from reads through Core's bindings, by POST /verify, and the write check
 * only after one. Whether Core's connection and bindings still match is checked on every request and run instead
 * (connectionProblem), since Core's tables are not this plugin's.
 */
const verifiedSql = "schema_json IS NOT NULL AND verified_ms IS NOT NULL";
export const connectionStepSql = `EXISTS(SELECT 1 FROM chores_notion WHERE installation_id=? AND ${verifiedSql})`;
export const writeCheckStepSql = `EXISTS(SELECT 1 FROM chores_notion WHERE installation_id=? AND ${verifiedSql} AND write_check_state='passed' AND write_check_ms IS NOT NULL)`;

export type AdminRouteContext = {
  readonly request: Request; readonly url: URL; readonly db: unknown; readonly dashboardOrigin: string | undefined;
  readonly services: NotionServices;
  requireRole(roles: readonly ("admin" | "operator")[]): Promise<{ readonly userId: string }>;
  requireDashboardOrigin(message: string): void;
  json<T = unknown>(maxBytes?: number): Promise<T>;
};

/** Setup and settings are Admin only. Changes must also come from the dashboard. */
export async function requireAdmin(context: AdminRouteContext) {
  const principal = await context.requireRole(["admin"]);
  if (context.request.method !== "GET") context.requireDashboardOrigin("Use the dashboard to change Chores.");
  return principal;
}

const coreCodes = ["notion_not_configured", "notion_disabled", "notion_unreadable", "notion_unbound", "delivery_paused"];

/** How a Notion failure reads to an Admin. Only fixed messages: nothing from Notion's reply. */
export function notionFailureResponse(error: unknown, extra: Record<string, unknown> = {}) {
  if (!(error instanceof AppError)) throw error;
  if (error.code === "validation") return refuse(400, "validation", error.message, extra);
  if (error.code === "schema") return refuse(422, "schema_mismatch", error.message, extra);
  if (error.code === "notion_401") return refuse(422, "notion_token_rejected", error.message, extra);
  if (error.code === "notion_403" || error.code === "notion_404") return refuse(422, error.code, error.message, extra);
  if (error.code === "notion_429" || error.code === "notion_call_limit") return refuse(503, "notion_rate_limited", error.message, extra);
  if (coreCodes.includes(error.code)) return refuse(409, error.code, error.message, extra);
  return refuse(502, "notion_unavailable", "Notion could not be reached or did not answer as expected. Try again.", extra);
}

const coreMessages: Readonly<Record<string, string>> = {
  notion_not_configured: "Core's Notion connection is not set up. Save the Notion integration token in Settings > Integrations > Notion first.",
  notion_unreadable: "The Notion token saved in Core can't be read. Save it again in Settings > Integrations > Notion first.",
  notion_disabled: "Core's Notion connection is turned off. Turn it on in Settings > Integrations > Notion first.",
};

/**
 * Save the checked layouts. A different Chore log needs the Person-write check again; a different People database empties
 * the copy of People and has the sync start from the top. Verifying clears a recorded refusal: it has just read everything.
 */
const connectionStatements = (db: Database, schema: Schema, previous: Schema | undefined, actor: string, now: number): Statement[] => {
  const peopleChanged = !sameId(previous?.people.dataSourceId, schema.people.dataSourceId);
  return [
    db.prepare(`INSERT INTO chores_notion(installation_id,schema_json,verified_ms,updated_ms) VALUES (?1,?2,?3,?3)
      ON CONFLICT(installation_id) DO UPDATE SET schema_json=excluded.schema_json,verified_ms=excluded.verified_ms,schema_error=NULL,rejection_code=NULL,rejected_ms=NULL,updated_ms=excluded.updated_ms`)
      .bind(installationId, JSON.stringify(schema), now),
    // The write check proves one Chore log; it no longer counts once the binding points at another.
    db.prepare(`UPDATE chores_notion SET write_check_ms=NULL,write_check_state=NULL,write_check_code=NULL,write_check_cleanup=NULL,write_check_page_url=NULL,write_check_log_source=NULL
      WHERE installation_id=? AND write_check_log_source IS NOT ?`).bind(installationId, canonicalId(schema.log.dataSourceId) ?? schema.log.dataSourceId),
    ...(peopleChanged ? [
      db.prepare("DELETE FROM chores_people WHERE installation_id=?").bind(installationId),
      db.prepare("DELETE FROM chores_sync WHERE installation_id=? AND stream='people'").bind(installationId),
    ] : []),
    audit(db, actor, "chores.connection_verified", now),
  ];
};

/**
 * POST /verify: {}. Reads the layout of every database Core has bound for Chores (at most four Notion requests), checks it
 * and saves it. A failed check saves nothing and names the binding to fix.
 */
async function verify(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(1024));
  if (Object.keys(input).length) return refuse(400, "validation", "Send an empty body. The token and the databases are chosen in Core's Notion settings.");
  const [row, core] = await Promise.all([readConnection(db), readCore(context.services.notion)]);
  const blocked = connectionProblem(row, core);
  if (blocked && coreMessages[blocked]) return refuse(409, blocked, coreMessages[blocked]!);
  try {
    const schema = await new ChoresNotion(context.services.notion).readSchema();
    await db.batch(connectionStatements(db, schema, parseSchema(row), actor, now));
  } catch (error) {
    const field = (error as { field?: string }).field;
    return notionFailureResponse(error, field ? { field } : {});
  }
  return status(context, db);
}

/** PUT /view: { url }. The People database's "Needs a Notion account" view, or null to clear it. */
async function saveView(context: AdminRouteContext, db: Database, now: number) {
  const input = object(await context.json(4096));
  if (Object.keys(input).length !== 1 || !("url" in input)) return refuse(400, "validation", "Send the view link only.");
  const url = input.url === null || input.url === "" ? null : validNotionUrl(input.url);
  if (url === undefined) return refuse(400, "invalid_link", "Use the view's Notion link: https and a notion.so, notion.com or notion.site address.");
  const result = await db.prepare("UPDATE chores_notion SET needs_account_view_url=?,updated_ms=? WHERE installation_id=?").bind(url, now, installationId).run();
  if (result.meta?.changes !== 1) return refuse(409, "not_verified", "Verify the Notion databases first.");
  return status(context, db);
}

/**
 * POST /people-accounts: People rows with exactly one Notion account, from the first page of rows that have one, to choose
 * the Person-write check's account. One Notion request. Names go to the Admin's page only.
 */
async function peopleAccounts(context: AdminRouteContext, db: Database) {
  const [row, core] = await Promise.all([readConnection(db), readCore(context.services.notion)]);
  const problem = connectionProblem(row, core);
  if (problem) return refuse(409, problem, "Verify the Notion databases first.");
  try { return json({ accounts: await readPeopleAccounts(new ChoresNotion(context.services.notion), parseSchema(row)!) }); }
  catch (error) { return notionFailureResponse(error); }
}

/** What the setup page shows. Core's state in words it can act on, and Chores' own checks. No token, no email. */
export async function status(context: AdminRouteContext, db: Database) {
  const [row, core] = await Promise.all([readConnection(db), readCore(context.services.notion)]);
  const schema = parseSchema(row);
  const verified = verifiedForBindings(row, core);
  return json({
    core: {
      connected: core.status.connected, saved: core.status.saved, enabled: core.status.enabled, readable: core.status.readable,
      pausedUntilMs: core.status.pausedUntilMs, capabilities: core.status.capabilities,
    },
    bindings: Object.fromEntries(bindingIds.map((id) => [id, core.bindings[id] ? { name: core.bindings[id]!.name || null, databaseId: core.bindings[id]!.databaseId } : null])),
    verifiedMs: verified ? row!.verifiedMs : null, schemaError: row?.schemaError ?? null,
    problem: connectionProblem(row, core) ?? refusalProblem(row) ?? null, rejectedMs: row?.rejectedMs ?? null,
    taskVerified: verified && Boolean(schema?.task),
    needsAccountViewUrl: row?.viewUrl ?? null,
    writeCheck: { state: row?.writeCheckState ?? null, checkedMs: row?.writeCheckMs ?? null, code: row?.writeCheckCode ?? null, cleanup: row?.writeCheckCleanup ?? null, pageUrl: row?.writeCheckPageUrl ?? null },
  });
}

/** /module-setup/chores */
export async function setupRoute(context: AdminRouteContext): Promise<Response | undefined> {
  const path = context.url.pathname.slice("/module-setup/chores".length);
  const method = context.request.method;
  const known = path === "/status" && method === "GET" || path === "/verify" && method === "POST" || path === "/view" && method === "PUT"
    || path === "/people-accounts" && method === "POST" || path === "/person-write-check" && method === "POST";
  if (!known) return undefined;
  const { userId } = await requireAdmin(context);
  const db = context.db as Database; const now = Date.now();
  if (path === "/status") return status(context, db);
  if (path === "/verify") return verify(context, db, userId, now);
  if (path === "/view") return saveView(context, db, now);
  if (path === "/people-accounts") return peopleAccounts(context, db);
  const input = object(await context.json(1024));
  const notionUserId = Object.keys(input).length === 1 ? canonicalId(input.notionUserId) : undefined;
  if (!notionUserId) return refuse(400, "validation", "Choose the Notion account to test with.");
  const result = await personWriteCheck(db, context.services, notionUserId, userId, now);
  return result ?? status(context, db);
}
