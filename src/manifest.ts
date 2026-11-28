// Module definition. It imports nothing, so the plugin's own unit tests can read it without a Core checkout.
const tables = [
  "chores_settings", "chores_label_rules", "chores_notion", "chores_catalog", "chores_runs", "chores_crew",
  "chores_assignments", "chores_sync", "chores_events",
] as const;

const manifest = {
  id: "chores",
  label: "Chores",
  description: "Assigns rotating shop chores to members checked in at a meeting, records them in Notion and announces them in Discord.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  // Notion through Core's one connection (SDK 1.8.0). Core refuses anything not declared here. The token is saved in
  // Settings > Integrations > Notion; an Admin chooses the database for each binding on the Chores setup page. Who is which
  // Notion account comes from Core's people matching (SDK 1.10.0), so Chores has no People database. No email addresses.
  notion: {
    users: ["retrieve"],
    bindings: [
      { id: "chores", label: "Chores database", reason: "The list of chores, how many people each needs and the days it runs. Read only.", required: true, kind: "data_source", operations: ["retrieve", "query"] },
      { id: "log", label: "Chore log database", reason: "One row per person per chore per day. Chores adds and updates rows, and removes only its own test row.", required: true, kind: "data_source", operations: ["retrieve", "query", "pages.create", "pages.retrieve", "pages.update", "pages.trash"] },
    ],
  },
  // The label says what holding it reveals: Chores reads who is checked in today, without Attendance's own capability.
  capabilities: [{ id: "chores.manage", label: "Manage Chores (sees who is checked in today)", operator: true }],
  // Today's chores (/chores) arrives with the picking engine in a later release.
  navigation: [],
  // Admin only: Core shows a module settings page to Operators only when its dashboard page is marked for them.
  settings: [{ label: "Chores", path: "/settings/chores" }],
  // Leave the version at 1: Core does not update an installed module's setup version, so raising it would lock setup.
  setup: {
    version: 1,
    steps: [
      { id: "notion-connection", label: "Verified Notion databases", required: true },
      { id: "person-write-check", label: "Person-write check in the Chore log", required: true },
    ],
  },
  // The chores.run job arrives with the picking engine.
  jobs: [],
  discordCommands: [],
  apiRoutes: [
    { path: "/admin/chores", match: "prefix", access: "workspace" },
    { path: "/module-setup/chores", match: "prefix", access: "setup" },
  ],
  tablePrefix: "chores_",
  persistence: { tables: [...tables], sharedFields: [], transientAuthority: [] },
  // Only settings and label rules travel in a backup. Core's Notion token and bindings travel in Core's part of an
  // entire-installation backup. After a restore an Admin verifies the databases and runs the Person-write check again, and
  // runs, crews, assignments and sync state start empty and are rebuilt from Notion.
  backup: {
    version: 1,
    tables: ["chores_settings", "chores_label_rules"],
    nonPortableTables: ["chores_notion", "chores_catalog", "chores_runs", "chores_crew", "chores_assignments", "chores_sync", "chores_events"],
  },
  lifecycle: {
    cleanupTargets: [
      "chores_events", "chores_sync", "chores_assignments", "chores_crew", "chores_runs", "chores_catalog",
      "chores_notion", "chores_label_rules", "chores_settings",
      "platform_module_setup_progress:chores", "platform_module_assignments:chores",
    ],
  },
  deletedData: ["Chores settings and label rules, the checked layouts of its Notion databases and the Person-write check result, the chores catalogue copy, runs, crews and assignments, the copy of the People database, sync state and the Chores event log. Nothing in Notion is deleted."],
} as const;

export default manifest;
