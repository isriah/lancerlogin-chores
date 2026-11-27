// A stand-in for Notion at the fetch boundary, behind the Core `services.notion` stand-in (core-notion-stub.ts). It holds the
// four Chores databases and their rows in memory, with responses shaped like Notion's, and records every call. Like the two
// runtimes it throws "Illegal invocation" when called with a receiver and refuses `redirect: "error"`. All data is synthetic.

export const testToken = "ntn_TESTtokenNEVERrealABCDEFGHIJKLMNOPQRSTUV0123456789";
export const ids = {
  choresDatabase: "11111111-1111-4111-8111-111111111111", choresSource: "a1111111-1111-4111-8111-111111111111",
  logDatabase: "22222222-2222-4222-8222-222222222222", logSource: "a2222222-2222-4222-8222-222222222222",
  peopleDatabase: "33333333-3333-4333-8333-333333333333", peopleSource: "a3333333-3333-4333-8333-333333333333",
  taskDatabase: "44444444-4444-4444-8444-444444444444", taskSource: "a4444444-4444-4444-8444-444444444444",
  otherSource: "a5555555-5555-4555-8555-555555555555",
};
export const personA = "c0000000-0000-4000-8000-00000000000a";
export const personB = "c0000000-0000-4000-8000-00000000000b";
export const guestPerson = "c0000000-0000-4000-8000-00000000000c";
export const botUser = "b0000000-0000-4000-8000-000000000000";

export type Call = { readonly url: string; readonly method: string; readonly path: string; readonly body: any };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const select = (id: string, names: string[]) => ({ id, type: "select", select: { options: names.map((name, index) => ({ id: `${id}-${index}`, name, color: "gray" })) } });

export function choresSource(): any {
  return { object: "data_source", id: ids.choresSource, title: [{ plain_text: "Test Chores" }], parent: { type: "database_id", database_id: ids.choresDatabase }, properties: {
    Name: { id: "title", type: "title", title: {} }, Area: select("ar%3Aea", ["Test Area"]), Active: { id: "actv", type: "checkbox", checkbox: {} },
    "People needed": { id: "pndd", type: "number", number: {} }, Days: { id: "days", type: "multi_select", multi_select: { options: [] } }, Notes: { id: "note", type: "rich_text", rich_text: {} },
  } };
}
export function logSource(): any {
  return { object: "data_source", id: ids.logSource, title: [{ plain_text: "Test Chore log" }], parent: { type: "database_id", database_id: ids.logDatabase }, properties: {
    Name: { id: "title", type: "title", title: {} }, Date: { id: "date", type: "date", date: {} },
    Chore: { id: "chor", type: "relation", relation: { data_source_id: ids.choresSource } }, Person: { id: "pe%3Ars", type: "people", people: {} },
    Status: select("stat", ["Assigned", "Replacement", "Reassigned (not checked in)"]), Done: { id: "done", type: "checkbox", checkbox: {} },
    "Assigned by": { id: "asby", type: "rich_text", rich_text: {} },
    // An extra read-only formula for the exit TV. Schema checks ignore it and nothing writes it.
    "Board column": { id: "brdc", type: "formula", formula: { expression: "" } },
  } };
}
export function peopleSource(): any {
  return { object: "data_source", id: ids.peopleSource, title: [{ plain_text: "Test People" }], parent: { type: "database_id", database_id: ids.peopleDatabase }, properties: {
    Name: { id: "title", type: "title", title: {} }, "LancerLogin member ID": { id: "mbid", type: "rich_text", rich_text: {} },
    "Notion account": { id: "acct", type: "people", people: {} }, "Suggested account": { id: "sugg", type: "people", people: {} },
    Active: { id: "actv", type: "checkbox", checkbox: {} },
    "Needs account": { id: "need", type: "formula", formula: { expression: "" } },
  } };
}
export function taskSource(): any {
  return { object: "data_source", id: ids.taskSource, title: [{ plain_text: "Test Tasks" }], parent: { type: "database_id", database_id: ids.taskDatabase }, properties: {
    Task: { id: "title", type: "title", title: {} }, Owner: { id: "ownr", type: "people", people: {} },
  } };
}

const user = (id: string, name: string) => ({ object: "user", id, type: "person", name, person: { email: "never.shared@example.test" } });

/** A People row as Notion returns it. Property IDs arrive encoded where Notion encodes them. */
export function peopleRow(input: { id?: string; name: string; memberId: string; active?: boolean; accounts?: { id: string; name: string }[]; suggested?: { id: string; name: string }[] }): any {
  return { object: "page", id: input.id ?? crypto.randomUUID(), url: "https://www.notion.so/test-person", parent: { type: "data_source_id", data_source_id: ids.peopleSource }, properties: {
    Name: { id: "title", type: "title", title: [{ plain_text: input.name, text: { content: input.name } }] },
    "LancerLogin member ID": { id: "mbid", type: "rich_text", rich_text: input.memberId ? [{ plain_text: input.memberId, text: { content: input.memberId } }] : [] },
    "Notion account": { id: "acct", type: "people", people: (input.accounts ?? []).map((account) => user(account.id, account.name)) },
    "Suggested account": { id: "sugg", type: "people", people: (input.suggested ?? []).map((account) => user(account.id, account.name)) },
    Active: { id: "actv", type: "checkbox", checkbox: input.active ?? true },
  } };
}

export function taskRow(owners: { id: string; name: string; type?: string }[]): any {
  return { object: "page", id: crypto.randomUUID(), parent: { type: "data_source_id", data_source_id: ids.taskSource }, properties: {
    Task: { id: "title", type: "title", title: [{ plain_text: "Test task" }] },
    Owner: { id: "ownr", type: "people", people: owners.map((owner) => ({ object: "user", id: owner.id, type: owner.type ?? "person", name: owner.name })) },
  } };
}

export type Stub = {
  readonly calls: Call[];
  /** Rows by data source, oldest first. */
  readonly rows: Map<string, any[]>;
  /** Pages by ID, wherever they live, trashed ones included. */
  readonly pages: Map<string, any>;
  readonly sources: Map<string, any>;
  /** Replace the answer to matching calls ("METHOD /path"). */
  on(match: RegExp, answer: (call: Call) => Response | Promise<Response>): void;
  /** Rows per query page. */
  pageSize: number;
  restore(): void;
};

/** A written property value as Notion reads it back: text gains plain_text, people gain their user fields. */
const stored = (value: any) => ({
  ...value,
  ...(value.title ? { title: value.title.map((part: any) => ({ plain_text: part.text.content, text: part.text })) } : {}),
  ...(value.rich_text ? { rich_text: value.rich_text.map((part: any) => ({ plain_text: part.text.content, text: part.text })) } : {}),
  ...(value.people ? { people: value.people.map((person: any) => ({ object: "user", id: person.id, type: "person", name: "Test Person" })) } : {}),
});
const schemaIds = (source: any) => Object.fromEntries(Object.entries(source.properties).map(([name, property]: [string, any]) => [decodeURIComponent(property.id), name]));

export function stubNotion(): Stub {
  const original = globalThis.fetch;
  const overrides: { match: RegExp; answer: (call: Call) => Response | Promise<Response> }[] = [];
  const stub: Stub = {
    calls: [], rows: new Map([[ids.choresSource, []], [ids.logSource, []], [ids.peopleSource, []], [ids.taskSource, []]]), pages: new Map(),
    sources: new Map([[ids.choresSource, choresSource()], [ids.logSource, logSource()], [ids.peopleSource, peopleSource()], [ids.taskSource, taskSource()]]),
    on(match, answer) { overrides.unshift({ match, answer }); },
    pageSize: 100,
    restore() { globalThis.fetch = original; },
  };
  globalThis.fetch = async function (this: unknown, input: unknown, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    if (init?.redirect === "error") throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    const url = String(input);
    if (!url.startsWith("https://api.notion.com/v1/")) throw new Error(`Unexpected request to ${url}`);
    const headers = init?.headers as Record<string, string>;
    const path = url.slice("https://api.notion.com/v1".length);
    const call: Call = { url, method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    stub.calls.push(call);
    const line = `${call.method} ${path}`;
    const override = overrides.find((item) => item.match.test(line));
    if (override) return override.answer(call);
    if (headers.Authorization !== `Bearer ${testToken}`) return response({ object: "error", status: 401, code: "unauthorized" }, 401);
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^GET \/data_sources\/([0-9a-f-]{36})$/))) {
      const source = stub.sources.get(match[1]!);
      return source ? response(source) : response({ object: "error", status: 404, code: "object_not_found" }, 404);
    }
    if ((match = line.match(/^POST \/data_sources\/([0-9a-f-]{36})\/query$/))) {
      if (call.body.filter_properties) throw new Error("filter_properties must not be used");
      let rows = (stub.rows.get(match[1]!) ?? []).filter((row) => !row.in_trash);
      const filter = call.body.filter;
      if (filter?.people?.is_not_empty) rows = rows.filter((row) => (Object.values(row.properties) as any[]).find((property) => decodeURIComponent(property.id) === decodeURIComponent(filter.property))?.people?.length);
      const start = call.body.start_cursor ? Number(call.body.start_cursor) : 0;
      const size = Math.min(call.body.page_size ?? 100, stub.pageSize);
      const results = rows.slice(start, start + size);
      const more = start + size < rows.length;
      return response({ object: "list", results, has_more: more, next_cursor: more ? String(start + size) : null });
    }
    if (line === "POST /pages") {
      const sourceId = call.body.parent?.data_source_id;
      const source = stub.sources.get(sourceId);
      if (!source || call.body.parent?.type !== "data_source_id") return response({ object: "error", status: 404, code: "object_not_found" }, 404);
      const names = schemaIds(source);
      const properties: Record<string, any> = {};
      for (const [id, value] of Object.entries(call.body.properties as Record<string, any>)) {
        const name = names[decodeURIComponent(id)];
        if (!name) return response({ object: "error", status: 400, code: "validation_error" }, 400);
        properties[name] = { id: source.properties[name].id, type: source.properties[name].type, ...stored(value) };
      }
      const page = { object: "page", id: crypto.randomUUID(), url: "https://app.notion.com/p/created", parent: { type: "data_source_id", data_source_id: sourceId }, properties };
      stub.pages.set(page.id, page);
      stub.rows.get(sourceId)!.push(page);
      return response(page);
    }
    if ((match = line.match(/^GET \/pages\/([0-9a-f-]{36})$/))) {
      const page = stub.pages.get(match[1]!);
      return page ? response(page) : response({ object: "error", status: 404, code: "object_not_found" }, 404);
    }
    if ((match = line.match(/^PATCH \/pages\/([0-9a-f-]{36})$/))) {
      const page = stub.pages.get(match[1]!);
      if (!page) return response({ object: "error", status: 404, code: "object_not_found" }, 404);
      if (call.body.in_trash === true) { page.in_trash = true; return response(page); }
      const names = schemaIds(stub.sources.get(page.parent.data_source_id));
      for (const [id, value] of Object.entries(call.body.properties as Record<string, any>)) {
        const name = names[decodeURIComponent(id)];
        if (!name) return response({ object: "error", status: 400, code: "validation_error" }, 400);
        page.properties[name] = { ...page.properties[name], ...stored(value) };
      }
      return response(page);
    }
    if ((match = line.match(/^GET \/users\/([0-9a-f-]{36})$/))) {
      if (match[1] === botUser) return response({ object: "user", id: botUser, type: "bot", name: "Test Bot", bot: {} });
      if (match[1] === guestPerson) return response({ object: "error", status: 404, code: "object_not_found" }, 404);
      return response(user(match[1]!, "Test Person"));
    }
    return response({ object: "error", status: 404, code: "object_not_found" }, 404);
  } as typeof fetch;
  return stub;
}

/** Put rows into a database as Notion holds them. */
export function seed(stub: Stub, sourceId: string, rows: any[]) {
  for (const row of rows) { stub.rows.get(sourceId)!.push(row); stub.pages.set(row.id, row); }
}

export const notionResponse = response;
