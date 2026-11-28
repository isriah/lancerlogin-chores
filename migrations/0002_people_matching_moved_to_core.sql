-- People matching moved to Core (Settings > Integrations > Notion, module SDK 1.10.0): Core keeps the People database in
-- step with the roster and Chores reads the matches through `listNotionPeopleAccounts`. Chores' own copy of People, its
-- sync state and its two People settings go. Nothing is carried over: Core reads People again from Notion.
DROP TABLE chores_people;
DELETE FROM chores_sync WHERE stream = 'people';
ALTER TABLE chores_settings DROP COLUMN people_sync_hour;
ALTER TABLE chores_notion DROP COLUMN needs_account_view_url;
