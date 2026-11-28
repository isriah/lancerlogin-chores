# LancerLogin Chores plugin

A LancerLogin module plugin that assigns rotating shop chores to the members checked in at a meeting, records them in Notion and announces them in Discord.

**Status: in development (0.1.0, not released).** This first part sets up Notion: the Chores and Chore log databases and the Person-write check. Picking chores, the Chore log rows, Discord and the Today's chores page come next.

**Needs Core's Notion connection and people matching: module SDK 1.10.0 or later.** Chores keeps no Notion token of its own. Core saves it in **Settings > Integrations > Notion** and sends every Notion request; Chores names one of its bindings, the databases an Admin chooses for it. Which member is which Notion account is Core's too: Core keeps the Notion People database in step with the roster, and Chores reads the matches from Core.

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 0.1.x | the first release with module SDK 1.10.0 (after 2.1.0-beta.13) | `^1.10.0` | 1 |

## Notion

Chores declares two bindings. Core refuses any database or operation not listed here.

| Binding | Database | Operations |
| --- | --- | --- |
| `chores` | Chores (required) | read: `retrieve`, `query` |
| `log` | Chore log (required) | `retrieve`, `query`, `pages.create`, `pages.retrieve`, `pages.update`, `pages.trash` |

It also looks up one workspace user (`users: ["retrieve"]`) for the Person-write check. It never receives email addresses.

Core's Notion connection needs these of Notion's five capabilities: **Read content**, **Insert content**, **Update content** and **Read user information** (without email addresses). It does not use Insert comments.

Each database needs the properties below, by name and type. Other properties, such as a formula for the exit TV, are allowed and never written.

- **Chores:** Name (title), Area (select), Active (checkbox), People needed (number), Days (multi-select), Notes (rich text).
- **Chore log:** Name (title), Date (date), Chore (relation to Chores), Person (people), Status (select with the options Assigned, Replacement and Reassigned (not checked in); Chores never creates options), Done (checkbox, ticked by members, never written by Chores), Assigned by (rich text).

### People

Chores has no People database of its own. Core's people matching (**Settings > Integrations > Notion**) keeps the Notion People database in step with the roster and tells plugins which member is which Notion account. Chores reads that through the module SDK's `listNotionPeopleAccounts` and never writes to People.

## Setup

1. Save the Notion token in **Settings > Integrations > Notion**, share the Chores and Chore log databases with that connection in Notion, and set up people matching there (the People database).
2. On the Chores setup screen, choose the database for each binding and select **Verify databases**.
3. Run the **Person-write check**: Chores adds one "TEST – Person write check – date" row to the Chore log with Person set to an account you choose from Core's copy of People, reads it back and moves only that row to Notion's trash. Notion notifies that person, so use a test account that has agreed to it.
4. In **Settings > Modules > Chores**, turn Chores on. It starts in dry-run, which reads Notion and counts what it would change but writes nothing.

Coaches: chores go to members checked in at a required meeting. If someone forgot to scan, check them in from the dashboard, which counts as present. An attendance correction does not count.

## Privacy

The roster includes minors. Chores sends Notion only chore, date, person and status in the Chore log. No check-in times leave LancerLogin. Logs and job results carry counts and codes, never names.

## Limits

This release has no background job. The `chores.run` job arrives with the picking engine.

## Development

```
npm test
node scripts/verify-with-core.mjs --core <path to a LancerLogin Core checkout> --mode acceptance
```

Tests use synthetic data only and never call Notion or Discord.
