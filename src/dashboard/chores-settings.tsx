// /settings/chores, Admin only: switching Chores on, dry-run, and both setup cards. People matching is Core's: this page
// only points to it.
// Schedule, crew rules and the Discord channel arrive with the picking engine in a later release.
import { useEffect, useId, useState } from "react";
import { adminRoute, errorText, request, setupRoute } from "./chores-http.ts";
import { integrationsLabel, integrationsPath } from "./chores-model.ts";
import { DatabasesCard, WriteCheckCard, useSetupStatus } from "./chores-setup";
import { LoadState, Notice, Pill } from "./chores-ui";

type Settings = { readonly enabled: boolean; readonly dryRun: boolean; readonly revision: number };

function SettingsCard({ settings, onSaved }: { settings: Settings; onSaved: (settings: Settings) => void }) {
  const ids = useId();
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  useEffect(() => setDraft(settings), [settings]);
  async function save() {
    setBusy(true); setNotice(undefined);
    try { const next = await request<Settings>(`${adminRoute}/settings`, "PUT", { revision: settings.revision, enabled: draft.enabled, dryRun: draft.dryRun }); onSaved(next); setNotice({ tone: "success", text: "Settings saved." }); }
    catch (caught) { setNotice({ tone: "error", text: errorText(caught, "Settings could not be saved.") }); }
    finally { setBusy(false); }
  }
  return <section className="ui-card ch-stack" aria-labelledby={`${ids}title`}>
    <div className="ch-card-heading"><h2 id={`${ids}title`}>Chores</h2><Pill label={settings.enabled ? settings.dryRun ? "On, dry-run" : "On" : "Off"} tone={settings.enabled ? settings.dryRun ? "warning" : "success" : "neutral"} /></div>
    <label className="ch-choice"><input type="checkbox" role="switch" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Chores is on</label>
    <label className="ch-choice"><input type="checkbox" checked={draft.dryRun} onChange={(event) => setDraft({ ...draft, dryRun: event.target.checked })} /> Dry-run: read Notion and count what would change, but write nothing</label>
    {notice && <Notice notice={{ tone: notice.tone, content: notice.text }} focusKey={notice} />}
    <div className="module-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : "Save settings"}</button></div>
  </section>;
}

/** People matching moved to Core, so every plugin shares one list. This card only says where it lives. */
function PeopleCard() {
  const ids = useId();
  return <section className="ui-card ch-stack" aria-labelledby={`${ids}title`}>
    <div className="ch-card-heading"><h2 id={`${ids}title`}>People</h2></div>
    <p className="field-help ch-notice">Chores assigns a chore to a member's Notion account. Which member is which account is kept by LancerLogin itself, from the Notion People database: <a href={integrationsPath}>open {integrationsLabel}</a> to choose that database, see who is matched and run a sync.</p>
  </section>;
}

export function ChoresSettings({ openSetup }: { openSetup: () => void }) {
  const { status, setStatus, error, loading, load } = useSetupStatus();
  const [settings, setSettings] = useState<Settings>();
  const [settingsError, setSettingsError] = useState("");
  async function loadSettings() { setSettingsError(""); try { setSettings(await request<Settings>(`${adminRoute}/settings`)); } catch (caught) { setSettingsError(errorText(caught, "Settings could not be loaded.")); } }
  useEffect(() => { void loadSettings(); }, []);
  return <section className="settings-page ch-stack" aria-labelledby="chores-settings-title">
    <div className="page-intro"><h1 id="chores-settings-title">Chores</h1><p>Chores assigns rotating shop chores to members checked in at required meetings. This release sets up Notion; assignments come in the next release.</p></div>
    <LoadState loading={!settings && !settingsError} error={settingsError} label="settings" onRetry={() => void loadSettings()} />
    {settings && <SettingsCard settings={settings} onSaved={setSettings} />}
    <LoadState loading={loading && !status} error={error} label="the Notion connection" onRetry={() => void load()} />
    {status && <>
      <PeopleCard />
      <DatabasesCard status={status} onStatus={setStatus} heading="card" />
      <WriteCheckCard status={status} onStatus={setStatus} heading="card" />
    </>}
    <div className="module-actions"><button className="settings-setup-link" type="button" onClick={openSetup}>Open setup</button></div>
  </section>;
}
