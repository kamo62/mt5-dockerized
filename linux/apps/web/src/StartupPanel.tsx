import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

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
  if (settings.expert) startup.push(`Expert=${settings.expert.replace(/\//g, "\\")}`);
  if (settings.symbol) startup.push(`Symbol=${settings.symbol}`, `Period=${settings.period}`);
  if (settings.preset) startup.push(`ExpertParameters=${settings.preset.replace(/\//g, "\\")}`);
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
  const data = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : `Startup settings request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return data as StartupInfo;
}

export function StartupPanel({ offline, activeMode, active, refreshKey }: { offline: boolean; activeMode?: "restore" | "managed"; active: boolean; refreshKey: string }) {
  const [info, setInfo] = useState<StartupInfo>();
  const [draft, setDraft] = useState<StartupSettings>(restoreSettings);
  const [targetKind, setTargetKind] = useState<"profile" | "chart">("profile");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const savedSettings = useRef<StartupSettings | undefined>(undefined);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const environmentManaged = info?.source === "environment" && info.settings.mode === "custom";
  const preview = useMemo(() => {
    const matchesSaved = info && Object.entries(draft).every(([key, value]) => info.settings[key as keyof StartupSettings] === value);
    return matchesSaved ? info.preview || generatedPreview(draft) : generatedPreview(draft);
  }, [draft, info]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    void (async () => {
      try {
        const loaded = await startupRequest();
        if (current) {
          setInfo(loaded);
          const dirty = savedSettings.current && Object.entries(currentDraft.current).some(([key, value]) => savedSettings.current![key as keyof StartupSettings] !== value);
          if (!dirty) {
            setDraft(loaded.settings);
            setTargetKind(loaded.settings.profile || !loaded.settings.expert && !loaded.settings.symbol ? "profile" : "chart");
          }
          savedSettings.current = loaded.settings;
          setError(undefined);
        }
      } catch (loadError) {
        if (current) setError(loadError instanceof Error ? loadError.message : "Unable to load startup settings.");
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [active, refreshKey]);

  function updateDraft(update: Partial<StartupSettings>) {
    setDraft((previous) => ({ ...previous, ...update }));
    setMessage(undefined);
    setError(undefined);
  }

  const validationError = draft.mode === "custom"
    ? draft.profile.trim() && (draft.expert.trim() || draft.symbol.trim() || draft.preset.trim())
      ? "Choose either a saved profile or a custom chart. Clear the chart fields to use the profile."
      : draft.preset.trim() && !draft.expert.trim()
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
      savedSettings.current = saved.settings;
      setDraft(saved.settings);
      setTargetKind(saved.settings.profile || !saved.settings.expert && !saved.settings.symbol ? "profile" : "chart");
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
      savedSettings.current = loaded.settings;
      setDraft(loaded.settings);
      setTargetKind(loaded.settings.profile || !loaded.settings.expert && !loaded.settings.symbol ? "profile" : "chart");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load startup settings.");
    } finally {
      setLoading(false);
    }
  }

  return <form className="panel-section startup-panel" onSubmit={(event) => void save(event)}>
    {environmentManaged && <p className="note warning-text" role="status">Container-managed startup is still active until you save a choice here. Its environment settings may enable trading/WebRequest permissions and rewrite native startup. The preview below describes the Control Room policy after Save.</p>}
    <fieldset className="startup-editor-fieldset" disabled={loading || busy}>
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
      <label htmlFor="startup-target">Open on launch</label>
      <select id="startup-target" value={targetKind} onChange={(event) => {
        const next = event.target.value as "profile" | "chart";
        setTargetKind(next);
        updateDraft(next === "profile" ? { expert: "", symbol: "", preset: "" } : { profile: "" });
      }}><option value="profile">A saved MT5 profile (multiple charts / EAs)</option><option value="chart">One custom chart / EA</option></select>

      {targetKind === "profile" ? <div className="panel-section">
      <label htmlFor="startup-profile">Saved MT5 profile <small>A profile contains its own charts, EAs and inputs.</small></label>
      <input id="startup-profile" list="startup-profiles" value={draft.profile} onChange={(event) => updateDraft({ profile: event.target.value })} autoComplete="off" />
      <datalist id="startup-profiles">{info?.choices.profiles.map((profile) => <option key={profile} value={profile} />)}</datalist>
      </div> : <div className="panel-section">
      <label htmlFor="startup-expert">Expert Advisor <small>Optional. Custom EA startup opens one chart.</small></label>
      <input id="startup-expert" list="startup-experts" value={draft.expert} onChange={(event) => updateDraft({ expert: event.target.value })} placeholder="MyEA or MyFolder/MyEA" autoComplete="off" />
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
      </div>}

      <p className="note warning-text">An EA may trade using permissions already enabled on this account. Saved Control Room choices never enable trading, DLL or WebRequest permissions.</p>
      {validationError && <p className="note warning-text" role="status">{validationError}</p>}
      <details className="startup-details">
        <summary>Preview Control Room INI</summary>
        <pre>{preview || "No [StartUp] block is needed for the selected profile or chart."}</pre>
      </details>
    </div>}
    </fieldset>

    {loading && <p className="upload-note" role="status">Loading startup settings…</p>}
    {error && <p className="note error-text" role="alert">{error}</p>}
    {message && <p className="note" role="status">{message}</p>}
    <div className="button-row">
      <button className="primary-button" type="submit" disabled={loading || busy || offline || Boolean(validationError)}>{busy ? "Saving…" : "Save for next launch"}</button>
      {error && !info && <button type="button" disabled={loading} onClick={() => void retryLoad()}>Retry</button>}
    </div>
    <p className="upload-note">Save does not restart MT5 or change an attached EA. The choice applies on the next launch, including auto-launch on container boot.</p>
    {info && <p className="upload-note">Next launch: {info.source === "control-room" ? "saved Control Room choice" : "container default"}.{activeMode && <> Current session: {activeMode === "managed" ? "Custom startup" : "Restore"}.</>}</p>}
    {info?.legacyStartup && <p className="note warning-text" role="status">Legacy [StartUp] detected. {environmentManaged ? "Save a Control Room choice to back it up and remove it before a later cold launch." : "It will be backed up and removed before the next cold launch."}</p>}
    <details className="startup-details">
      <summary>Session and account details</summary>
      <p>Custom startup applies on each launch. Use Restore last session to follow manual chart changes. MT5 keeps account credentials in its persisted Wine prefix when “Save password” is enabled. Passwords may not decrypt after moving that prefix to another machine, and a power loss can leave the last login unsaved.</p>
    </details>
  </form>;
}
