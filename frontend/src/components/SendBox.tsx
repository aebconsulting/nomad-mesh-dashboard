import { useEffect, useRef, useState } from "react";
import { sendMessage, shortenUrl, isOffline } from "../api";
import type { Node, ReplyTarget } from "../api";

type Opt = { id: string; label: string; offline?: boolean };
const BROADCAST: Opt = { id: "", label: "Broadcast · CH0" };

export function SendBox({ nodes, value, onChange, showOffline, replyingTo, onClearReply }: {
  nodes: Node[]; value: string; onChange: (id: string) => void; showOffline: boolean;
  replyingTo: ReplyTarget | null; onClearReply: () => void;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");      // recipient search text (only shown while open)
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);             // highlighted option index for keyboard nav
  const [note, setNote] = useState<string | null>(null);
  const [shortening, setShortening] = useState(false);
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const comboRef = useRef<HTMLDivElement | null>(null);
  const bytes = new TextEncoder().encode(text).length;

  const labelFor = (id: string) => {
    if (!id) return BROADCAST.label;
    const n = nodes.find(x => x.node_id === id);
    return `DM: ${n?.short_name ?? id}`;
  };

  // Search across ALL heard nodes (regardless of offline status) — a searchable
  // box makes the full list reachable, so a node never disappears just because
  // it's offline or newer traffic pushed it past a top-N cap. With no query, the
  // default list respects the offline toggle like the node table does.
  const q = query.trim().toLowerCase();
  const pool = q ? nodes : (showOffline ? nodes : nodes.filter(n => !isOffline(n)));
  const matches = [...pool]
    .sort((a, b) => (b.last_heard ?? 0) - (a.last_heard ?? 0))
    .filter(n => !q
      || (n.short_name ?? "").toLowerCase().includes(q)
      || (n.long_name ?? "").toLowerCase().includes(q)
      || n.node_id.toLowerCase().includes(q))
    .slice(0, 50);
  const opts: Opt[] = [BROADCAST, ...matches.map(n => ({ id: n.node_id, label: `DM: ${n.short_name ?? n.node_id}`, offline: isOffline(n) }))];

  // Close the dropdown on any click outside the combo.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as HTMLElement)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (id: string) => { onChange(id); setQuery(""); setOpen(false); };

  const onComboKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(h + 1, opts.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open) { e.preventDefault(); choose(opts[Math.min(hi, opts.length - 1)]?.id ?? ""); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || bytes > 200) return;
    // Cancel any pending "sent" auto-clear before a new send so an old timer can't wipe a newer message.
    if (clearRef.current) { clearTimeout(clearRef.current); clearRef.current = null; }
    setNote("sending…");
    try {
      await sendMessage(text.trim(), replyingTo?.channel ?? 0, value || null, replyingTo?.meshId ?? null);
      setText(""); setNote("sent");
      onClearReply();
      clearRef.current = setTimeout(() => { setNote(null); clearRef.current = null; }, 3000);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "send failed");
    }
  };

  // A pasted URL can eat most of the 200-byte mesh budget — offer a one-tap
  // shorten (backend proxies is.gd/TinyURL; the CSP blocks calling them direct).
  const longUrl = text.match(/https?:\/\/\S{20,}/)?.[0] ?? null;
  const shorten = async () => {
    if (!longUrl || shortening) return;
    setShortening(true);
    setNote("shortening link…");
    try {
      const short = await shortenUrl(longUrl);
      setText(t => t.replace(longUrl, short));
      setNote("link shortened");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "shorten failed");
    } finally {
      setShortening(false);
    }
  };

  return (
    <form className="send" onSubmit={submit} autoComplete="off">
      <div className="send-tools">
        <a className="tool-link" href="https://www.meshpic.org/" target="_blank" rel="noopener noreferrer"
           title="Upload a photo on meshpic (opens in a new tab) — you get a short link that fits in a mesh message; images auto-delete after 24h; viewers need internet">📷 image link ↗</a>
        {longUrl && (
          <button type="button" className="tool-link" disabled={shortening} onClick={shorten}
                  title="Replace the long link in your message with a short one (via is.gd) so it fits the 200-byte budget">✂ shorten link</button>
        )}
      </div>
      {replyingTo && (
        <div className="reply-strip">
          <span className="reply-quote">↳ Replying to {replyingTo.name}: {replyingTo.text.slice(0, 60)}</span>
          <button type="button" className="reply-x" title="Cancel reply" onClick={onClearReply}>✕</button>
        </div>
      )}
      <div className="combo" ref={comboRef}>
        <input
          className="combo-input" type="text" role="combobox" aria-expanded={open}
          aria-label="Send to — search channel or node"
          placeholder="Search node or channel…"
          value={open ? query : labelFor(value)}
          onFocus={() => { setQuery(""); setHi(0); setOpen(true); }}
          onChange={e => { setQuery(e.target.value); setHi(0); setOpen(true); }}
          onKeyDown={onComboKey}
        />
        <span className="combo-caret" aria-hidden="true">▾</span>
        {open && (
          <ul className="combo-list" role="listbox">
            {opts.map((o, i) => (
              <li
                key={o.id || "broadcast"} role="option" aria-selected={o.id === value}
                className={`combo-opt ${i === hi ? "hi" : ""} ${o.id === value ? "sel" : ""} ${o.offline ? "offl-opt" : ""}`}
                onMouseDown={e => { e.preventDefault(); choose(o.id); }}
              >
                {o.label}
              </li>
            ))}
            {opts.length === 1 && q && <li className="combo-opt empty">no matching node</li>}
          </ul>
        )}
      </div>
      <div className="msg-wrap">
        <input
          className="msg-input" type="text" maxLength={200}
          placeholder="Message to the mesh…" aria-label="Message text"
          value={text} onChange={e => setText(e.target.value)}
        />
        <span className={`count ${bytes > 200 ? "over" : ""}`} aria-hidden="true">{bytes}/200</span>
      </div>
      <button type="submit" className="send-btn" disabled={!text.trim() || bytes > 200}>SEND</button>
      {note && <span className="send-note" role="status">{note}</span>}
    </form>
  );
}
