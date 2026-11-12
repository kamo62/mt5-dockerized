import { useEffect, useMemo, useState, type FormEvent } from "react";

export type StartupSettings = {
  mode: "restore" | "custom";
  expert: string;
  symbol: string;
  period: string;
  preset: string;
  profile: string;
};

type StartupInfo = {
  settings: StartupSettings;
  source: "control-room" | "environment";
  legacyStartup: boolean;
  preview: string;
  choices: { experts: string[]; presets: string[]; profiles: string[] };
  appliesOnNextLaunch: true;
};

const restoreSettings: StartupSettings = { mode: "restore", expert: "", symbol: "", period: "H1", preset: "", profile: "" };
const periods = ["M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30", "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1"];
const headers = { "X-Linux-MT5": "1", "content-type": "application/json" };

function generatedPreview(settings: StartupSettings): string {
  const sections: string[] = [];
  if (settings.profile) sections.push(`[Charts]\r\nProfileLast=${settings.profile}`);
  const startup: string[] = [];
  if (settings.expert) startup.push(`Expert=${settings.expert}`);
  if (settings.symbol) startup.push(`Symbol=${settings.symbol}`, `Period=${settings.period}`);
  if (settings.preset) startup.push(`ExpertParameters=${settings.preset}`);
  if (startup.length) sections.push(`[StartUp]\r\n${startup.join("\r\n")}`);
  return sections.join("\r\n\r\n");
}

async function startupRequest(body?: StartupSettings): Promise<StartupInfo> {
  const response = await fetch("/api/mt5/startup", {
    headers: body ? headers : { "X-Linux-MT5": "1" },
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json() as StartupInfo | { error?: string };
  if (!response.ok) {
    throw new Error("error" in data && data.error ? data.error : `Startup settings request failed (HTTP ${response.status}).`);
  }
  return data as StartupInfo;
}

export function StartupPanel({ offline, activeMode }: { offline: boolean; activeMode?: "restore" | "managed" }) {
  const [info, setInfo] = useState<StartupInfo>();
  const [draft, setDraft] = useState<StartupSettings>(restoreSettings);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const preview = useMemo(() => {
    const matchesSaved = info && Object.entries(draft).every(([key, value]) => info.settings[key as keyof StartupSettings] === value);
    return matchesSaved ? info.preview || generatedPreview(draft) : generatedPreview(draft);
  }, [draft, info]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const loaded = await startupRequest();
        if (current) {
          setInfo(loaded);
          setDraft(loaded.settings);
          setError(undefined);
        }
      } catch (loadError) {
        if (current) setError(loadError instanceof Error ? loadError.message : "Unable to load startup settings.");
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, []);

  function updateDraft(update: Partial<StartupSettings>) {
    setDraft((previous) => ({ ...previous, ...update }));
    setMessage(undefined);
    setError(undefined);
  }

  const validationError = draft.mode === "custom"
    ? draft.preset.trim() && !draft.expert.trim()
      ? "A preset requires an expert. A saved profile already contains its EA inputs."
      : draft.expert.trim() && !draft.symbol.trim()
        ? "Choose the broker’s exact chart symbol for this EA."
        : !draft.expert.trim() && !draft.symbol.trim() && !draft.profile.trim()
          ? "Choose an MT5 profile or a chart for custom startup."
          : undefined
    : undefined;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (offline || busy || validationError) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const settings = draft.mode === "restore" ? restoreSettings : draft;
    try {
      const saved = await startupRequest(settings);
      setInfo(saved);
      setDraft(saved.settings);
      setMessage("Saved for the next launch. The running terminal was not changed.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save startup settings.");
    } finally {
      setBusy(false);
    }
  }

  async function retryLoad() {
    setLoading(true);
    setError(undefined);
    try {
      const loaded = await startupRequest();
      setInfo(loaded);
      setDraft(loaded.settings);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load startup settings.");
    } finally {
      setLoading(false);
    }
  }

  return <form className="panel-section startup-panel" onSubmit={(event) => void save(event)}>
    <div className="startup-options" role="radiogroup" aria-label="Startup choice">
      <label className="startup-option">
        <input type="radio" name="startup-mode" value="restore" checked={draft.mode === "restore"} onChange={() => updateDraft({ mode: "restore" })} />
        <span><strong>Restore last session</strong><small>Use MT5’s saved account, charts and profile.</small></span>
      </label>
      <label className="startup-option">
        <input type="radio" name="startup-mode" value="custom" checked={draft.mode === "custom"} onChange={() => updateDraft({ mode: "custom" })} />
        <span><strong>Custom startup</strong><small>Choose one profile or chart setup for a future launch.</small></span>
      </label>
    </div>

    {draft.mode === "custom" && <div className="panel-section startup-fields">
      <label htmlFor="startup-profile">MT5 profile <small>Optional. A profile can contain multiple charts and EAs.</small></label>
      <input id="startup-profile" list="startup-profiles" value={draft.profile} onChange={(event) => updateDraft({ profile: event.target.value })} autoComplete="off" />
      <datalist id="startup-profiles">{info?.choices.profiles.map((profile) => <option key={profile} value={profile} />)}</datalist>

      <label htmlFor="startup-expert">Expert Advisor <small>Optional. Custom EA startup opens one chart.</small></label>
      <input id="startup-expert" list="startup-experts" value={draft.expert} onChange={(event) => updateDraft({ expert: event.target.value })} placeholder="MQL5/Experts/MyEA" autoComplete="off" />
      <datalist id="startup-experts">{info?.choices.experts.map((expert) => <option key={expert} value={expert} />)}</datalist>

      <div className="startup-chart-fields">
        <div>
          <label htmlFor="startup-symbol">Chart symbol <small>Use the exact symbol name from your broker.</small></label>
          <input id="startup-symbol" value={draft.symbol} onChange={(event) => updateDraft({ symbol: event.target.value })} placeholder="e.g. XAUUSD" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="startup-period">Timeframe</label>
          <select id="startup-period" value={draft.period} onChange={(event) => updateDraft({ period: event.target.value })}>{periods.map((period) => <option key={period} value={period}>{period}</option>)}</select>
        </div>
      </div>

      <label htmlFor="startup-preset">EA preset <small>Optional .set file. Presets are created outside Control Room.</small></label>
      <input id="startup-preset" list="startup-presets" value={draft.preset} onChange={(event) => updateDraft({ preset: event.target.value })} placeholder="MyEA.set" autoComplete="off" />
      <datalist id="startup-presets">{info?.choices.presets.map((preset) => <option key={preset} value={preset} />)}</datalist>

      <p className="upload-note">For multiple charts or EAs, select a saved MT5 profile. Startup never enables algorithmic trading, DLL or WebRequest permissions.</p>
      {validationError && <p className="note warning-text" role="status">{validationError}</p>}
      <details className="startup-details">
        <summary>Preview generated INI</summary>
        <pre>{preview || "No [StartUp] block is needed for the selected profile or chart."}</pre>
      </details>
    </div>}

    <p className="note">Enable MT5’s “Save password” to restore saved credentials. A prefix copied from another machine may need a fresh login.</p>
    {activeMode && <p className="upload-note">Running terminal mode: {activeMode === "managed" ? "Managed" : "Restore"}. A saved choice takes effect only after a later launch.</p>}
    {info?.legacyStartup && <p className="note warning-text" role="status">Legacy [StartUp] settings were detected. The server backs them up and removes them before the next cold launch; saving does not restart MT5.</p>}
    {info && <p className="upload-note">{info.source === "control-room" ? "Using the saved Control Room choice." : "Using the container’s default startup choice."}</p>}
    <details className="startup-details">
      <summary>Account restore details</summary>
      <p>MT5 keeps account credentials in its persisted Wine prefix when “Save password” is enabled. Passwords may not decrypt after moving that prefix to another machine, and a power loss can leave the last login unsaved.</p>
    </details>
    {loading && <p className="upload-note" role="status">Loading startup settings…</p>}
    {error && <p className="note error-text" role="alert">{error}</p>}
    {message && <p className="note" role="status">{message}</p>}
    <div className="button-row">
      <button className="primary-button" type="submit" disabled={loading || busy || offline || Boolean(validationError)}>{busy ? "Saving…" : "Save startup choice"}</button>
      {error && !info && <button type="button" disabled={loading} onClick={() => void retryLoad()}>Retry</button>}
    </div>
    <p className="upload-note">Saving only stores the next-launch choice. It never restarts MT5 or changes an attached EA.</p>
  </form>;
}
