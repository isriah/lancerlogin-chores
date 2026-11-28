// The part of @lancerlogin/module-sdk/api that the plugin uses at run time. Core provides the real SDK in a composed build.
export function defineApiModule<T>(contribution: T): T { return contribution; }
/** Core's roster projection, word for word, including the columns the plugin must not pass on. */
export function listActiveRosterIdentities(db: any, installationId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT 500").bind(installationId).all();
}
/** Core's time zone projection, word for word. */
export async function installationTimeZone(db: any, installationId: string): Promise<string> {
  const row = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first();
  if (!row?.timeZone) throw new Error("The installation time zone is not configured");
  return row.timeZone;
}
/** Core's people matching (SDK 1.10.0). A test sets `peopleAccounts.rows`; undefined is "no verified People database". */
export const peopleAccounts: { rows: { memberId: string | null; externalId: string; name: string; notionUserId: string; matched: boolean }[] | undefined } = { rows: undefined };
export async function listNotionPeopleAccounts(_db: any, _installationId: string) { return peopleAccounts.rows; }
