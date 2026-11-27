# LancerLogin Chores plugin

A LancerLogin module plugin that assigns rotating shop chores to the members checked in at a meeting, records them in Notion and announces them in Discord.

**Status: in development (0.1.0, not released).** This first part sets up Notion and keeps the People database in step with the roster. Picking chores, the Chore log rows, Discord and the Today's chores page come next.

**Needs Core's Notion connection: LancerLogin Core 2.1.0-beta.12 / module SDK 1.8.0 or later.** Chores keeps no Notion token of its own. Core saves it in **Settings > Integrations > Notion** and sends every Notion request; Chores names one of its bindings, the databases an Admin chooses for it.

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 0.1.x | `>=2.1.0-beta.12 <3.0.0` | `^1.8.0` | 1 |

## Notion

Chores declares four bindings. Core refuses any database or operation not listed here.

| Binding | Database | Operations |
| --- | --- | --- |
| `chores` | Chores (required) | read: `retrieve`, `query` |
| `log` | Chore log (required) | `retrieve`, `query`, `pages.create`, `pages.retrieve`, `pages.update`, `pages.trash` |
| `people` | People (required) | `retrieve`, `query`, `pages.create`, `pages.update` |
| `task` | the team's task database (optional) | read: `retrieve`, `query` |

It also looks up one workspace user (`users: ["retrieve"]`) for the Person-write check. It never receives email addresses.

Core's Notion connection needs these of Notion's five capabilities: **Read content**, **Insert content**, **Update content** and **Read user information** (without email addresses). It does not use Insert comments.

Each database needs the properties below, by name and type. Other properties, such as a formula for the exit TV, are allowed and never written.

- **Chores:** Name (title), Area (select), Active (checkbox), People needed (number), Days (multi-select), Notes (rich text).
- **Chore log:** Name (title), Date (date), Chore (relation to Chores), Person (people), Status (select with the options Assigned, Replacement and Reassigned (not checked in); Chores never creates options), Done (checkbox, ticked by members, never written by Chores), Assigned by (rich text).
- **People:** Name (title), LancerLogin member ID (rich text), Notion account (people), Suggested account (people), Active (checkbox).
- **Task database:** any people property.

### People

The People database is the only link between a member and a Notion account. A member is matched when exactly one People row carries their member ID (the ID members type, the roster's external ID), Active is ticked and Notion account holds exactly one person. Chores is the only writer of People. Its daily sync (and **Sync people now**) adds a row for each active member without one, corrects names, ticks Active again for returning members and unticks it for members who leave. It never deletes a row. It writes only **Name**, **LancerLogin member ID**, **Active** and **Suggested account**; it **never writes Notion account**, which people fill in. Every Notion write is checked against an allow-list before it reaches Core. With a task database chosen, Chores suggests an account (Suggested account only) when a row's name matches exactly one person there and Notion account is empty; a suggestion is never a match.

## Setup

1. Save the Notion token in **Settings > Integrations > Notion** and share the four databases with that connection in Notion.
2. On the Chores setup screen, choose the database for each binding and select **Verify databases**.
3. Run the **Person-write check**: Chores adds one "TEST – Person write check – date" row to the Chore log with Person set to an account you choose from People, reads it back and moves only that row to Notion's trash. Notion notifies that person, so use a test account that has agreed to it.
4. In **Settings > Modules > Chores**, turn Chores on. It starts in dry-run, which reads Notion and counts what it would change but writes nothing.

Coaches: chores go to members checked in at a required meeting. If someone forgot to scan, check them in from the dashboard, which counts as present. An attendance correction does not count.

## Privacy

The roster includes minors. Notion receives only chore, date, person and status in the Chore log, and names and member IDs in People. No check-in times leave LancerLogin. Logs and job results carry counts and codes, never names.

## Limits

The `chores.run` job runs every five minutes. Each scheduler slice does one step: one query, one create or one update (two Notion requests when Core first checks a page belongs to People), within Core's slice budget (40 subrequests, 30 D1 queries, 12 provider requests) and its cap of 8 Notion requests per invocation. Under the cron fallback it does up to three steps per run while that cap leaves room.

## Development

```
npm test
node scripts/verify-with-core.mjs --core <path to a LancerLogin Core checkout> --mode acceptance
```

Tests use synthetic data only and never call Notion or Discord.
