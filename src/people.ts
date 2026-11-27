// The People sync. The Notion People database is the only match between a LancerLogin member and a Notion account, and
// Chores is its only writer. Each row carries the member ID members type (the roster's external ID), never the internal ID.
//
// A run reads every People row into chores_people, then makes the rows follow the active roster: it creates a row for an
// active member without one, corrects a changed name, ticks Active again for a returning member and unticks it for a member
// no longer active. It never deletes a row and never writes Notion account. With a task database configured it then scans
// that database's people properties and writes Suggested account on a row only when the row's name matches exactly one
// account by normalised name and its Notion account is empty. A suggestion is never a match.
//
// Every Notion request goes through Core's `services.notion` (bindings `people` and `task`). Each scheduler slice does one
// step: one query, one create, or one update (two requests when Core first checks the page belongs to People). It keeps its
// place in chores_sync, which is what Workers Free's limits ask of a job. In dry-run it reads and counts what it would write,
// and writes nothing to Notion.
import { listActiveRosterIdentities, type D1Database } from "@lancerlogin/module-sdk/api";
import { clearRefusal, connectionProblem, parseSchema, readConnection, readCore, recordRefusal, type ConnectionRow, type NotionServices } from "./connection.ts";
import { event, installationId, type Database, type Statement } from "./http.ts";
import { AppError, ChoresNotion, pageProperty, peopleIds, plainText, canonicalId, type Schema } from "./notion.ts";
import { nextLocalHour, timeZone } from "./time.ts";

export const peoplePageSize = 100;
export const taskPageSize = 100;
/** 2,000 task rows at most per run. People who work on tasks tend to appear on recent ones. */
export const maximumTaskPages = 20;
/** A backstop on writes in one run, above any real roster: the projection lists at most 500 active members. */
export const maximumWritesPerRun = 600;
export const retryMs = 60 * 60_000;
export const rateLimitFallbackMs = 60_000;
/** While an Admin's Stop or a restore pauses outbound delivery, look again after this long. */
export const deliveryPausedRetryMs = 5 * 60_000;
const leaseMs = 60_000;
/** Steps per run under Core's cron fallback, which has no one-step-per-slice mode. Notion's per-invocation cap also applies. */
export const cronSlices = 3;
/** The most Notion requests one step makes: an update of a page Core has not seen in this invocation, with its page check. */
export const maximumRequestsPerStep = 2;
const maximumNames = 2000;

export type PeopleRow = { readonly pageId: string; readonly externalId: string; readonly name: string; readonly active: boolean; readonly accounts: readonly string[]; readonly suggested: readonly string[] };
export type Member = { readonly id: string; readonly externalId: string; readonly firstName: string; readonly lastName: string };
export type StoredRow = {
  readonly pageId: string; readonly externalId: string; readonly memberId: string | null; readonly name: string; readonly active: number;
  readonly accountCount: number; readonly notionUserId: string | null; readonly suggestedUserId: string | null; readonly matchState: string;
};

/** One People page as Chores needs it, read by the mapped property IDs. */
export function readPeopleRow(schema: Schema, page: Record<string, any>): PeopleRow {
  const map = schema.people.properties;
  return {
    pageId: canonicalId(page?.id) ?? String(page?.id ?? ""),
    externalId: plainText(pageProperty(page, map.memberId)?.rich_text).trim(),
    name: plainText(pageProperty(page, map.name)?.title).trim(),
    active: pageProperty(page, map.active)?.checkbox === true,
    accounts: peopleIds(pageProperty(page, map.account)),
    suggested: peopleIds(pageProperty(page, map.suggested)),
  };
}

export const fullName = (member: Pick<Member, "firstName" | "lastName">) => `${member.firstName} ${member.lastName}`.replace(/\s+/g, " ").trim();

/** Names compared loosely: accents, case, punctuation and spacing do not count. */
export const normaliseName = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const byExternalId = <T extends { readonly externalId: string }>(items: readonly T[]) => {
  const map = new Map<string, T[]>();
  for (const item of items) { const key = item.externalId.trim(); if (key) map.set(key, [...map.get(key) ?? [], item]); }
  return map;
};

/**
 * Which member each row belongs to and whether it is a match. Matched: the row's member ID is an active member's, no other
 * row carries it, Active is ticked and Notion account holds exactly one person. Two rows with one ID are both ambiguous.
 */
export function matchRows(rows: readonly Pick<StoredRow, "pageId" | "externalId" | "active" | "accountCount">[], roster: readonly Member[]) {
  const rowsById = byExternalId(rows);
  const members = new Map(roster.filter((member) => member.externalId.trim()).map((member) => [member.externalId.trim(), member]));
  return rows.map((row) => {
    const key = row.externalId.trim();
    const member = key ? members.get(key) : undefined;
    const state = !key ? "unmatched" : (rowsById.get(key)?.length ?? 0) > 1 ? "ambiguous" : member && row.active === 1 && row.accountCount === 1 ? "matched" : "unmatched";
    return { pageId: row.pageId, memberId: member?.id ?? null, matchState: state };
  });
}

export type PeopleAction =
  | { readonly kind: "create"; readonly memberId: string; readonly externalId: string; readonly name: string }
  | { readonly kind: "update"; readonly pageId: string; readonly name?: string; readonly active?: true }
  | { readonly kind: "untick"; readonly pageId: string };

/** Every write that would make People follow the active roster, in a stable order. Rows with no member ID are left alone. */
export function planPeopleWrites(rows: readonly Pick<StoredRow, "pageId" | "externalId" | "name" | "active">[], roster: readonly Member[]): PeopleAction[] {
  const rowsById = byExternalId(rows);
  const actions: PeopleAction[] = [];
  const seen = new Set<string>();
  for (const member of roster) {
    const key = member.externalId.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const found = rowsById.get(key) ?? [];
    const name = fullName(member);
    if (!found.length) { actions.push({ kind: "create", memberId: member.id, externalId: key, name }); continue; }
    // Two rows with one member ID need a person to choose; Chores changes neither.
    if (found.length > 1) continue;
    const row = found[0]!;
    const rename = row.name !== name;
    if (rename || row.active !== 1) actions.push({ kind: "update", pageId: row.pageId, ...(rename ? { name } : {}), ...(row.active !== 1 ? { active: true as const } : {}) });
  }
  for (const row of rows) {
    const key = row.externalId.trim();
    if (key && row.active === 1 && !seen.has(key)) actions.push({ kind: "untick", pageId: row.pageId });
  }
  return actions;
}

/** Add one task page's people to the names found so far. A name seen with two different accounts is marked "*". */
export function mergeTaskPeople(found: Record<string, string>, pages: readonly Record<string, any>[], propertyIds: readonly string[]): Record<string, string> {
  const next = { ...found };
  for (const page of pages) for (const id of propertyIds) {
    for (const user of (pageProperty(page, { id, type: "people" })?.people ?? []) as Record<string, any>[]) {
      if (!user?.id || user.type === "bot" || typeof user.name !== "string") continue;
      const name = normaliseName(user.name);
      const account = canonicalId(user.id);
      if (!name || !account) continue;
      if (next[name] === undefined) { if (Object.keys(next).length < maximumNames) next[name] = account; }
      else if (next[name] !== account) next[name] = "*";
    }
  }
  return next;
}

/**
 * Suggested account writes: a row with Active ticked, a member ID, an empty Notion account and a name that exactly one
 * People row has and exactly one found account has, where that account is nobody's Notion account yet. A row already
 * suggesting it is skipped, and so is one where a person suggested several.
 */
export function planSuggestions(rows: readonly Pick<StoredRow, "pageId" | "externalId" | "name" | "active" | "accountCount" | "notionUserId" | "suggestedUserId">[], found: Record<string, string>) {
  const nameCounts = new Map<string, number>();
  for (const row of rows) { const name = normaliseName(row.name); if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1); }
  const taken = new Set(rows.map((row) => row.notionUserId).filter(Boolean));
  const suggestions: { readonly pageId: string; readonly notionUserId: string }[] = [];
  for (const row of rows) {
    const name = normaliseName(row.name);
    const account = name ? found[name] : undefined;
    if (!account || account === "*" || nameCounts.get(name) !== 1 || row.active !== 1 || !row.externalId.trim() || row.accountCount !== 0) continue;
    if (taken.has(account) || row.suggestedUserId === account || row.suggestedUserId === "*") continue;
    suggestions.push({ pageId: row.pageId, notionUserId: account });
  }
  return suggestions;
}

type Counts = { created: number; updated: number; unticked: number; suggested: number };
export type Summary = Counts & { readonly dryRun: boolean; planned: Counts | null; writes: number };
type Sync = { readonly phase: string; readonly cursor: string | null; readonly pages: number; readonly generation: number; readonly dataJson: string | null; readonly summaryJson: string | null; readonly nextDue: number; readonly leaseUntil: number };
type JobContext = { readonly db: unknown; readonly services: NotionServices; readonly scheduler?: { readonly steps: boolean; readonly cursor?: string } };

const readSync = (db: Database) => db.prepare(`SELECT phase,cursor,pages,generation,data_json AS dataJson,summary_json AS summaryJson,next_due_ms AS nextDue,lease_until_ms AS leaseUntil
  FROM chores_sync WHERE installation_id=? AND stream='people'`).bind(installationId).first<Sync>();
const readSettings = (db: Database) => db.prepare("SELECT enabled,dry_run AS dryRun,people_sync_hour AS hour FROM chores_settings WHERE installation_id=?").bind(installationId).first<{ enabled: number; dryRun: number; hour: number }>();
const readRows = (db: Database) => db.prepare(`SELECT page_id AS pageId,external_id AS externalId,member_id AS memberId,name,active,account_count AS accountCount,notion_user_id AS notionUserId,
  suggested_user_id AS suggestedUserId,match_state AS matchState FROM chores_people WHERE installation_id=? ORDER BY page_id`).bind(installationId).all<StoredRow>().then((result) => result.results ?? []);
export const readRoster = (db: Database) => listActiveRosterIdentities(db as unknown as D1Database, installationId).then((result) => (result.results ?? []) as Member[]);

const setSync = (db: Database, fields: Partial<{ phase: string; cursor: string | null; pages: number; generation: number; dataJson: string | null; summary: Summary; nextDue: number; startedMs: number; finishedMs: number; lastError: string | null }>): Statement => {
  const columns: [string, unknown][] = [];
  if (fields.phase !== undefined) columns.push(["phase", fields.phase]);
  if (fields.cursor !== undefined) columns.push(["cursor", fields.cursor]);
  if (fields.pages !== undefined) columns.push(["pages", fields.pages]);
  if (fields.generation !== undefined) columns.push(["generation", fields.generation]);
  if (fields.dataJson !== undefined) columns.push(["data_json", fields.dataJson]);
  if (fields.summary !== undefined) columns.push(["summary_json", JSON.stringify(fields.summary)]);
  if (fields.nextDue !== undefined) columns.push(["next_due_ms", fields.nextDue]);
  if (fields.startedMs !== undefined) columns.push(["started_ms", fields.startedMs]);
  if (fields.finishedMs !== undefined) columns.push(["finished_ms", fields.finishedMs]);
  if (fields.lastError !== undefined) columns.push(["last_error", fields.lastError]);
  return db.prepare(`UPDATE chores_sync SET ${columns.map(([name]) => `${name}=?`).join(",")} WHERE installation_id=? AND stream='people'`).bind(...columns.map(([, value]) => value), installationId);
};

const upsertRow = (db: Database, row: PeopleRow, generation: number, now: number) => db.prepare(`INSERT INTO chores_people(installation_id,page_id,external_id,name,active,account_count,notion_user_id,suggested_user_id,match_state,scan_generation,seen_ms)
  VALUES (?,?,?,?,?,?,?,?,'unmatched',?,?) ON CONFLICT(installation_id,page_id) DO UPDATE SET external_id=excluded.external_id,name=excluded.name,active=excluded.active,
  account_count=excluded.account_count,notion_user_id=excluded.notion_user_id,suggested_user_id=excluded.suggested_user_id,scan_generation=excluded.scan_generation,seen_ms=excluded.seen_ms`)
  .bind(installationId, row.pageId, row.externalId.slice(0, 200), row.name.slice(0, 400), row.active ? 1 : 0, row.accounts.length, row.accounts.length === 1 ? row.accounts[0] : null,
    row.suggested.length === 1 ? row.suggested[0] : row.suggested.length > 1 ? "*" : null, generation, now);

const emptyCounts = (): Counts => ({ created: 0, updated: 0, unticked: 0, suggested: 0 });
const parseSummary = (sync: Sync, dryRun: boolean): Summary => {
  try { const summary = JSON.parse(sync.summaryJson ?? "") as Summary; if (summary && typeof summary.writes === "number") return summary; } catch { /* a fresh summary */ }
  return { ...emptyCounts(), dryRun, planned: null, writes: 0 };
};

type SliceContext = { readonly db: Database; readonly schema: Schema; readonly client: ChoresNotion; readonly now: number; readonly dryRun: boolean; readonly hour: number; readonly connection: ConnectionRow | null };

/** Finish the run: back to idle until the next daily hour, with the counts kept for the dashboard. */
async function finish(context: SliceContext, sync: Sync, summary: Summary): Promise<false> {
  const { db, now } = context;
  const next = nextLocalHour(now, await timeZone(db), context.hour);
  await db.batch([
    setSync(db, { phase: "idle", cursor: null, pages: 0, dataJson: null, summary, nextDue: next, finishedMs: now, lastError: null }),
    event(db, "people_sync", now, { detail: { dryRun: summary.dryRun, created: summary.created, updated: summary.updated, unticked: summary.unticked, suggested: summary.suggested, planned: summary.planned } }),
  ]);
  void sync;
  return false;
}

const afterWrites = (context: SliceContext, sync: Sync, summary: Summary) =>
  context.schema.task ? context.db.batch([setSync(context.db, { phase: "scan", cursor: null, pages: 0, dataJson: "{}", summary })]).then(() => true) : finish(context, sync, summary);

/** One step of the run, with at most one Notion request. Returns whether the run has more to do. */
async function slice(context: SliceContext, sync: Sync): Promise<boolean> {
  const { db, schema, client, now, dryRun } = context;
  let summary = parseSummary(sync, dryRun);
  if (sync.phase === "idle") {
    summary = { ...emptyCounts(), dryRun, planned: null, writes: 0 };
    sync = { ...sync, phase: "read", cursor: null, pages: 0, generation: sync.generation + 1 };
    await setSync(db, { phase: "read", cursor: null, pages: 0, generation: sync.generation, dataJson: null, summary, startedMs: now, nextDue: 0 }).run();
  }

  if (sync.phase === "read") {
    const page = await client.query("people", peoplePageSize, sync.cursor ?? undefined);
    const rows = page.results.map((result) => readPeopleRow(schema, result)).filter((row) => row.pageId);
    const upserts = rows.map((row) => upsertRow(db, row, sync.generation, now));
    if (page.next) { await db.batch([...upserts, setSync(db, { cursor: page.next, pages: sync.pages + 1 })]); return true; }
    await db.batch([...upserts, db.prepare("DELETE FROM chores_people WHERE installation_id=? AND scan_generation<?").bind(installationId, sync.generation)]);
    // Every row is read: decide which member each belongs to and whether it is a match.
    const [stored, roster] = await Promise.all([readRows(db), readRoster(db)]);
    const matches = matchRows(stored, roster);
    if (dryRun) {
      const actions = planPeopleWrites(stored, roster);
      summary = { ...summary, planned: { created: actions.filter((action) => action.kind === "create").length, updated: actions.filter((action) => action.kind === "update").length, unticked: actions.filter((action) => action.kind === "untick").length, suggested: 0 } };
    }
    await db.batch([
      ...matches.map((match) => db.prepare("UPDATE chores_people SET member_id=?,match_state=? WHERE installation_id=? AND page_id=?").bind(match.memberId, match.matchState, installationId, match.pageId)),
      setSync(db, { phase: "write", cursor: null, pages: 0, summary }),
    ]);
    return true;
  }

  if (sync.phase === "write") {
    if (dryRun) return afterWrites(context, sync, summary);
    const [stored, roster] = await Promise.all([readRows(db), readRoster(db)]);
    const action = summary.writes < maximumWritesPerRun ? planPeopleWrites(stored, roster)[0] : undefined;
    if (!action) return afterWrites(context, sync, summary);
    summary = { ...summary, writes: summary.writes + 1 };
    if (action.kind === "create") {
      const created = await client.createPeopleRow(schema, { name: action.name, memberId: action.externalId });
      summary.created++;
      await db.batch([
        db.prepare(`INSERT INTO chores_people(installation_id,page_id,external_id,member_id,name,active,account_count,match_state,scan_generation,seen_ms) VALUES (?,?,?,?,?,1,0,'unmatched',?,?)
          ON CONFLICT(installation_id,page_id) DO NOTHING`).bind(installationId, created.id, action.externalId, action.memberId, action.name.slice(0, 400), sync.generation, now),
        setSync(db, { summary }),
      ]);
    } else if (action.kind === "update") {
      await client.updatePeopleRow(schema, action.pageId, { ...(action.name !== undefined ? { name: action.name } : {}), ...(action.active ? { active: true } : {}) });
      summary.updated++;
      await db.batch([
        db.prepare(`UPDATE chores_people SET name=COALESCE(?,name),active=CASE WHEN ? THEN 1 ELSE active END,
          match_state=CASE WHEN match_state<>'ambiguous' AND account_count=1 AND member_id IS NOT NULL AND (? OR active=1) THEN 'matched' ELSE match_state END WHERE installation_id=? AND page_id=?`)
          .bind(action.name?.slice(0, 400) ?? null, action.active ? 1 : 0, action.active ? 1 : 0, installationId, action.pageId),
        setSync(db, { summary }),
      ]);
    } else {
      await client.updatePeopleRow(schema, action.pageId, { active: false });
      summary.unticked++;
      await db.batch([
        db.prepare("UPDATE chores_people SET active=0,match_state=CASE WHEN match_state='matched' THEN 'unmatched' ELSE match_state END WHERE installation_id=? AND page_id=?").bind(installationId, action.pageId),
        setSync(db, { summary }),
      ]);
    }
    return true;
  }

  if (sync.phase === "scan") {
    const task = schema.task;
    if (!task) return finish(context, sync, summary);
    const page = await client.query("task", taskPageSize, sync.cursor ?? undefined);
    let found: Record<string, string> = {};
    try { found = JSON.parse(sync.dataJson ?? "{}") as Record<string, string>; } catch { /* start again from nothing */ }
    found = mergeTaskPeople(found, page.results, task.peoplePropertyIds);
    const pages = sync.pages + 1;
    await setSync(db, page.next && pages < maximumTaskPages ? { cursor: page.next, pages, dataJson: JSON.stringify(found) } : { phase: "suggest", cursor: null, pages: 0, dataJson: JSON.stringify(found) }).run();
    return true;
  }

  // suggest
  let found: Record<string, string> = {};
  try { found = JSON.parse(sync.dataJson ?? "{}") as Record<string, string>; } catch { /* nothing to suggest */ }
  const suggestions = planSuggestions(await readRows(db), found);
  if (dryRun) return finish(context, sync, { ...summary, planned: { ...(summary.planned ?? emptyCounts()), suggested: suggestions.length } });
  const next = summary.writes < maximumWritesPerRun ? suggestions[0] : undefined;
  if (!next) return finish(context, sync, summary);
  await client.updatePeopleRow(schema, next.pageId, { suggested: [next.notionUserId] });
  summary = { ...summary, writes: summary.writes + 1, suggested: summary.suggested + 1 };
  await db.batch([
    db.prepare("UPDATE chores_people SET suggested_user_id=? WHERE installation_id=? AND page_id=?").bind(next.notionUserId, installationId, next.pageId),
    setSync(db, { summary }),
  ]);
  return true;
}

const ensureSync = (db: Database) => db.prepare("INSERT INTO chores_sync(installation_id,stream,phase,next_due_ms) VALUES (?,'people','idle',0) ON CONFLICT(installation_id,stream) DO NOTHING").bind(installationId);

/** Ask for a People sync as soon as the job next runs. A run already under way carries on. */
export async function requestPeopleSync(db: Database): Promise<boolean> {
  await ensureSync(db).run();
  const result = await db.prepare("UPDATE chores_sync SET next_due_ms=0 WHERE installation_id=? AND stream='people' AND phase='idle'").bind(installationId).run();
  return result.meta?.changes === 1;
}

/** Move the next daily run to the new hour. Only an idle sync is waiting for one. */
export async function reschedulePeopleSync(db: Database, hour: number, now: number) {
  const next = nextLocalHour(now, await timeZone(db), hour);
  await db.prepare("UPDATE chores_sync SET next_due_ms=? WHERE installation_id=? AND stream='people' AND phase='idle' AND next_due_ms>0").bind(next, installationId).run();
}

const readsNotion = (phase: string) => phase === "idle" || phase === "read" || phase === "scan";

/**
 * The chores.run job. In this release it runs only the People sync. It exits before any Notion call when Chores is switched
 * off, Core's connection or a required binding is missing, the databases have not been verified as bound now, or the sync is
 * not due. With `scheduler.steps` it does one step and answers `{ more, cursor }`; under the cron fallback it does up to
 * `cronSlices` steps while Core's per-invocation Notion cap leaves room for another. Returns counts and phases only, never names.
 */
export async function runChores(context: JobContext): Promise<unknown> {
  const db = context.db as Database;
  const now = Date.now();
  const [settings, connection, existing] = await Promise.all([readSettings(db), readConnection(db), readSync(db)]);
  if (!settings || settings.enabled !== 1) return { skipped: "disabled" };
  if (existing && existing.nextDue > now) return { skipped: "not due" };
  if (existing && existing.leaseUntil > now) return { skipped: "busy" };
  const schema = parseSchema(connection);
  const core = await readCore(context.services.notion);
  const problem = connectionProblem(connection, core);
  if (problem || !schema) return { skipped: problem ?? "not_verified" };
  // The row must exist before any failure, or the next poke would call Notion again straight away.
  if (!existing) await ensureSync(db).run();
  const claimed = await db.prepare("UPDATE chores_sync SET lease_until_ms=? WHERE installation_id=? AND stream='people' AND lease_until_ms<=? AND next_due_ms<=?").bind(now + leaseMs, installationId, now, now).run();
  if (claimed.meta?.changes !== 1) return { skipped: "busy" };
  const releaseStatement = () => db.prepare("UPDATE chores_sync SET lease_until_ms=0 WHERE installation_id=? AND stream='people'").bind(installationId);

  let sync = await readSync(db);
  const client = new ChoresNotion(context.services.notion);
  const sliceContext: SliceContext = { db, schema, client, now, dryRun: settings.dryRun === 1, hour: settings.hour, connection };
  const steps = context.scheduler?.steps === true;
  let phase = sync!.phase;
  try {
    for (let run = 0; run < (steps ? 1 : cronSlices) && client.remaining >= maximumRequestsPerStep; run++) {
      phase = sync!.phase;
      const more = await slice(sliceContext, sync!);
      if (readsNotion(phase)) await clearRefusal(db, connection);
      if (!more) { await releaseStatement().run(); return { done: true, dryRun: sliceContext.dryRun, notionRequests: client.spent }; }
      sync = await readSync(db);
      if (!sync) { await releaseStatement().run(); return { done: true, notionRequests: client.spent }; }
    }
  } catch (error) {
    if (!(error instanceof AppError)) { await releaseStatement().run(); throw error; }
    const keepPlace = (wait: number, extra: Record<string, unknown> = {}) => db.batch([setSync(db, { nextDue: now + wait, lastError: error.code }), releaseStatement()]).then(() => ({ failed: error.code, ...extra }));
    // Keep the place and wait as long as Notion asked, or until delivery resumes. Nothing was written by the failed step.
    if (error.code === "notion_429") {
      const asked = Number((error.details as { retryAfterMs?: number } | undefined)?.retryAfterMs);
      const wait = Number.isFinite(asked) && asked > 0 ? asked : rateLimitFallbackMs;
      return keepPlace(wait, { retryAfterMs: wait });
    }
    if (error.code === "delivery_paused") return keepPlace(deliveryPausedRetryMs);
    if (error.code === "notion_call_limit") { await releaseStatement().run(); return { more: true, cursor: phase }; }
    // Only codes reach the record. The next run starts from the top, so an uncertain create is found by reading, not repeated.
    await db.batch([setSync(db, { phase: "idle", cursor: null, pages: 0, dataJson: null, nextDue: now + retryMs, lastError: error.code }), releaseStatement()]);
    if (error.code === "notion_401" || readsNotion(phase) && (error.code === "notion_403" || error.code === "notion_404")) await recordRefusal(db, connection, error.code, now);
    return { failed: error.code, phase };
  }
  await releaseStatement().run();
  return { more: true, cursor: sync?.phase ?? phase };
}

/** People rows with exactly one Notion account, from the first page of rows that have one: the write check's choices. */
export async function readPeopleAccounts(client: ChoresNotion, schema: Schema) {
  const page = await client.query("people", peoplePageSize, undefined, { property: schema.people.properties.account.id, people: { is_not_empty: true } });
  return page.results.map((result) => readPeopleRow(schema, result)).filter((person) => person.accounts.length === 1)
    .map((person) => ({ name: person.name.slice(0, 200), notionUserId: person.accounts[0]!, memberId: person.externalId.slice(0, 200) }));
}

/** The People panel: counts of active members by match, and where the sync is. No names. */
export async function peopleStatus(db: Database) {
  const [roster, rows, sync, settings, connection] = await Promise.all([readRoster(db), readRows(db), readSync(db), readSettings(db),
    readConnection(db)]);
  const counts = { activeMembers: roster.length, matched: 0, unmatched: 0, ambiguous: 0, noMemberId: 0, suggested: 0 };
  const rowsById = byExternalId(rows);
  for (const member of roster) {
    const found = rowsById.get(member.externalId.trim()) ?? [];
    if (!member.externalId.trim()) counts.noMemberId++;
    else if (found.some((row) => row.matchState === "ambiguous")) counts.ambiguous++;
    else if (found.some((row) => row.matchState === "matched")) counts.matched++;
    else counts.unmatched++;
  }
  counts.suggested = rows.filter((row) => row.accountCount === 0 && row.suggestedUserId && row.suggestedUserId !== "*").length;
  let summary: Summary | null = null;
  try { summary = sync?.summaryJson ? JSON.parse(sync.summaryJson) as Summary : null; } catch { summary = null; }
  const state = await db.prepare("SELECT started_ms AS startedMs,finished_ms AS finishedMs,last_error AS lastError FROM chores_sync WHERE installation_id=? AND stream='people'").bind(installationId).first<{ startedMs: number | null; finishedMs: number | null; lastError: string | null }>();
  return {
    ...counts, enabled: settings?.enabled === 1, dryRun: settings?.dryRun !== 0, needsAccountViewUrl: connection?.viewUrl ?? null, peopleDatabaseId: parseSchema(connection)?.people.databaseId ?? null,
    sync: sync ? { phase: sync.phase, nextDueMs: sync.nextDue || null, startedMs: state?.startedMs ?? null, finishedMs: state?.finishedMs ?? null, lastError: state?.lastError ?? null, summary } : null,
  };
}
