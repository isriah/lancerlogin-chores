// /settings/chores, Admin only: switching Chores on, dry-run, the People sync and its view link, and both setup cards.
// Schedule, crew rules and the Discord channel arrive with the picking engine in a later release.
import { useEffect, useId, useState } from "react";
import { adminRoute, errorText, request, setupRoute } from "./chores-http.ts";
import { formatDateTime, type SetupStatus } from "./chores-model.ts";
import { DatabasesCard, WriteCheckCard, useSetupStatus } from "./chores-setup";
import { LoadState, Notice, Pill } from "./chores-ui";

type Settings = { readonly enabled: boolean; readonly dryRun: boolean; readonly peopleSyncHour: number; readonly revision: number };
type PeoplePanel = {
  readonly activeMembers: number; readonly matched: number; readonly unmatched: number; readonly ambiguous: number; readonly noMemberId: number; readonly suggested: number;
  readonly needsAccountViewUrl: string | null;
  readonly sync: { readonly phase: string; readonly nextDueMs: number | null; readonly finishedMs: number | null; readonly lastError: string | null; readonly summary: { readonly dryRun: boolean; readonly created: number; readonly updated: number; readonly unticked: number; readonly suggested: number; readonly planned: { readonly created: number; readonly updated: number; readonly unticked: number } | null } | null } | null;
};

function SettingsCard({ settings, onSaved }: { settings: Settings; onSaved: (settings: Settings) => void }) {
  const ids = useId();
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  useEffect(() => setDraft(settings), [settings]);
  async function save() {
    setBusy(true); setNotice(undefined);
    try { const next = await request<Settings>(`${adminRoute}/settings`, "PUT", { revision: settings.revision, enabled: draft.enabled, dryRun: draft.dryRun, peopleSyncHour: draft.peopleSyncHour }); onSaved(next); setNotice({ tone: "success", text: "Settings saved." }); }
    catch (caught) { setNotice({ tone: "error", text: errorText(caught, "Settings could not be saved.") }); }
    finally { setBusy(false); }
  }
  return <section className="ui-card ch-stack" aria-labelledby={`${ids}title`}>
    <div className="ch-card-heading"><h2 id={`${ids}title`}>Chores</h2><Pill label={settings.enabled ? settings.dryRun ? "On, dry-run" : "On" : "Off"} tone={settings.enabled ? settings.dryRun ? "warning" : "success" : "neutral"} /></div>
    <label className="ch-choice"><input type="checkbox" role="switch" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Chores is on</label>
    <label className="ch-choice"><input type="checkbox" checked={draft.dryRun} onChange={(event) => setDraft({ ...draft, dryRun: event.target.checked })} /> Dry-run: read Notion and count what would change, but write nothing</label>
    <div className="ch-field">
      <label htmlFor={`${ids}hour`}>People sync hour</label>
      <select id={`${ids}hour`} value={draft.peopleSyncHour} onChange={(event) => setDraft({ ...draft, peopleSyncHour: Number(event.target.value) })}>
        {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}
      </select>
      <span className="field-help">The People sync runs once a day at this local hour.</span>
    </div>
    {notice && <Notice notice={{ tone: notice.tone, content: notice.text }} focusKey={notice} />}
    <div className="module-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : "Save settings"}</button></div>
  </section>;
}

function PeopleCard({ setup, onSetup }: { setup: SetupStatus; onSetup: (status: SetupStatus) => void }) {
  const ids = useId();
  const [panel, setPanel] = useState<PeoplePanel>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(setup.needsAccountViewUrl ?? "");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  async function load() { setError(""); try { setPanel(await request<PeoplePanel>(`${adminRoute}/people`)); } catch (caught) { setError(errorText(caught, "People could not be loaded.")); } }
  useEffect(() => { void load(); }, []);
  async function syncNow() {
    setBusy(true); setNotice(undefined);
    try { setPanel(await request<PeoplePanel>(`${adminRoute}/people/sync`, "POST", {})); setNotice({ tone: "success", text: "The People sync will run in a moment." }); }
    catch (caught) { setNotice({ tone: "error", text: errorText(caught, "The sync could not be started.") }); }
    finally { setBusy(false); }
  }
  async function saveView() {
    setBusy(true); setNotice(undefined);
    try { onSetup(await request<SetupStatus>(`${setupRoute}/view`, "PUT", { url: view.trim() || null })); setNotice({ tone: "success", text: "View link saved." }); }
    catch (caught) { setNotice({ tone: "error", text: errorText(caught, "The link could not be saved.") }); }
    finally { setBusy(false); }
  }
  const summary = panel?.sync?.summary;
  return <section className="ui-card ch-stack" aria-labelledby={`${ids}title`}>
    <div className="ch-card-heading"><h2 id={`${ids}title`}>People</h2></div>
    <p className="field-help ch-notice">Chores keeps the Notion People database in step with the active roster: it adds a row for each member (Name, LancerLogin member ID, Active), corrects names and unticks Active for members who leave. It never deletes a row and never fills in Notion account; people do that.</p>
    <LoadState loading={!panel && !error} error={error} label="People" onRetry={() => void load()} />
    {panel && <dl className="ch-summary">
      <div><dt>Active members</dt><dd>{panel.activeMembers}</dd></div>
      <div><dt>Matched to a Notion account</dt><dd>{panel.matched}</dd></div>
      <div><dt>No Notion account yet</dt><dd>{panel.unmatched}</dd></div>
      <div><dt>Two People rows for one ID</dt><dd>{panel.ambiguous}</dd></div>
      <div><dt>No member ID in the roster</dt><dd>{panel.noMemberId}</dd></div>
      <div><dt>Suggested accounts to confirm</dt><dd>{panel.suggested}</dd></div>
    </dl>}
    {panel?.sync?.finishedMs && <p className="field-help ch-notice">Last sync {formatDateTime(panel.sync.finishedMs)}{summary ? summary.dryRun && summary.planned ? `, dry-run: would add ${summary.planned.created}, update ${summary.planned.updated} and untick ${summary.planned.unticked}.` : `: added ${summary.created}, updated ${summary.updated}, unticked ${summary.unticked}, suggested ${summary.suggested}.` : "."}</p>}
    {panel?.sync?.lastError && <Notice notice={{ tone: "warning", content: `The last sync stopped (${panel.sync.lastError}). It tries again later.` }} />}
    {panel?.needsAccountViewUrl && <p className="ch-notice"><a href={panel.needsAccountViewUrl} target="_blank" rel="noreferrer">Open "Needs a Notion account" in Notion</a></p>}
    <div className="ch-field">
      <label htmlFor={`${ids}view`}>"Needs a Notion account" view link</label>
      <input id={`${ids}view`} type="url" value={view} onChange={(event) => setView(event.target.value)} placeholder="https://www.notion.so/..." />
    </div>
    {notice && <Notice notice={{ tone: notice.tone, content: notice.text }} focusKey={notice} />}
    <div className="module-actions">
      <button className="ui-button" type="button" disabled={busy} onClick={() => void saveView()}>Save link</button>
      <button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void syncNow()}>Sync people now</button>
    </div>
  </section>;
}

export function ChoresSettings({ openSetup }: { openSetup: () => void }) {
  const { status, setStatus, error, loading, load } = useSetupStatus();
  const [settings, setSettings] = useState<Settings>();
  const [settingsError, setSettingsError] = useState("");
  async function loadSettings() { setSettingsError(""); try { setSettings(await request<Settings>(`${adminRoute}/settings`)); } catch (caught) { setSettingsError(errorText(caught, "Settings could not be loaded.")); } }
  useEffect(() => { void loadSettings(); }, []);
  return <section className="settings-page ch-stack" aria-labelledby="chores-settings-title">
    <div className="page-intro"><h1 id="chores-settings-title">Chores</h1><p>Chores assigns rotating shop chores to members checked in at required meetings. This release keeps the People database in step; assignments come in the next release.</p></div>
    <LoadState loading={!settings && !settingsError} error={settingsError} label="settings" onRetry={() => void loadSettings()} />
    {settings && <SettingsCard settings={settings} onSaved={setSettings} />}
    <LoadState loading={loading && !status} error={error} label="the Notion connection" onRetry={() => void load()} />
    {status && <>
      <PeopleCard setup={status} onSetup={setStatus} />
      <DatabasesCard status={status} onStatus={setStatus} heading="card" />
      <WriteCheckCard status={status} onStatus={setStatus} heading="card" />
    </>}
    <div className="module-actions"><button className="settings-setup-link" type="button" onClick={openSetup}>Open setup</button></div>
  </section>;
}
