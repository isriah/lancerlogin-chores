// Worker contribution. Every route requires a signed-in Admin (or, for the People panel, an assigned Operator), and changes
// must come from the dashboard. Notion goes only through Core's `services.notion`.
import { defineApiModule, type D1Database, type ModuleRouteContext } from "@lancerlogin/module-sdk/api";
import { adminRoute } from "./admin.ts";
import { connectionStepSql, setupRoute, writeCheckStepSql, type AdminRouteContext } from "./connection.ts";
import { installationId } from "./http.ts";
import { runChores } from "./people.ts";

const step = (sql: string) => (installation: string) => ({ sql, bindings: [installation] });
const stepSql: Readonly<Record<string, string>> = { "notion-connection": connectionStepSql, "person-write-check": writeCheckStepSql };

const api = defineApiModule({
  moduleId: "chores",
  routes: {
    "/admin/chores": (context: ModuleRouteContext<unknown>) => adminRoute(context as unknown as AdminRouteContext),
    "/module-setup/chores": (context: ModuleRouteContext<unknown>) => setupRoute(context as unknown as AdminRouteContext),
  },
  privateResponseRoutes: ["/admin/chores", "/module-setup/chores"],
  jobs: { "chores.run": (context) => runChores(context) },
  setup: {
    predicates: { "notion-connection": step(connectionStepSql), "person-write-check": step(writeCheckStepSql) },
    stepValid: async (db: D1Database, stepId: string) => Boolean(stepSql[stepId] && await db.prepare(`SELECT 1 AS present WHERE ${stepSql[stepId]}`).bind(installationId).first()),
  },
  // Append only: Core stores deletion progress by position.
  cleanup: {
    steps: [
      { kind: "delete", table: "chores_events" },
      { kind: "delete", table: "chores_sync" },
      { kind: "delete", table: "chores_people" },
      { kind: "delete", table: "chores_assignments" },
      { kind: "delete", table: "chores_crew" },
      { kind: "delete", table: "chores_runs" },
      { kind: "delete", table: "chores_catalog" },
      { kind: "delete", table: "chores_notion" },
      { kind: "delete", table: "chores_label_rules" },
      { kind: "delete", table: "chores_settings" },
      { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["chores"] },
      { kind: "assignments" },
    ],
  },
  backup: {
    version: 1,
    tables: {
      chores_settings: ["installation_id", "enabled", "dry_run", "assign_time", "reassign_time", "period", "season_start", "discord_channel_id", "people_sync_hour", "revision", "updated_ms"],
      chores_label_rules: ["installation_id", "label_id", "role", "updated_ms"],
    },
  },
});

export default api;
