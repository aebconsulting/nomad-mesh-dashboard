import { useEffect, useRef, useState } from "react";
import { askAssistant } from "../api";

// A turn's answer is rendered as a plain-text React child (never
// dangerouslySetInnerHTML) — that plus the backend CSP is what makes an
// RF-authored node name that reaches the model unable to inject markup.
type Turn = { q: string; a?: string; err?: string; note?: string | null; truncated?: boolean };

export function Assistant() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setQ("");
    const i = turns.length;
    setTurns(t => [...t, { q: question }]);
    try {
      const r = await askAssistant(question);
      setTurns(t => t.map((x, k) => k === i ? { ...x, a: r.answer, note: r.window_note, truncated: r.truncated } : x));
    } catch (e) {
      setTurns(t => t.map((x, k) => k === i ? { ...x, err: (e as Error).message } : x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="analyst">
      <div className="analyst-banner">Local analysis · nothing here transmits to the mesh</div>
      <div className="analyst-log" ref={logRef}>
        {turns.length === 0 && (
          <div className="empty">Ask about signal, nodes, or whether a message went through — e.g. “which router is most likely to hear me?”</div>
        )}
        {turns.map((t, k) => (
          <div key={k} className="analyst-turn">
            <div className="a-q">{t.q}</div>
            {t.a && <div className="a-a">{t.a}{t.truncated && <span className="a-trunc"> …(answer cut off)</span>}</div>}
            {t.note && <div className="a-note">{t.note}</div>}
            {t.err && <div className="a-err">{t.err}</div>}
          </div>
        ))}
        {busy && <div className="a-thinking">analyzing…</div>}
      </div>
      <div className="analyst-input">
        <input
          className="msg-input" value={q} maxLength={500}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="Ask the mesh analyst…"
          aria-label="Ask the mesh analyst"
        />
        <button onClick={submit} disabled={busy}>{busy ? "…" : "ASK"}</button>
      </div>
    </div>
  );
}
