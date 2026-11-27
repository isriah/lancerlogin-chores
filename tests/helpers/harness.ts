// Calls the plugin's routes and job the way Core does, adapted from Part Requests' harness. The database reproduces Core's
// scoped database as far as cost goes: reads started in one tick share one batch, and every batch or lone statement counts
// as one D1 query. Every member is synthetic ("Test Student A", @example.test).
import "./sdk-hooks.ts";
import { createTestDatabase, type TestDatabase } from "./d1.ts";
import { createCoreNotion, type Cost } from "./core-notion-stub.ts";
import { ids } from "./notion-stub.ts";
import type { Database, Statement } from "../../src/http.ts";

export const dashboard = "https://site.example.test";

export class StatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Core's read coalescing and query counting. `fail`, when set, is asked about each statement before it runs; returning true
 * makes that statement (or its whole batch) throw as a D1 failure would.
 */
export function coreDatabase(test: TestDatabase) {
  const state = { queries: 0, fail: undefined as ((sql: string) => boolean) | undefined };
  const sqlOf = new WeakMap<object, string>();
  const check = (sql: string) => { if (state.fail?.(sql)) throw new Error("D1_ERROR: simulated"); };
  const originals = new WeakMap<object, any>();
  let queue: { statement: any; resolve: (result: any) => void; reject: (error: unknown) => void }[] | undefined;
  const flush = (items: NonNullable<typeof queue>) => {
    state.queries++;
    for (const item of items) { try { item.resolve(item.statement.execute()); } catch (error) { item.reject(error); } }
  };
  const read = (statement: any) => new Promise<any>((resolve, reject) => {
    if (!queue) { const items: NonNullable<typeof queue> = queue = []; queueMicrotask(() => { queue = undefined; flush(items); }); }
    queue.push({ statement, resolve, reject });
  });
  function wrap(original: any, sql: string): Statement {
    const reads = /^\s*(SELECT|WITH)\b/i.test(sql);
    const statement: Statement = {
      bind: (...values: unknown[]) => wrap(original.bind(...values), sql),
      async first<T>() { check(sql); if (reads) return ((await read(original)).results[0] as T) ?? null; state.queries++; return await original.first() as T; },
      async all<T>() { check(sql); if (reads) return await read(original) as { results?: T[] }; state.queries++; return await original.all(); },
      async run() { check(sql); state.queries++; return original.run(); },
    };
    originals.set(statement, original);
    sqlOf.set(statement, sql);
    return statement;
  }
  const db: Database = {
    prepare: (sql: string) => wrap(test.prepare(sql), sql),
    async batch(statements: Statement[]) { state.queries++; for (const statement of statements) check(sqlOf.get(statement)!); return test.batch(statements.map((statement) => originals.get(statement))); },
  };
  return { db, state };
}

export type Harness = ReturnType<typeof createHarness>;

/** One scheduler slice's spend: the plugin's D1 queries plus Core's Notion bookkeeping, and the Notion requests. */
export type SliceCost = { readonly d1: number; readonly external: number; readonly notion: number; readonly total: number };

export function createHarness(api: any) {
  const test = createTestDatabase();
  test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email) VALUES ('m-a','primary','9001','Test Student','A','student.a@example.test')");
  test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email) VALUES ('m-b','primary','9002','Test Student','B','student.b@example.test')");
  const { db, state } = coreDatabase(test);
  const core = createCoreNotion();
  let lastCost: Cost = { d1: 0, external: 0, notion: 0 };
  /** `services` for one invocation, as Core builds them per request and per job run. */
  function services() { lastCost = { d1: 0, external: 0, notion: 0 }; return { notion: core.service(lastCost) }; }

  async function call(method: string, path: string, init: { body?: unknown; role?: "admin" | "operator" | null; origin?: string } = {}) {
    const url = new URL(`https://worker.example.test${path}`);
    const family = ["/admin/chores", "/module-setup/chores"].find((prefix) => url.pathname.startsWith(prefix))!;
    const request = new Request(url, { method, headers: init.origin ? { origin: init.origin } : {} });
    const role = init.role === undefined ? "admin" : init.role;
    const context = {
      request, url, db, services: services(), dashboardOrigin: dashboard,
      json: async () => init.body,
      async requireRole(roles: readonly string[]) {
        if (!role) throw new StatusError(401, "Sign in");
        if (!roles.includes(role)) throw new StatusError(403, "Your role cannot perform this action");
        return { userId: "u-admin", role };
      },
      requireDashboardOrigin(message: string) { if (init.origin !== dashboard) throw new StatusError(403, message); },
    };
    let result: Response | undefined;
    try { result = await api.routes[family](context); }
    catch (error) { if (error instanceof StatusError) result = Response.json({ error: error.message }, { status: error.status }); else throw error; }
    if (!result) return { status: 404, body: undefined as any, text: "" };
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : undefined, text };
  }

  const setup = (method: string, path: string, body?: unknown) => call(method, `/module-setup/chores${path}`, { body, origin: dashboard });
  const admin = (method: string, path: string, body?: unknown, role: "admin" | "operator" = "admin") => call(method, `/admin/chores${path}`, { body, origin: dashboard, role });

  /** Core's connection with the three required bindings (and the task database when asked), as an Admin leaves them. */
  function bindAll(withTask = false) {
    core.connect();
    core.bind("chores", { databaseId: ids.choresDatabase, dataSourceId: ids.choresSource, name: "Test Chores" });
    core.bind("log", { databaseId: ids.logDatabase, dataSourceId: ids.logSource, name: "Test Chore log" });
    core.bind("people", { databaseId: ids.peopleDatabase, dataSourceId: ids.peopleSource, name: "Test People" });
    if (withTask) core.bind("task", { databaseId: ids.taskDatabase, dataSourceId: ids.taskSource, name: "Test Tasks" });
  }

  /** Bind, then the real verify route. */
  async function connect(withTask = false) {
    bindAll(withTask);
    const verified = await setup("POST", "/verify", {});
    if (verified.status !== 200) throw new Error(`verify ${verified.text}`);
  }

  /** Chores switched on, with dry-run as given. */
  function settings(values: { enabled?: boolean; dryRun?: boolean }) {
    test.run("INSERT OR IGNORE INTO chores_settings(installation_id,updated_ms) VALUES ('primary',0)");
    if (values.enabled !== undefined) test.run("UPDATE chores_settings SET enabled=? WHERE installation_id='primary'", values.enabled ? 1 : 0);
    if (values.dryRun !== undefined) test.run("UPDATE chores_settings SET dry_run=? WHERE installation_id='primary'", values.dryRun ? 1 : 0);
  }

  /** One scheduler slice of the job, with what it spent. */
  async function slice(steps = true): Promise<{ outcome: any; cost: SliceCost }> {
    const before = state.queries;
    const context = { db, services: services(), scheduler: { steps } };
    const outcome = await api.jobs["chores.run"](context);
    const d1 = state.queries - before + lastCost.d1;
    return { outcome, cost: { d1, external: lastCost.external, notion: lastCost.notion, total: d1 + lastCost.external } };
  }

  /** The job until it stops asking for more, as the scheduler would run it. */
  async function runJob(steps = true, limit = 200) {
    const slices: { outcome: any; cost: SliceCost }[] = [];
    for (let run = 0; run < limit; run++) {
      const result = await slice(steps);
      slices.push(result);
      if (!result.outcome?.more) break;
    }
    return slices;
  }

  return { test, db, state, core, services, call, setup, admin, bindAll, connect, settings, slice, runJob };
}
