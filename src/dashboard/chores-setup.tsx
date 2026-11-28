// The setup screen and its two cards: the Notion databases (step 1) and the Person-write check (step 2). The token lives in
// Core (Settings > Integrations > Notion); step 1 places Core's picker for each binding and verifies the chosen databases'
// layouts. The settings page reuses both cards.
import { useEffect, useId, useState } from "react";
import { NotionBindingField, type DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";
import { errorText, recordSetupStep, request, setupRoute } from "./chores-http.ts";
import { bindingGuide, connected, formatDateTime, integrationsLabel, integrationsPath, neededCapabilities, problemText, settingsPath, setupNotes, writeCheckPassed, writeCheckText, type PeopleAccount, type SetupStatus } from "./chores-model.ts";
import { LoadState, Notice, Pill, type NoticeValue } from "./chores-ui";

export function useSetupStatus() {
  const [status, setStatus] = useState<SetupStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() {
    setError(""); setLoading(true);
    try { setStatus(await request<SetupStatus>(`${setupRoute}/status`)); }
    catch (caught) { setError(errorText(caught, "Chores setup could not be loaded.")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  return { status, setStatus, error, loading, load };
}

/** Step 1: Core's connection, a picker per binding, and Verify. */
export function DatabasesCard({ status, onStatus, onVerified, heading = "step" }: { status: SetupStatus; onStatus: (status: SetupStatus) => void; onVerified?: () => Promise<void> | void; heading?: "step" | "card" }) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ notice: NoticeValue; key: number }>();
  const ok = connected(status);
  const problem = problemText(status);
  const canVerify = status.core.connected && Boolean(status.bindings.chores && status.bindings.log);

  async function reload() {
    try { onStatus(await request<SetupStatus>(`${setupRoute}/status`)); } catch (caught) { setError(errorText(caught, "Chores setup could not be loaded.")); }
  }
  async function verify() {
    if (busy) return;
    setBusy(true); setError(""); setResult(undefined);
    try {
      const next = await request<SetupStatus>(`${setupRoute}/verify`, "POST", {});
      await recordSetupStep("notion-connection");
      onStatus(next);
      setResult({ notice: { tone: "success", content: "Verified the Chores databases." }, key: Date.now() });
      await onVerified?.();
    } catch (caught) { setError(errorText(caught, "The databases could not be verified.")); }
    finally { setBusy(false); }
  }

  return <section className={heading === "step" ? "module-setup-card" : "ui-card ch-stack"} aria-labelledby={`${ids}title`}>
    {heading === "step"
      ? <div className="module-setup-card-heading"><div><p className="kicker">Step 1 - Required</p><h2 id={`${ids}title`}>Notion databases</h2></div><Pill label={ok ? "Verified" : "Not verified"} tone={ok ? "success" : "neutral"} /></div>
      : <div className="ch-card-heading"><h2 id={`${ids}title`}>Notion databases</h2><Pill label={ok ? "Verified" : "Needs attention"} tone={ok ? "success" : "error"} /></div>}
    {result && <Notice notice={result.notice} focusKey={result.key} />}
    {problem && <Notice notice={{ tone: ok ? "warning" : "error", content: problem }} />}
    <p className="field-help ch-notice">Chores uses Core's Notion connection. The token is saved in Core, never on this page: <a href={integrationsPath}>open {integrationsLabel}</a>. The connection needs these capabilities: {neededCapabilities.join(", ")}.</p>
    {status.core.connected && <div className="ch-stack">
      {bindingGuide.map((binding) => <div className="ch-binding" key={binding.id}>
        <NotionBindingField moduleId="chores" bindingId={binding.id} onChanged={(bound) => { if (bound !== Boolean(status.bindings[binding.id])) void reload(); }} />
        <details className="settings-disclosure">
          <summary>What the {binding.label} needs</summary>
          <ul className="ch-layout">{binding.layout.map(([field, kind]) => <li key={field}><strong>{field}</strong>: {kind}</li>)}</ul>
        </details>
      </div>)}
      <p className="field-help ch-notice">Other properties, such as a formula for the exit TV, are allowed. Chores never writes them.</p>
    </div>}
    {status.verifiedMs && <p className="field-help ch-notice">Last verified {formatDateTime(status.verifiedMs)}.</p>}
    {error && <Notice notice={{ tone: "error", content: error }} focusKey={error} />}
    <div className="module-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy || !canVerify} onClick={() => void verify()}>{busy ? "Verifying..." : ok ? "Verify again" : "Verify databases"}</button></div>
  </section>;
}

/** Step 2: choose a test account from Core's copy of People, then create, read back and trash one TEST row in the Chore log. */
export function WriteCheckCard({ status, onStatus, onPassed, heading = "step" }: { status: SetupStatus; onStatus: (status: SetupStatus) => void; onPassed?: () => Promise<void> | void; heading?: "step" | "card" }) {
  const ids = useId();
  const [accounts, setAccounts] = useState<readonly PeopleAccount[]>();
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = connected(status);
  const passed = writeCheckPassed(status);
  const text = writeCheckText(status.writeCheck);

  async function loadAccounts() {
    setBusy(true); setError("");
    try { const reply = await request<{ accounts: readonly PeopleAccount[] }>(`${setupRoute}/people-accounts`, "POST", {}); setAccounts(reply.accounts); setChosen(reply.accounts[0]?.notionUserId ?? ""); }
    catch (caught) { setError(errorText(caught, "People could not be read.")); }
    finally { setBusy(false); }
  }
  async function run() {
    if (busy || !chosen) return;
    setBusy(true); setError("");
    try {
      const next = await request<SetupStatus>(`${setupRoute}/person-write-check`, "POST", { notionUserId: chosen });
      onStatus(next);
      if (writeCheckPassed(next)) { await recordSetupStep("person-write-check"); await onPassed?.(); }
    } catch (caught) { setError(errorText(caught, "The check could not run.")); }
    finally { setBusy(false); }
  }

  return <section className={heading === "step" ? "module-setup-card" : "ui-card ch-stack"} aria-labelledby={`${ids}title`}>
    {heading === "step"
      ? <div className="module-setup-card-heading"><div><p className="kicker">Step 2 - Required</p><h2 id={`${ids}title`}>Person-write check</h2></div><Pill label={passed ? "Passed" : "Not run"} tone={passed ? "success" : "neutral"} /></div>
      : <div className="ch-card-heading"><h2 id={`${ids}title`}>Person-write check</h2><Pill label={passed ? "Passed" : "Not passed"} tone={passed ? "success" : "warning"} /></div>}
    <p className="field-help ch-notice">Chores adds one row named "TEST – Person write check" to the Chore log with Person set to the account you choose, reads it back, then moves only that row to Notion's trash. Notion notifies that person, so choose a test account that has agreed to it.</p>
    {text && <Notice notice={{ tone: status.writeCheck.state === "passed" ? "success" : "warning", content: <>{text}{status.writeCheck.pageUrl && <> <a href={status.writeCheck.pageUrl} target="_blank" rel="noreferrer">Open the test row</a></>}</> }} />}
    {!ready && <p className="field-help ch-notice">Verify the Notion databases first.</p>}
    {ready && !accounts && <div className="module-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => void loadAccounts()}>{busy ? "Reading People..." : "Choose a test account"}</button></div>}
    {ready && accounts && (accounts.length
      ? <div className="ch-field">
        <label htmlFor={`${ids}account`}>Test account</label>
        <select id={`${ids}account`} value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {accounts.map((account) => <option key={account.notionUserId} value={account.notionUserId}>{account.name || "No name"}{account.memberId ? ` (${account.memberId})` : ""}</option>)}
        </select>
        <span className="field-help">People rows with one Notion account filled in, as of the last People sync.</span>
        <div className="module-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy || !chosen} onClick={() => void run()}>{busy ? "Checking..." : passed ? "Run the check again" : "Run the check"}</button></div>
      </div>
      : <p className="field-help ch-notice">No People row has a Notion account yet. Fill in Notion account on the test person's row in the People database, run a People sync in <a href={integrationsPath}>{integrationsLabel}</a>, then try again.</p>)}
    {error && <Notice notice={{ tone: "error", content: error }} focusKey={error} />}
  </section>;
}

/** Core's setup screen. Core shows it until both steps pass, and an Admin can reopen it from the settings page. */
export function ChoresSetup({ module, navigate, onReady }: DashboardSetupProps) {
  const { status, setStatus, error, loading, load } = useSetupStatus();
  const [finished, setFinished] = useState(false);
  // Core would reopen setup if it were left before Core had drawn the module as ready, so go to the module's page only then.
  useEffect(() => { if (finished && module.setup.ready) navigate(settingsPath); }, [finished, module.setup.ready]);
  const done = status ? Number(connected(status)) + Number(writeCheckPassed(status)) : 0;
  return <section className="module-onboarding" aria-labelledby="chores-setup-title">
    <div className="page-intro"><p className="kicker">Chores module</p><h1 id="chores-setup-title">Set up Chores</h1><p>Choose the team's Notion databases for Core's Notion connection, verify them, then prove Chores can set Person in the Chore log. Chores stays off, and in dry-run, until you turn it on in its settings.</p></div>
    <LoadState loading={loading && !status} error={error} label="Chores setup" onRetry={() => void load()} />
    {status && <>
      <div className="module-setup-summary" role="status"><strong>{done === 2 ? "Setup complete" : "Setup required"}</strong><span>{done} of 2 steps done</span></div>
      <DatabasesCard status={status} onStatus={setStatus} />
      <WriteCheckCard status={status} onStatus={setStatus} onPassed={async () => { await onReady(); setFinished(true); }} />
      <section className="module-setup-card" aria-labelledby="chores-setup-notes"><h2 id="chores-setup-notes">Before you turn Chores on</h2><ul className="ch-notes">{setupNotes.map((note) => <li key={note}>{note}</li>)}</ul></section>
    </>}
  </section>;
}
