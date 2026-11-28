// Notion through Core's shared connection (`services.notion`, SDK 1.8.0): reading the databases' layouts, checking them,
// and every read and write Chores makes. Core holds the token and sends every request; Chores names a binding from its
// manifest and never sees the token. Traps the Part Requests client recorded, still kept here: property IDs must be compared
// decoded; `filter_properties` silently returns rows without the property; a page is created with properties only.
//
// Writes go only through the typed methods of ChoresNotion, and each checks its properties against an allow-list built from
// the checked layout before anything reaches Core. Schema checks require only the listed properties and ignore any others
// (such as a "Board column" formula), which are never written. The People database is Core's (SDK 1.10.0): Core keeps it in
// step with the roster and Chores reads the matches from Core, so Chores has no People binding and never writes People.
import type { NotionService } from "@lancerlogin/module-sdk/api";

/** The bindings declared in the manifest's `notion.bindings`. */
export const bindingIds = ["chores", "log"] as const;
export type BindingId = (typeof bindingIds)[number];
export const requiredBindings: readonly BindingId[] = ["chores", "log"];

export class AppError extends Error {
  readonly code: string;
  /** True when Notion may have created the page. An uncertain create is never sent again automatically. */
  readonly uncertain: boolean;
  readonly details: unknown;
  constructor(message: string, code = "validation", uncertain = false, details?: unknown) {
    super(message);
    this.code = code; this.uncertain = uncertain; this.details = details;
  }
}

type Json = Record<string, any>;
export type Choice = { readonly id: string; readonly name: string };
export type PropertyMapping = { readonly id: string; readonly type: string; readonly options?: readonly Choice[] };
export type SourceSchema<Field extends string> = {
  readonly databaseId: string; readonly dataSourceId: string; readonly name?: string; readonly properties: Readonly<Record<Field, PropertyMapping>>;
};

/**
 * The properties Chores needs in each database, by name and type. A missing one or a different type is refused when the
 * databases are verified; any other property (a formula such as "Board column", for example) is ignored and never written.
 */
export const choresLayout = {
  name: ["Name", "title"], area: ["Area", "select"], active: ["Active", "checkbox"], peopleNeeded: ["People needed", "number"],
  days: ["Days", "multi_select"], notes: ["Notes", "rich_text"],
} as const;
export const logLayout = {
  name: ["Name", "title"], date: ["Date", "date"], chore: ["Chore", "relation"], person: ["Person", "people"], status: ["Status", "select"],
  done: ["Done", "checkbox"], assignedBy: ["Assigned by", "rich_text"],
} as const;
export const logStatuses = ["Assigned", "Replacement", "Reassigned (not checked in)"] as const;

export type ChoresField = keyof typeof choresLayout;
export type LogField = keyof typeof logLayout;
export type LogStatus = (typeof logStatuses)[number];
export type Schema = { readonly chores: SourceSchema<ChoresField>; readonly log: SourceSchema<LogField> };

/** The Chore log properties Chores may write. Done is ticked by members in Notion and only ever read. */
export const logWritable: readonly LogField[] = ["name", "date", "chore", "person", "status", "assignedBy"];

const notionHosts = ["notion.so", "notion.com", "notion.site"];
export const onNotionHost = (hostname: string) => notionHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));

/** A link to the database from its saved ID. Notion redirects it to wherever the workspace lives. */
export const databaseLink = (databaseId: string) => `https://www.notion.so/${databaseId.replaceAll("-", "")}`;

/** Notion reports the same property ID encoded in some places and plain in others. */
export function decodedId(id: unknown): string {
  try { return decodeURIComponent(String(id)); } catch { return String(id); }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dashed = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** A Notion object ID in its dashed lowercase form, or undefined. */
export function canonicalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().toLowerCase().replaceAll("-", "");
  return /^[0-9a-f]{32}$/.test(hex) ? dashed(hex) : undefined;
}

/** A Notion link that is safe to store and open: https on Notion's own hosts, no credentials. */
export function validNotionUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && onNotionHost(url.hostname) ? url.href : undefined;
  } catch { return undefined; }
}

const sourceTitle = (source: Json): string => Array.isArray(source.title) ? source.title.map((part: Json) => String(part?.plain_text ?? "")).join("") : "";
const named = (name: string) => name ? { name: name.trim().slice(0, 200) } : {};

/** Find each listed property by name and type. Extra properties are allowed. Throws a schema error naming what is wrong. */
export function mapSource<Field extends string>(label: string, layout: Readonly<Record<Field, readonly [string, string]>>, source: Json, databaseId: string, listedName = ""): SourceSchema<Field> {
  const properties = {} as Record<Field, PropertyMapping>;
  for (const [field, [name, type]] of Object.entries(layout) as [Field, readonly [string, string]][]) {
    const property = source.properties?.[name];
    if (!property || property.type !== type) throw new AppError(`${label}: the property "${name}" must exist with type ${type.replace("_", "-")}. Check the database; nothing was changed.`, "schema");
    const options = property[type]?.options?.map((option: Json) => ({ id: String(option.id), name: String(option.name) })) as Choice[] | undefined;
    properties[field] = { id: String(property.id), type, ...(options ? { options } : {}) };
  }
  return { databaseId, dataSourceId: String(source.id), ...named(listedName || sourceTitle(source)), properties };
}

export const mapChores = (source: Json, databaseId: string, listedName?: string) => mapSource("Chores database", choresLayout, source, databaseId, listedName);

/** The Chore log needs its three Status options, and Chore must relate to the Chores database when Notion says where it points. */
export function mapLog(source: Json, databaseId: string, choresDataSourceId: string, listedName?: string): SourceSchema<LogField> {
  const schema = mapSource("Chore log", logLayout, source, databaseId, listedName);
  const missing = logStatuses.filter((status) => !schema.properties.status.options?.some((option) => option.name === status));
  if (missing.length) throw new AppError(`Chore log: add the Status option${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")} in Notion before connecting. Chores never creates options.`, "schema");
  const relation = source.properties?.Chore?.relation ?? {};
  const target = canonicalId(relation.data_source_id);
  if (target && target !== canonicalId(choresDataSourceId)) throw new AppError("Chore log: the Chore property must relate to the Chores database.", "schema");
  return schema;
}

/** The Status option to write, by its existing ID. A name that is not already an option is refused, never created. */
export function statusValue(schema: Schema, status: string): Json {
  const option = schema.log.properties.status.options?.find((item) => item.name === status);
  if (!option) throw new AppError("The Chore log's Status options changed. An Admin needs to check the connection.", "schema");
  return { select: { id: option.id } };
}

/** Refuse any Chore log property outside the allow-list, before anything is sent. */
export function assertWritable(schema: Schema, properties: Json): void {
  const allowed = new Set(logWritable.map((field) => decodedId(schema.log.properties[field].id)));
  const keys = Object.keys(properties);
  if (!keys.length || keys.some((key) => !allowed.has(decodedId(key)))) throw new AppError("Chores may not write that Notion property.", "write_not_allowed");
}

const statusMessage = (status: number) => status === 401 ? "Notion rejected the token saved in Core. An Admin needs to save a new one in Settings > Integrations > Notion."
  : status === 403 ? "Core's Notion connection lacks permission. Check its capabilities: Read content, Insert content, Update content and Read user information."
  : status === 404 ? "Notion cannot open that database or page. Share the database with Core's Notion connection and choose it again."
  : status === 429 ? "Notion is rate limiting requests. Chores will wait and try again."
  : status === 400 ? "Notion rejected the request. An Admin needs to verify the Chores databases again."
  : status === 409 ? "Notion reported a conflict. Check the database before trying again."
  : "Notion did not confirm the operation. Check the database before trying again.";

const codeMessages: Readonly<Record<string, string>> = {
  notion_network: "Could not confirm the Notion response.",
  notion_response: "Notion returned an unreadable response.",
  notion_not_configured: "Core's Notion connection is not set up. An Admin can connect it in Settings > Integrations > Notion.",
  notion_disabled: "Core's Notion connection is turned off. An Admin can turn it on in Settings > Integrations > Notion.",
  notion_unreadable: "The Notion token saved in Core can't be read. An Admin needs to save it again in Settings > Integrations > Notion.",
  notion_unbound: "An Admin has not chosen all of the Chores databases yet.",
  notion_call_limit: "This request reached its limit of Notion calls. Try again in a moment.",
  notion_not_declared: "Chores asked Notion for something it did not declare. Nothing was sent.",
  notion_out_of_scope: "That Notion page is not in the database chosen for Chores. Nothing was changed.",
  delivery_paused: "Outbound delivery is paused, so nothing was sent to Notion.",
};

/** Core's HttpError for a write while an Admin's Stop or a restore pauses outbound delivery. */
const deliveryPaused = (error: unknown) => error instanceof Error && !(error instanceof AppError) && (error as { status?: unknown }).status === 409;

/**
 * A failure from `services.notion` as this plugin's AppError: `notion_<status>` for an answer from Notion (Core's shared
 * pause after a rate limit is a 429 too), Core's own code otherwise, and `delivery_paused` for a write Core held back.
 * Undefined for anything else, which the caller rethrows. Messages are fixed: nothing from Notion's reply.
 */
export function notionFailure(notion: NotionService, error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  const code = notion.errorCode(error);
  if (code === undefined) return deliveryPaused(error) ? new AppError(codeMessages.delivery_paused!, "delivery_paused") : undefined;
  const status = notion.providerStatus(error);
  const retryAfterMs = notion.retryAfterMs(error);
  // An answer that arrived but could not be read carries Notion's 2xx status; its code says more than the status.
  const answered = status !== undefined && (status < 200 || status >= 300);
  const normalized = answered ? `notion_${status}` : code;
  const message = answered ? statusMessage(status) : codeMessages[code] ?? "Notion could not be reached through Core. Try again in a moment.";
  return new AppError(message, normalized, notion.uncertain(error), retryAfterMs && retryAfterMs > 0 ? { retryAfterMs } : undefined);
}

const pageId = (value: string) => {
  const id = canonicalId(value);
  if (!id || !uuidPattern.test(id)) throw new AppError("That is not a Notion page ID.");
  return id;
};

export type QueryPage = { readonly results: readonly Json[]; readonly next?: string };
export type CreatedPage = { readonly id: string; readonly url?: string };

/** Notion requests Core lets one invocation send (`notionCallsPerInvocation` in Core). */
export const notionCallsPerInvocation = 8;

const bindingLabel = (binding: BindingId) => binding === "log" ? "Chore log" : "Chores";

/**
 * Chores' databases through Core's bindings. Each method is one Notion request, except an update or trash of a page Core has
 * not returned in this invocation, which Core checks with one more read first. `spent` counts them that way, so a job can stop
 * before Core's cap. Failures are AppErrors (see notionFailure); an uncertain create is never sent again automatically.
 */
export class ChoresNotion {
  readonly #notion: NotionService;
  readonly #known = new Set<string>();
  #spent = 0;
  constructor(notion: NotionService) { this.#notion = notion; }

  /** Notion requests made through this object so far, page checks included. */
  get spent(): number { return this.#spent; }
  /** Requests left under Core's per-invocation cap. */
  get remaining(): number { return notionCallsPerInvocation - this.#spent; }

  async #call<T>(cost: number, work: () => Promise<T>): Promise<T> {
    this.#spent += cost;
    try { return await work(); }
    catch (error) { throw notionFailure(this.#notion, error) ?? error; }
  }
  #remember(id: unknown) { const canonical = canonicalId(id); if (canonical) this.#known.add(canonical); }
  /** What a write to this page costs: one request, plus Core's page check unless Core returned the page in this invocation. */
  writeCost(id: string): number { return this.#known.has(canonicalId(id) ?? "") ? 1 : 2; }

  /** The data source an Admin chose for a binding, read in full, or undefined when none is chosen (no request then). */
  async source(binding: BindingId): Promise<{ readonly databaseId: string; readonly dataSourceId: string; readonly name: string; readonly source: Json } | undefined> {
    const bound = await this.#call(0, () => this.#notion.binding(binding));
    if (!bound) return undefined;
    const source = await this.#call(1, () => this.#notion.dataSource(binding));
    return { databaseId: bound.databaseId, dataSourceId: bound.dataSourceId, name: bound.name, source };
  }

  /**
   * Every bound database's layout, checked: two requests. Each failure names its binding, so the page can point at
   * the right picker. An unbound required binding is refused before its request.
   */
  async readSchema(): Promise<Schema> {
    const tagged = <T>(binding: BindingId, work: () => T): T => {
      try { return work(); } catch (error) { if (error instanceof AppError) (error as AppError & { field?: string }).field = binding; throw error; }
    };
    const read = async (binding: BindingId) => {
      try { return await this.source(binding); }
      catch (error) { if (error instanceof AppError) (error as AppError & { field?: string }).field = binding; throw error; }
    };
    const need = async (binding: BindingId) => {
      const found = await read(binding);
      if (!found) throw Object.assign(new AppError(`Choose the ${bindingLabel(binding)} database first.`, "notion_unbound"), { field: binding });
      return found;
    };
    const chores = await need("chores");
    const choresSchema = tagged("chores", () => mapChores(chores.source, chores.databaseId, chores.name));
    const log = await need("log");
    const logSchema = tagged("log", () => mapLog(log.source, log.databaseId, choresSchema.dataSourceId, log.name));
    if ((canonicalId(choresSchema.dataSourceId) ?? choresSchema.dataSourceId) === (canonicalId(logSchema.dataSourceId) ?? logSchema.dataSourceId)) throw Object.assign(new AppError("The Chores database and the Chore log must be different Notion databases.", "schema"), { field: "log" });
    return { chores: choresSchema, log: logSchema };
  }

  /**
   * One page of rows, oldest first so paging stays stable as rows are added. Rows carry every property: asking for fewer with
   * `filter_properties` silently returned rows without them. Core refuses a malformed reply rather than reading it as no rows.
   */
  async query(binding: BindingId, pageSize: number, cursor?: string, filter?: Json): Promise<QueryPage> {
    const page = await this.#call(1, () => this.#notion.query(binding, {
      pageSize, ...(cursor ? { cursor } : {}), ...(filter ? { filter } : {}), sorts: [{ timestamp: "created_time", direction: "ascending" }],
    }));
    for (const row of page.results) this.#remember(row?.id);
    return { results: page.results, ...(page.nextCursor ? { next: page.nextCursor } : {}) };
  }

  async #create(properties: Json): Promise<CreatedPage> {
    const page = await this.#call(1, () => this.#notion.createPage("log", { properties }));
    const id = canonicalId(page.id);
    if (!id) throw new AppError("Notion accepted the request, but did not return the new page. Check the database.", "notion_response", true);
    this.#remember(id);
    const url = validNotionUrl(page.url);
    return { id, ...(url ? { url } : {}) };
  }

  /** Create one Chore log row from allow-listed properties. */
  async createLogRow(schema: Schema, properties: Json): Promise<CreatedPage> {
    assertWritable(schema, properties);
    return this.#create(properties);
  }

  /** One Chore log row. Core refuses a page of any other database. */
  async logPage(id: string): Promise<Json> {
    const page = pageId(id);
    const result = await this.#call(1, () => this.#notion.page("log", page));
    this.#remember(page);
    return result;
  }

  /** Move one Chore log row to Notion's trash. Core sends only the trash flag, so nothing else on the page changes. */
  async trashLogPage(id: string): Promise<void> {
    const page = pageId(id);
    await this.#call(this.writeCost(page), () => this.#notion.trashPage("log", page));
  }

  /** One workspace user, without an email address. */
  async user(id: string): Promise<{ readonly id: string; readonly type: "person" | "bot"; readonly name: string }> {
    const user = pageId(id);
    return this.#call(1, () => this.#notion.users.get(user));
  }
}

/** A property of a page by its mapped ID, compared decoded. */
export const pageProperty = (page: Json, mapping: PropertyMapping): Json | undefined =>
  (Object.values(page?.properties ?? {}) as Json[]).find((item) => decodedId(item?.id) === decodedId(mapping.id));

export const plainText = (value: unknown): string => Array.isArray(value) ? value.map((part: Json) => String(part?.plain_text ?? part?.text?.content ?? "")).join("") : "";

/** Person IDs in a people property, bots left out. */
export const peopleIds = (property: Json | undefined): string[] =>
  ((property?.people ?? []) as Json[]).filter((user) => user?.id && user.type !== "bot").map((user) => canonicalId(user.id) ?? String(user.id));
