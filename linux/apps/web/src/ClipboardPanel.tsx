import { useEffect, useRef, useState } from "react";

type ClipboardInfo = { available: boolean; maxBytes: number; reason?: string };
const headers = { "x-linux-mt5": "1", "content-type": "application/json" };

async function clipboardRequest<T>(action?: "read" | "write", body?: unknown): Promise<T> {
  const response = await fetch(`/api/desktop/clipboard${action ? `/${action}` : ""}`, {
    headers, method: action ? "POST" : "GET", body: action ? JSON.stringify(body ?? {}) : undefined,
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Clipboard request failed (HTTP ${response.status}).`);
  return data as T;
}

export function ClipboardPanel({ offline }: { offline: boolean }) {
  const [info, setInfo] = useState<ClipboardInfo>();
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const bytes = new TextEncoder().encode(text).byteLength;
  const maxBytes = Math.min(info?.maxBytes ?? 65_536, 65_536);

  async function checkAvailability() {
    setInfo(await clipboardRequest<ClipboardInfo>());
  }
  useEffect(() => {
    // Capability detection only. Clipboard contents are read on explicit clicks.
    void checkAvailability().catch((error: Error) => setMessage(error.message));
  }, []);

  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(undefined);
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Clipboard request failed."); }
    finally { inFlight.current = false; setBusy(false); }
  }

  function selectText() { textarea.current?.focus(); textarea.current?.select(); }

  return <section className="panel-section clipboard-panel" aria-label="Text clipboard bridge">
    <p className="upload-note">Send text to the desktop clipboard, then paste it in MT5 with Ctrl+V or its Paste command. Sending does not type or press keys.</p>
    <p className="note">{info?.available ? "Clipboard utility installed. A successful send or get is still needed to verify desktop access." : info?.reason ?? "Desktop clipboard availability has not been confirmed."}</p>
    <label htmlFor="clipboard-text">Text to transfer</label>
    <textarea id="clipboard-text" ref={textarea} value={text} readOnly={busy} onChange={(event) => setText(event.target.value)} placeholder="Paste text here with Ctrl/Cmd+V…" spellCheck={false} aria-describedby="clipboard-limit" />
    <p id="clipboard-limit" className={bytes > maxBytes ? "error-text" : "upload-note"}>{bytes.toLocaleString()} / {maxBytes.toLocaleString()} UTF-8 bytes{bytes > maxBytes ? ". Reduce the text before sending." : " (64 KiB maximum)."}</p>
    <div className="button-row">
      <button type="button" className="primary-button" disabled={busy || offline || !info?.available || bytes > maxBytes} onClick={() => void perform(async () => {
        await clipboardRequest("write", { text });
        setMessage("Desktop clipboard updated. Click inside MT5 and paste with Ctrl+V or Paste.");
      })}>Send to desktop clipboard</button>
      <button type="button" disabled={busy || offline || !info?.available} onClick={() => void perform(async () => {
        const result = await clipboardRequest<{ text: string }>("read");
        setText(result.text);
        setMessage("Desktop text loaded below. Copy it to your device or select it and press Ctrl/Cmd+C.");
      })}>Get desktop text</button>
    </div>
    <div className="button-row">
      <button type="button" disabled={busy} onClick={() => void perform(async () => {
        try {
          if (!navigator.clipboard?.readText) throw new Error("unavailable");
          setText(await navigator.clipboard.readText());
          setMessage("Browser clipboard loaded. Send it when ready.");
        } catch { setMessage("Browser clipboard access is unavailable or denied. Click the text box and paste with Ctrl/Cmd+V instead."); textarea.current?.focus(); }
      })}>Paste from this device</button>
      <button type="button" disabled={busy} onClick={() => void perform(async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error("unavailable");
          await navigator.clipboard.writeText(text);
          setMessage("Text copied to this device’s clipboard.");
        } catch { selectText(); setMessage("Browser clipboard access is unavailable or denied. Text selected: press Ctrl/Cmd+C to copy."); }
      })}>Copy to this device</button>
      <button type="button" onClick={() => { selectText(); setMessage("Text selected. Press Ctrl/Cmd+C to copy."); }}>Select text</button>
      <button type="button" disabled={busy || offline} onClick={() => void perform(checkAvailability)}>Check availability</button>
    </div>
    <p className="upload-note">Only text is bridged. Your device clipboard is never read automatically. On an insecure LAN address, use ordinary paste in the box and Select text + Ctrl/Cmd+C.</p>
    {message && <p className="note" role="status">{message}</p>}
  </section>;
}
