// What the Chores Admin pages show, as plain data and words, so it can be tested without a browser.

export const integrationsPath = "/settings/integrations";
export const integrationsLabel = "Settings > Integrations > Notion";
export const settingsPath = "/settings/chores";

export type BindingId = "chores" | "log" | "people" | "task";
export type CoreNotion = { readonly connected: boolean; readonly saved: boolean; readonly enabled: boolean; readonly readable: boolean; readonly pausedUntilMs: number | null };
export type WriteCheck = { readonly state: "passed" | "failed" | "uncertain" | null; readonly checkedMs: number | null; readonly code: string | null; readonly cleanup: "trashed" | "failed" | "none" | null; readonly pageUrl: string | null };
export type SetupStatus = {
  readonly core: CoreNotion;
  readonly bindings: Readonly<Record<BindingId, { readonly name: string | null; readonly databaseId: string } | null>>;
  readonly verifiedMs: number | null; readonly schemaError: string | null; readonly problem: string | null; readonly rejectedMs: number | null;
  readonly taskVerified: boolean; readonly needsAccountViewUrl: string | null; readonly writeCheck: WriteCheck;
};
export type PeopleAccount = { readonly name: string; readonly notionUserId: string; readonly memberId: string };

/** The bindings in the order an Admin chooses them, with what each database must hold. */
export const bindingGuide: readonly { readonly id: BindingId; readonly label: string; readonly layout: readonly (readonly [string, string])[] }[] = [
  { id: "chores", label: "Chores database", layout: [["Name", "title"], ["Area", "select"], ["Active", "checkbox"], ["People needed", "number"], ["Days", "multi-select"], ["Notes", "rich text"]] },
  { id: "log", label: "Chore log database", layout: [["Name", "title"], ["Date", "date"], ["Chore", "relation to the Chores database"], ["Person", "people"], ["Status", "select with Assigned, Replacement and Reassigned (not checked in)"], ["Done", "checkbox, ticked by members"], ["Assigned by", "rich text"]] },
  { id: "people", label: "People database", layout: [["Name", "title"], ["LancerLogin member ID", "rich text"], ["Notion account", "people, filled in by people, never by Chores"], ["Suggested account", "people"], ["Active", "checkbox"]] },
  { id: "task", label: "Task database (optional)", layout: [["Any people property", "read only, to suggest accounts"]] },
];

/** Notion's capabilities, in Notion's words, that Core's connection needs for Chores. */
export const neededCapabilities = ["Read content", "Insert content", "Update content", "Read user information without email addresses"] as const;

/** Coaches' part in presence, shown on the setup page. */
export const setupNotes: readonly string[] = [
  "Chores go to members checked in at a required meeting. Optional meetings get no chores.",
  "If a member forgot to scan, a coach checks them in from the dashboard: that counts as present. An attendance correction does not count, so use check-in, not a correction, for someone who is in the shop.",
  "Picking goes by the days each member has been assigned a chore, whether or not they ticked Done. Done is shown as credit and for follow-up.",
  "Notion receives only the chore, date, person and status in the Chore log, and names and member IDs in People. No check-in times leave LancerLogin.",
];

export const connected = (status: SetupStatus) => status.problem === null || status.problem === "notion_token_rejected" || status.problem === "notion_access_lost";
export const writeCheckPassed = (status: SetupStatus) => connected(status) && status.writeCheck.state === "passed";

/** What is wrong, in the order an Admin fixes it, and what to do. Undefined when nothing is. */
export function problemText(status: SetupStatus): string | undefined {
  const when = status.rejectedMs ? ` on ${new Date(status.rejectedMs).toLocaleString()}` : "";
  switch (status.problem) {
    case null: return undefined;
    case "notion_not_configured": return `Core's Notion connection is not set up. Save the Notion integration token in ${integrationsLabel}, then choose the Chores databases here.`;
    case "notion_unreadable": return `The Notion token saved in Core can't be read. This is expected after a restore onto another installation: save the token again in ${integrationsLabel}.`;
    case "notion_disabled": return `Core's Notion connection is turned off. Turn it on in ${integrationsLabel}.`;
    case "chores_unbound": return "Choose the Chores database below.";
    case "log_unbound": return "Choose the Chore log database below.";
    case "people_unbound": return "Choose the People database below.";
    case "not_verified": return "The chosen databases have not been checked for Chores yet. Verify them below.";
    case "notion_schema_changed": return `A Notion database no longer matches what Chores expects.${status.schemaError ? ` ${status.schemaError}` : ""} Fix it in Notion, then verify again.`;
    case "notion_token_rejected": return `Notion rejected the token saved in Core${when}. Save a new token in ${integrationsLabel}.`;
    case "notion_access_lost": return `Notion refused access to a Chores database${when}. Share the databases with Core's Notion connection, check its capabilities, then verify again.`;
    default: return "Chores can't use Notion yet. Verify the databases below.";
  }
}

/** The write check's last result in words. */
export function writeCheckText(check: WriteCheck): string | undefined {
  if (check.state === "passed") return `Passed${check.checkedMs ? ` on ${new Date(check.checkedMs).toLocaleString()}` : ""}. The test row was moved to Notion's trash.`;
  if (check.state === "uncertain") return "Notion did not confirm whether it created the test row. Look in the Chore log for a \"TEST – Person write check\" row and delete it, then run the check again.";
  if (check.state === "failed") {
    const cleanup = check.cleanup === "failed" ? " The test row could not be moved to the trash: delete it in Notion." : "";
    if (check.code === "person_not_saved") return `Notion created the test row but did not keep the Person. Check that the account can be added to the Chore log.${cleanup}`;
    if (check.code === "notion_403") return `Core's Notion connection could not add the row. Turn on Insert content and Update content for the connection in Notion.${cleanup}`;
    return `The check failed (${check.code ?? "unknown"}). Try again.${cleanup}`;
  }
  return undefined;
}

export const formatDateTime = (ms: number) => new Date(ms).toLocaleString();
