// Small helpers shared by the route files. Every refusal has the same shape: { error, code, ...details }.

export const installationId = "primary";

export type Statement = { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results?: T[] }>; run(): Promise<{ meta?: { changes?: number } }> };
export type Database = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ results?: unknown[]; meta?: { changes?: number } }[]> };

export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A JSON response with a Retry-After header when asked, which Core's `respond` cannot set. */
export function json(body: unknown, status = 200, retryAfterSeconds?: number): Response {
  return Response.json(body, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }) } });
}

export const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json({ error, code, ...extra }, status);

/** An audit row in Core's log, as Part Requests writes one for each change to its connection. IDs only. */
export const audit = (db: Database, actor: string, action: string, now: number): Statement =>
  db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), installationId, actor, action, "chores_notion", installationId, new Date(now).toISOString());

/** A row in Chores' own event log. Details are IDs and counts only, never names or Notion text. */
export const event = (db: Database, kind: string, now: number, details: { actor?: string; detail?: Record<string, unknown> } = {}): Statement =>
  db.prepare("INSERT INTO chores_events(installation_id,id,kind,actor_user_id,detail_json,created_ms) VALUES (?,?,?,?,?,?)")
    .bind(installationId, crypto.randomUUID(), kind, details.actor ?? null, details.detail ? JSON.stringify(details.detail).slice(0, 2000) : null, now);
