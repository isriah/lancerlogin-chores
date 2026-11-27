// A stand-in for Core's `services.notion` (SDK 1.8.0), adapted from Part Requests' copy and modelled on Core's
// apps/api/src/module-notion.ts and notion-client.ts. It sends real requests through `fetch`, so the fetch-boundary Notion
// stub (notion-stub.ts) still sees and answers every call. Like Core it refuses undeclared operations and unbound bindings
// before any request, checks that a page belongs to the binding before an update or trash (free for a page it returned in
// this invocation, one read otherwise, refused and counted when it doesn't), caps each invocation at 8 requests, holds every
// call after a rate limit, refuses writes while deliveries are paused and strips email addresses. Each Notion request charges
// `cost` with one external request and one D1 read (Core's authority check), and the first use in an invocation one more D1
// read (Core loading its connection and bindings).
import manifest from "../../src/manifest.ts";
import { testToken } from "./notion-stub.ts";

type Json = Record<string, any>;
export class CoreNotionError extends Error {
  readonly code: string; readonly status: number; readonly providerStatus: number | undefined; readonly uncertain: boolean; readonly retryAfterMs: number | undefined;
  constructor(message: string, code: string, options: { status?: number; providerStatus?: number; uncertain?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.code = code; this.status = options.status ?? 502; this.providerStatus = options.providerStatus; this.uncertain = options.uncertain === true; this.retryAfterMs = options.retryAfterMs;
  }
}
/** Core's HttpError: thrown for bad input and paused deliveries, before anything is sent. Not a Notion failure. */
export class CoreHttpError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export type CoreBinding = { databaseId: string; dataSourceId: string; name: string };
export type CoreNotionState = {
  connection: { token: string; enabled: boolean; readable: boolean } | null;
  bindings: Map<string, CoreBinding>;
  pausedUntilMs: number;
  deliveryPausedUntil: number | null;
  /** Refusals Core would write to its audit log. */
  outOfScope: { binding: string; operation: string }[];
};
export type Cost = { d1: number; external: number; notion: number };

const callsPerInvocation = 8;
const format = (value: unknown) => {
  const hex = typeof value === "string" ? value.replaceAll("-", "").toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
};
const withoutEmails = (value: any): any => Array.isArray(value) ? value.map(withoutEmails) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !(value.object === "user" && key === "person")).map(([key, item]) => [key, withoutEmails(item)])) : value;

/** Core's client: one request, uncertain rules for creates, Retry-After, no retries. */
async function send(token: string, path: string, method = "GET", body?: unknown, creates = false): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(`https://api.notion.com/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new CoreNotionError("Could not confirm the Notion response.", "notion_network", { uncertain: creates }); }
  if (!response.ok) {
    const status = response.status;
    const seconds = Number(response.headers.get("retry-after"));
    const retryAfterMs = status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 1000) : undefined;
    throw new CoreNotionError(`Notion answered ${status}.`, `notion_${status}`, { status: status === 429 ? 429 : 502, providerStatus: status, uncertain: creates && (status >= 500 || status === 409 || status < 400), ...(retryAfterMs ? { retryAfterMs } : {}) });
  }
  let parsed: unknown;
  try { parsed = await response.json(); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CoreNotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: response.status, uncertain: creates });
  return parsed as Json;
}

export function createCoreNotion() {
  const state: CoreNotionState = { connection: null, bindings: new Map(), pausedUntilMs: 0, deliveryPausedUntil: null, outOfScope: [] };
  const declared = (manifest as any).notion as { users?: string[]; bindings: { id: string; required: boolean; operations: string[] }[] };

  /** Core's connection, as an Admin saving a token in Settings > Integrations > Notion leaves it. */
  function connect(token = testToken) { state.connection = { token, enabled: true, readable: true }; }
  function bind(id: string, binding: CoreBinding) { state.bindings.set(id, binding); }

  /** `services.notion` for one invocation (a route request or one job run). */
  function service(cost: Cost) {
    let loaded = false; let calls = 0;
    const known = new Map<string, Set<string>>();
    const remember = (binding: string, id: unknown) => { const page = format(id); if (!page) return; if (!known.has(binding)) known.set(binding, new Set()); known.get(binding)!.add(page); };
    const load = () => { if (!loaded) { loaded = true; cost.d1 += 1; } };
    const refusal = (code: string, status: number) => new CoreNotionError(code, code, { status });
    const usable = () => Boolean(state.connection && state.connection.enabled && state.connection.readable);
    async function request(path: string, method = "GET", body?: unknown, creates = false) {
      load();
      if (!state.connection) throw refusal("notion_not_configured", 503);
      if (!state.connection.enabled) throw refusal("notion_disabled", 503);
      if (!state.connection.readable) throw refusal("notion_unreadable", 503);
      const now = Date.now();
      if (state.pausedUntilMs > now) throw new CoreNotionError("paused", "notion_paused", { status: 429, providerStatus: 429, retryAfterMs: state.pausedUntilMs - now });
      if (calls >= callsPerInvocation) throw refusal("notion_call_limit", 429);
      calls += 1; cost.d1 += 1; cost.external += 1; cost.notion += 1;
      try { return await send(state.connection.token, path, method, body, creates); }
      catch (error) {
        if (error instanceof CoreNotionError && error.providerStatus === 429) state.pausedUntilMs = Date.now() + (error.retryAfterMs ?? 1000);
        throw error;
      }
    }
    const declaredBinding = (id: string, operation?: string) => {
      const binding = declared.bindings.find((item) => item.id === id);
      if (!binding || operation && !binding.operations.includes(operation)) throw refusal("notion_not_declared", 403);
    };
    function bound(id: string, operation: string): CoreBinding {
      declaredBinding(id, operation);
      load();
      const row = state.bindings.get(id);
      if (!row) throw refusal("notion_unbound", 409);
      return row;
    }
    const pausedDelivery = () => { if (state.deliveryPausedUntil !== null) throw new CoreHttpError(409, "Outbound delivery is paused, so nothing was sent to Notion."); };
    const inSource = (page: Json, row: CoreBinding) => page?.object === "page" && page.parent?.type === "data_source_id" && format(page.parent.data_source_id) === format(row.dataSourceId);
    async function inScope(binding: string, row: CoreBinding, id: string, operation: string) {
      if (known.get(binding)?.has(id)) return;
      const page = await request(`/pages/${id}`);
      if (!inSource(page, row)) { state.outOfScope.push({ binding, operation }); throw refusal("notion_out_of_scope", 403); }
      remember(binding, id);
    }
    const pageIdOf = (value: unknown) => { const id = format(value); if (!id) throw new CoreHttpError(400, "A Notion page ID is required"); return id; };
    const propertiesOf = (input: any) => { if (!input?.properties || typeof input.properties !== "object" || !Object.keys(input.properties).length) throw new CoreHttpError(400, "Notion properties must be a non-empty object"); return input.properties; };
    return Object.freeze({
      async ready() { load(); return state.deliveryPausedUntil === null && usable() && declared.bindings.every((binding) => !binding.required || state.bindings.has(binding.id)); },
      async status() {
        load();
        return { connected: usable(), saved: Boolean(state.connection), enabled: Boolean(state.connection?.enabled), readable: Boolean(state.connection?.readable),
          pausedUntilMs: state.pausedUntilMs > Date.now() ? state.pausedUntilMs : null,
          capabilities: { read: "unknown", insert: "unknown", update: "unknown", comment: "unknown", users: "unknown", email: "unknown" },
          bindings: declared.bindings.map((binding) => ({ id: binding.id, required: binding.required, bound: state.bindings.has(binding.id) })) };
      },
      async binding(id: string) { declaredBinding(id); load(); const row = state.bindings.get(id); return row ? { id, ...row } : undefined; },
      async dataSource(id: string) { const row = bound(id, "retrieve"); return withoutEmails(await request(`/data_sources/${row.dataSourceId}`)); },
      async query(id: string, query: { filter?: unknown; sorts?: unknown[]; pageSize?: number; cursor?: string } = {}) {
        const row = bound(id, "query");
        if (Object.keys(query).some((key) => !["filter", "sorts", "pageSize", "cursor"].includes(key))) throw new CoreHttpError(400, "A Notion query takes only filter, sorts, pageSize and cursor");
        const pageSize = query.pageSize ?? 100;
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CoreHttpError(400, "A Notion page size is 1 to 100");
        const page = await request(`/data_sources/${row.dataSourceId}/query`, "POST", { page_size: pageSize, ...(query.cursor ? { start_cursor: query.cursor } : {}), ...(query.filter === undefined ? {} : { filter: query.filter }), ...(query.sorts === undefined ? {} : { sorts: query.sorts }) });
        if (!Array.isArray(page.results)) throw new CoreNotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: 200 });
        for (const result of page.results) if (result?.object === "page") remember(id, result.id);
        return { results: withoutEmails(page.results), ...(page.has_more && page.next_cursor ? { nextCursor: String(page.next_cursor) } : {}) };
      },
      async createPage(id: string, input: { properties: Record<string, unknown> }) {
        declaredBinding(id, "pages.create");
        const properties = propertiesOf(input);
        pausedDelivery();
        const row = bound(id, "pages.create");
        const page = await request("/pages", "POST", { parent: { type: "data_source_id", data_source_id: row.dataSourceId }, properties }, true);
        const pageId = format(page.id);
        if (!pageId) throw new CoreNotionError("Notion accepted the request, but did not return the new page.", "notion_response", { providerStatus: 200, uncertain: true });
        remember(id, pageId);
        return { id: pageId, url: typeof page.url === "string" ? page.url : null, page: withoutEmails(page) };
      },
      async page(id: string, pageId: string) {
        const row = bound(id, "pages.retrieve"); const page = pageIdOf(pageId);
        const result = await request(`/pages/${page}`);
        if (!inSource(result, row)) { state.outOfScope.push({ binding: id, operation: "pages.retrieve" }); throw refusal("notion_out_of_scope", 403); }
        remember(id, page);
        return withoutEmails(result);
      },
      async updatePage(id: string, pageId: string, input: { properties: Record<string, unknown> }) {
        declaredBinding(id, "pages.update");
        const page = pageIdOf(pageId); const properties = propertiesOf(input);
        pausedDelivery();
        const row = bound(id, "pages.update");
        await inScope(id, row, page, "pages.update");
        return withoutEmails(await request(`/pages/${page}`, "PATCH", { properties }));
      },
      async trashPage(id: string, pageId: string) {
        declaredBinding(id, "pages.trash");
        const page = pageIdOf(pageId);
        pausedDelivery();
        const row = bound(id, "pages.trash");
        await inScope(id, row, page, "pages.trash");
        await request(`/pages/${page}`, "PATCH", { in_trash: true });
      },
      async createComment() { throw refusal("notion_not_declared", 403); },
      users: Object.freeze({
        async list() { throw refusal("notion_not_declared", 403); },
        async get(userId: string) {
          if (!declared.users?.includes("retrieve")) throw refusal("notion_not_declared", 403);
          const user = await request(`/users/${pageIdOf(userId)}`);
          return { id: String(user.id ?? ""), type: user.type === "bot" ? "bot" : "person", name: String(user.name ?? "") };
        },
      }),
      providerStatus: (error: unknown) => error instanceof CoreNotionError ? error.providerStatus : undefined,
      retryAfterMs: (error: unknown) => error instanceof CoreNotionError ? error.retryAfterMs : undefined,
      uncertain: (error: unknown) => error instanceof CoreNotionError && error.uncertain,
      errorCode: (error: unknown) => error instanceof CoreNotionError ? error.code : undefined,
      async importLegacyConnection() { throw new CoreHttpError(403, "Only Part Requests can import a Notion connection"); },
    });
  }
  return { state, connect, bind, service };
}
export type CoreNotion = ReturnType<typeof createCoreNotion>;
