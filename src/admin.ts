// /admin/chores: settings (Admin only) and the People panel (Admins and assigned Operators). Core refuses these routes
// until setup is complete. Settings saves carry the revision the page read, so a stale page cannot overwrite a newer save.
import { requireAdmin, type AdminRouteContext } from "./connection.ts";
import { audit, installationId, json, object, refuse, type Database } from "./http.ts";
import { peopleStatus, requestPeopleSync, reschedulePeopleSync } from "./people.ts";

export type Settings = { readonly enabled: boolean; readonly dryRun: boolean; readonly peopleSyncHour: number; readonly revision: number };

export const defaultSettingsSql = "INSERT OR IGNORE INTO chores_settings(installation_id,updated_ms) VALUES (?,?)";

export async function readSettings(db: Database, now: number): Promise<Settings> {
  await db.prepare(defaultSettingsSql).bind(installationId, now).run();
  const row = await db.prepare("SELECT enabled,dry_run AS dryRun,people_sync_hour AS hour,revision FROM chores_settings WHERE installation_id=?").bind(installationId).first<{ enabled: number; dryRun: number; hour: number; revision: number }>();
  return { enabled: row?.enabled === 1, dryRun: row?.dryRun !== 0, peopleSyncHour: Number(row?.hour ?? 2), revision: Number(row?.revision ?? 0) };
}

/** PUT /settings: { revision, enabled?, dryRun?, peopleSyncHour? }. */
async function saveSettings(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(1024));
  const allowed = ["revision", "enabled", "dryRun", "peopleSyncHour"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return refuse(400, "validation", "Send the settings fields only.");
  if (!Number.isSafeInteger(input.revision)) return refuse(400, "validation", "Reload the page and try again.");
  for (const key of ["enabled", "dryRun"]) if (key in input && typeof input[key] !== "boolean") return refuse(400, "validation", `Send ${key} as true or false.`, { field: key });
  if ("peopleSyncHour" in input && (!Number.isSafeInteger(input.peopleSyncHour) || (input.peopleSyncHour as number) < 0 || (input.peopleSyncHour as number) > 23)) return refuse(400, "validation", "Choose an hour from 0 to 23.", { field: "peopleSyncHour" });
  const current = await readSettings(db, now);
  const next = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    dryRun: typeof input.dryRun === "boolean" ? input.dryRun : current.dryRun,
    peopleSyncHour: typeof input.peopleSyncHour === "number" ? input.peopleSyncHour : current.peopleSyncHour,
  };
  const result = await db.prepare("UPDATE chores_settings SET enabled=?,dry_run=?,people_sync_hour=?,revision=revision+1,updated_ms=? WHERE installation_id=? AND revision=?")
    .bind(next.enabled ? 1 : 0, next.dryRun ? 1 : 0, next.peopleSyncHour, now, installationId, input.revision).run();
  if (result.meta?.changes !== 1) return refuse(409, "stale", "These settings changed since the page loaded. Reload to see the latest and try again.");
  const changes = [
    next.enabled !== current.enabled ? (next.enabled ? "chores.enabled" : "chores.disabled") : "",
    next.dryRun !== current.dryRun ? (next.dryRun ? "chores.dry_run_on" : "chores.dry_run_off") : "",
    next.peopleSyncHour !== current.peopleSyncHour ? "chores.people_sync_hour_changed" : "",
  ].filter(Boolean);
  if (changes.length) await db.batch(changes.map((action) => audit(db, actor, action, now)));
  if (next.peopleSyncHour !== current.peopleSyncHour) await reschedulePeopleSync(db, next.peopleSyncHour, now);
  return json(await readSettings(db, now));
}

/** /admin/chores */
export async function adminRoute(context: AdminRouteContext): Promise<Response | undefined> {
  const path = context.url.pathname.slice("/admin/chores".length);
  const method = context.request.method;
  const db = context.db as Database; const now = Date.now();
  if (path === "/settings" && (method === "GET" || method === "PUT")) {
    const { userId } = await requireAdmin(context);
    return method === "GET" ? json(await readSettings(db, now)) : saveSettings(context, db, userId, now);
  }
  if (path === "/people" && method === "GET") {
    await context.requireRole(["admin", "operator"]);
    return json(await peopleStatus(db));
  }
  if (path === "/people/sync" && method === "POST") {
    const { userId } = await context.requireRole(["admin", "operator"]);
    context.requireDashboardOrigin("Use the dashboard to sync People.");
    const settings = await readSettings(db, now);
    if (!settings.enabled) return refuse(409, "chores_disabled", "Turn Chores on in its settings first. The People sync runs only while Chores is on.");
    const queued = await requestPeopleSync(db);
    await audit(db, userId, "chores.people_sync_requested", now).run();
    return json({ queued, ...await peopleStatus(db) });
  }
  return undefined;
}
