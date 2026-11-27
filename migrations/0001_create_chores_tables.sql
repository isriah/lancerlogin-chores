-- Chores schema. Every row belongs to one installation and is removed with it. Instants are integer epoch milliseconds
-- (columns ending in _ms). Local dates are YYYY-MM-DD and local times HH:MM in the installation time zone.
-- Migrations are forward-only: never edit a released migration; add the next numbered file and list it in reviewed.json.
-- Only chores_settings and chores_label_rules travel in a backup. Everything else is rebuilt, re-entered or re-read.
-- The Notion token is never here: it lives in Core (Settings > Integrations > Notion).

-- One settings row per installation. Chores starts switched off and in dry-run, so nothing reaches Notion or Discord until
-- an Admin turns it on and then turns dry-run off.
CREATE TABLE chores_settings (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK(dry_run IN (0, 1)),
  assign_time TEXT NOT NULL DEFAULT '15:00' CHECK(assign_time GLOB '[0-2][0-9]:[0-5][0-9]' AND assign_time <= '23:59'),
  reassign_time TEXT NOT NULL DEFAULT '15:30' CHECK(reassign_time GLOB '[0-2][0-9]:[0-5][0-9]' AND reassign_time <= '23:59'),
  period TEXT NOT NULL DEFAULT 'week' CHECK(period IN ('week', 'day')),
  season_start TEXT CHECK(season_start IS NULL OR season_start GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  discord_channel_id TEXT CHECK(discord_channel_id IS NULL OR (length(discord_channel_id) BETWEEN 17 AND 20 AND discord_channel_id NOT GLOB '*[^0-9]*')),
  -- The local hour the daily People sync runs, off-peak.
  people_sync_hour INTEGER NOT NULL DEFAULT 2 CHECK(typeof(people_sync_hour) = 'integer' AND people_sync_hour BETWEEN 0 AND 23),
  -- Every saved change moves this forward by one, so a stale settings page cannot overwrite a newer save.
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer')
);

-- Roster labels that change who gets chores: 'excluded' members never get one, 'team' labels mix teams on shared chores.
CREATE TABLE chores_label_rules (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('excluded', 'team')),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer'),
  PRIMARY KEY(installation_id, label_id)
);

-- What Chores keeps about Core's Notion connection (SDK 1.8.0). Core holds the token and the databases an Admin chose for
-- each binding; Chores keeps only the checked layout of those databases (schema_json: per binding, the data source it was
-- checked against, property IDs and types, and the Chore log's Status options), when it was checked, what Notion last
-- refused, and the Person-write check. A layout counts only while every binding still points at the data source it names.
CREATE TABLE chores_notion (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  schema_json TEXT,
  verified_ms INTEGER CHECK(verified_ms IS NULL OR typeof(verified_ms) = 'integer'),
  schema_error TEXT,
  -- Notion refused a call (401, 403 or 404). Shown to Admins until a call works again or the databases are verified again.
  rejection_code TEXT,
  rejected_ms INTEGER CHECK(rejected_ms IS NULL OR typeof(rejected_ms) = 'integer'),
  -- The People database's "Needs a Notion account" view, linked from the People panel.
  needs_account_view_url TEXT CHECK(needs_account_view_url IS NULL OR length(needs_account_view_url) BETWEEN 1 AND 2000),
  -- The Person-write check: a test row in the Chore log with Person set, read back, then trashed. Cleared whenever the Chore
  -- log binding moves to another data source.
  write_check_ms INTEGER CHECK(write_check_ms IS NULL OR typeof(write_check_ms) = 'integer'),
  write_check_state TEXT CHECK(write_check_state IS NULL OR write_check_state IN ('passed', 'failed', 'uncertain')),
  write_check_code TEXT,
  write_check_cleanup TEXT CHECK(write_check_cleanup IS NULL OR write_check_cleanup IN ('trashed', 'failed', 'none')),
  write_check_page_url TEXT,
  write_check_log_source TEXT,
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer')
);

-- A cached copy of the Chores database. days_mask bit n is weekday n (0 is Sunday); 0 means every day.
CREATE TABLE chores_catalog (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) <= 200),
  area TEXT CHECK(area IS NULL OR length(area) <= 100),
  active INTEGER NOT NULL CHECK(active IN (0, 1)),
  people_needed INTEGER NOT NULL DEFAULT 1 CHECK(typeof(people_needed) = 'integer' AND people_needed BETWEEN 1 AND 20),
  days_mask INTEGER NOT NULL DEFAULT 0 CHECK(typeof(days_mask) = 'integer' AND days_mask BETWEEN 0 AND 127),
  page_url TEXT,
  seen_ms INTEGER NOT NULL CHECK(typeof(seen_ms) = 'integer'),
  PRIMARY KEY(installation_id, page_id)
);

-- One assignment or reassignment pass per local date, kept apart for dry-run. Presence is frozen as member IDs only.
CREATE TABLE chores_runs (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL CHECK(run_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  pass TEXT NOT NULL CHECK(pass IN ('assign', 'reassign')),
  dry_run INTEGER NOT NULL CHECK(dry_run IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'planned', 'delivering', 'done', 'skipped', 'failed')),
  skip_reason TEXT,
  trigger TEXT NOT NULL CHECK(trigger IN ('schedule', 'manual')),
  actor_user_id TEXT,
  rng_seed TEXT,
  presence_json TEXT,
  shortfall INTEGER NOT NULL DEFAULT 0 CHECK(typeof(shortfall) = 'integer' AND shortfall >= 0),
  discord_state TEXT NOT NULL DEFAULT 'none' CHECK(discord_state IN ('none', 'pending', 'sent', 'uncertain', 'failed')),
  discord_message_id TEXT,
  discord_nonce TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_until_ms) = 'integer'),
  next_attempt_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_attempt_ms) = 'integer'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts >= 0),
  last_error TEXT,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer'),
  PRIMARY KEY(installation_id, run_date, pass, dry_run)
);

-- Who holds each chore slot for a period: the Monday's date in week mode, the run date in day mode. The name is kept as it
-- was, so the record survives a member's removal.
CREATE TABLE chores_crew (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL CHECK(period_key GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  dry_run INTEGER NOT NULL CHECK(dry_run IN (0, 1)),
  chore_page_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(typeof(slot) = 'integer' AND slot >= 0),
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  member_name TEXT NOT NULL,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  PRIMARY KEY(installation_id, period_key, dry_run, chore_page_id, slot)
);

-- One row per slot holder per day. It is also the Notion delivery queue, the fairness ledger and the mirror of Done.
CREATE TABLE chores_assignments (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  run_date TEXT NOT NULL CHECK(run_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  dry_run INTEGER NOT NULL CHECK(dry_run IN (0, 1)),
  chore_page_id TEXT NOT NULL,
  chore_name TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(typeof(slot) = 'integer' AND slot >= 0),
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  member_name TEXT,
  status TEXT NOT NULL CHECK(status IN ('assigned', 'replacement', 'reassigned', 'unfilled')),
  notion_page_id TEXT,
  notion_state TEXT NOT NULL DEFAULT 'pending' CHECK(notion_state IN ('pending', 'created', 'uncertain', 'failed', 'skipped')),
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0, 1)),
  done_synced_ms INTEGER CHECK(done_synced_ms IS NULL OR typeof(done_synced_ms) = 'integer'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts >= 0),
  last_error TEXT,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer'),
  PRIMARY KEY(installation_id, id)
);
-- At most one live holder per slot per day.
CREATE UNIQUE INDEX chores_assignments_live_slot ON chores_assignments(installation_id, run_date, dry_run, chore_page_id, slot) WHERE status IN ('assigned', 'replacement', 'unfilled');
CREATE INDEX chores_assignments_member ON chores_assignments(installation_id, member_id, run_date);

-- A mirror of the Notion People database, one row per People page, read by the People sync. People is the only match
-- between a member and a Notion account: a member is matched when exactly one row carries their member ID (the ID members
-- type, the roster's external ID), that row has Active ticked and exactly one person in Notion account. member_id is the
-- internal ID the external ID resolved to, for joins; it is cleared when the member is removed.
CREATE TABLE chores_people (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK(length(external_id) <= 200),
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK(length(name) <= 400),
  active INTEGER NOT NULL CHECK(active IN (0, 1)),
  account_count INTEGER NOT NULL CHECK(typeof(account_count) = 'integer' AND account_count >= 0),
  notion_user_id TEXT,
  suggested_user_id TEXT,
  match_state TEXT NOT NULL CHECK(match_state IN ('matched', 'unmatched', 'ambiguous')),
  source TEXT NOT NULL DEFAULT 'people-db' CHECK(source IN ('people-db')),
  scan_generation INTEGER NOT NULL CHECK(typeof(scan_generation) = 'integer'),
  seen_ms INTEGER NOT NULL CHECK(typeof(seen_ms) = 'integer'),
  PRIMARY KEY(installation_id, page_id)
);
CREATE INDEX chores_people_external ON chores_people(installation_id, external_id);
CREATE INDEX chores_people_member ON chores_people(installation_id, member_id);

-- Where each background stream has got to, so it can make one Notion request per scheduler slice: the People sync, the
-- catalogue refresh and the Done sync. data_json holds a stream's working set, such as names found in the task database.
CREATE TABLE chores_sync (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK(stream IN ('people', 'catalog', 'done')),
  phase TEXT NOT NULL CHECK(phase IN ('idle', 'read', 'write', 'scan', 'suggest')),
  cursor TEXT,
  pages INTEGER NOT NULL DEFAULT 0 CHECK(typeof(pages) = 'integer' AND pages >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0),
  data_json TEXT,
  summary_json TEXT,
  watermark TEXT,
  next_due_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_due_ms) = 'integer'),
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_until_ms) = 'integer'),
  -- The runner holding the lease. Only that runner releases it.
  lease_token TEXT,
  -- Set just before a Notion write and cleared with the local record of it. Found set, the write may have happened without
  -- being recorded, so the stream reads Notion again instead of planning the same write twice.
  pending_write TEXT,
  started_ms INTEGER CHECK(started_ms IS NULL OR typeof(started_ms) = 'integer'),
  finished_ms INTEGER CHECK(finished_ms IS NULL OR typeof(finished_ms) = 'integer'),
  last_error TEXT,
  PRIMARY KEY(installation_id, stream)
);

-- What Chores did and who asked, by ID only: no names, no Notion text.
CREATE TABLE chores_events (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 60),
  actor_user_id TEXT,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  run_date TEXT,
  detail_json TEXT CHECK(detail_json IS NULL OR length(detail_json) <= 2000),
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  PRIMARY KEY(installation_id, id)
);
CREATE INDEX chores_events_recent ON chores_events(installation_id, created_ms);
