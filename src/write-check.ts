// The Person-write check, the second setup step. It proves Core's Notion connection can set Person in the Chore log to a
// chosen account, which may be a guest's: through `services.notion` it creates one "TEST – Person write check – <date>" row
// with Person set, reads it back, confirms the account, then trashes that one page and nothing else. Setting Person notifies
// that person in Notion, so the Admin picks a test account that has agreed to it. A create Notion may have done without
// confirming is never sent again. At most four Notion requests: the account lookup, the create, the read and the trash
// (Core already knows the page it just created, so the trash needs no page check).
import { clearRefusal, connectionProblem, notionFailureResponse, parseSchema, readConnection, readCore, recordRefusal, type NotionServices } from "./connection.ts";
import { audit, event, installationId, refuse, type Database } from "./http.ts";
import { AppError, ChoresNotion, canonicalId, pageProperty, peopleIds, type Schema } from "./notion.ts";
import { localDate, timeZone } from "./time.ts";

export const writeCheckTitle = (date: string) => `TEST – Person write check – ${date}`;

type Outcome = { readonly state: "passed" | "failed" | "uncertain"; readonly code: string | null; readonly cleanup: "trashed" | "failed" | "none"; readonly pageUrl: string | null };

const record = (db: Database, outcome: Outcome, logSource: string, actor: string, now: number) => db.batch([
  db.prepare("UPDATE chores_notion SET write_check_ms=?,write_check_state=?,write_check_code=?,write_check_cleanup=?,write_check_page_url=?,write_check_log_source=?,updated_ms=? WHERE installation_id=?")
    .bind(outcome.state === "passed" ? now : null, outcome.state, outcome.code, outcome.cleanup, outcome.pageUrl, logSource, now, installationId),
  event(db, "write_check", now, { actor, detail: { state: outcome.state, code: outcome.code, cleanup: outcome.cleanup } }),
  audit(db, actor, `chores.write_check_${outcome.state}`, now),
]);

/** The test row's properties: Name, Date and Person only. No Status, so no option can be created by accident. */
export function writeCheckProperties(schema: Schema, date: string, notionUserId: string) {
  const map = schema.log.properties;
  return {
    [map.name.id]: { title: [{ type: "text", text: { content: writeCheckTitle(date) } }] },
    [map.date.id]: { date: { start: date } },
    [map.person.id]: { people: [{ object: "user", id: notionUserId }] },
  };
}

/** Failures of the account lookup that would stop the create too: Core can't send, or Notion refused the token or is limiting. */
const lookupStops = new Set(["notion_401", "notion_429", "notion_not_configured", "notion_disabled", "notion_unreadable", "notion_not_declared", "notion_call_limit"]);

/** Run the check. Returns a refusal, or undefined when a result was recorded and the caller should answer with the status. */
export async function personWriteCheck(db: Database, services: NotionServices, notionUserId: string, actor: string, now: number): Promise<Response | undefined> {
  const [row, core] = await Promise.all([readConnection(db), readCore(services.notion)]);
  const problem = connectionProblem(row, core);
  if (problem) return refuse(409, problem, problem === "notion_schema_changed" ? "The Notion databases no longer match. Verify them again first." : "Verify the Notion databases first.");
  const schema = parseSchema(row)!;
  const logSource = canonicalId(schema.log.dataSourceId) ?? schema.log.dataSourceId;
  const notion = new ChoresNotion(services.notion);
  const date = localDate(now, await timeZone(db));

  // A bot can't be a Person. A guest's account may not be readable as a user, so only a clear "bot" answer stops the check;
  // anything else carries on, and reading the row back is the real test.
  try { if ((await notion.user(notionUserId)).type === "bot") return refuse(400, "validation", "Choose a person's Notion account, not an integration."); }
  catch (error) { if (!(error instanceof AppError)) throw error; if (lookupStops.has(error.code)) return notionFailureResponse(error); }

  let created: { id: string; url?: string };
  try { created = await notion.createLogRow(schema, writeCheckProperties(schema, date, notionUserId)); }
  catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "delivery_paused" || error.code === "notion_429" || error.code === "notion_call_limit") return notionFailureResponse(error);
    await recordRefusal(db, row, error.code, now);
    // Notion may have made the row. Say so, and leave it to the Admin: an automatic retry could make a second one.
    await record(db, { state: error.uncertain ? "uncertain" : "failed", code: error.code, cleanup: "none", pageUrl: null }, logSource, actor, now);
    return undefined;
  }

  // From here the test row exists. Whatever happens while reading it back, it is moved to the trash and the outcome is
  // recorded; any failure that did not come from Notion is rethrown only after that.
  let confirmed = false;
  let code: string | null = null;
  let unexpected: unknown;
  let cleanup: Outcome["cleanup"] = "trashed";
  try {
    const page = await notion.logPage(created.id);
    const people = peopleIds(pageProperty(page, schema.log.properties.person));
    confirmed = people.length === 1 && people[0] === notionUserId;
    if (!confirmed) code = "person_not_saved";
  } catch (error) {
    if (!(error instanceof AppError)) unexpected = error;
    code = error instanceof AppError ? error.code : "read_failed";
  } finally {
    // Trash only the page this check created, whatever the read said.
    try { await notion.trashLogPage(created.id); }
    catch (error) { if (!(error instanceof AppError) && unexpected === undefined) unexpected = error; cleanup = "failed"; }
  }

  if (confirmed) await clearRefusal(db, row);
  await record(db, { state: confirmed ? "passed" : "failed", code, cleanup, pageUrl: cleanup === "failed" ? created.url ?? null : null }, logSource, actor, now);
  if (unexpected !== undefined) throw unexpected;
  return undefined;
}
