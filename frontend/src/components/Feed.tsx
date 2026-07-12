import { useEffect, useRef, useState } from "react";
import type { Msg, Node } from "../api";
import { SendBox } from "./SendBox";
import { Assistant } from "./Assistant";

const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NEAR_BOTTOM_PX = 60;
const isSelf = (m: Msg) => m.direction === "out" && m.is_ai !== 1;
const isAI = (m: Msg) => m.is_ai === 1;

// Honest delivery glyph from ack_state (NULL = nothing — never a fake state).
// Wording never says "delivered": a radio ACK is not a human receipt.
function deliveryGlyph(ack: string | null) {
  if (!ack) return null;
  if (ack.startsWith("failed")) {
    const reason = ack.includes(":") ? ack.split(":")[1] : "";
    return <span className="glyph g-fail" title={`failed${reason ? ": " + reason.toLowerCase() : ""}`}>✗</span>;
  }
  if (ack === "ack") return <span className="glyph g-ack" title="radio acknowledged — not confirmed read">✓✓</span>;
  if (ack === "relayed") return <span className="glyph g-rel" title="relayed by a neighbor — not delivery confirmation">↻</span>;
  if (ack === "radio-accepted") return <span className="glyph g-acc" title="radio accepted the packet">✓</span>;
  return null;
}

export function Feed({ items, nodes, stale, dmTarget, onDmTargetChange, showOffline }: {
  items: Msg[]; nodes: Node[]; stale?: boolean;
  dmTarget: string; onDmTargetChange: (id: string) => void; showOffline: boolean;
}) {
  const [tab, setTab] = useState<"feed" | "analyst">("feed");
  const [hideSelf, setHideSelf] = useState(false);
  const [hideAI, setHideAI] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef(true);

  const chrono = [...items].reverse(); // API is newest-first; feed reads top→bottom oldest→newest
  const shown = chrono.filter(m => !(hideSelf && isSelf(m)) && !(hideAI && isAI(m)));

  // Follow new messages to the bottom, but only when the user is already
  // near the bottom — someone scrolled up to read history shouldn't get yanked.
  useEffect(() => {
    if (tab !== "feed") return;
    const el = scrollRef.current;
    if (!el) return;
    if (firstRef.current) {
      if (items.length === 0) return;   // wait for the first real data before pinning to bottom
      el.scrollTop = el.scrollHeight;
      firstRef.current = false;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items, tab]);

  return (
    <section className="panel">
      <div className="panel-h">
        <span className="t">{tab === "feed" ? "Message feed" : "Mesh analyst"}</span>
        <span className="n">{tab === "feed" ? "all channels · newest last" : "local · read-only"}</span>
        {tab === "feed" && stale && <span className="tag stale">STALE</span>}
        <span className="right">
          <button className="tab" aria-pressed={tab === "feed"} onClick={() => setTab("feed")}>Feed</button>
          <button className="tab" aria-pressed={tab === "analyst"} onClick={() => setTab("analyst")}>Analyst</button>
          {tab === "feed" && <button className="tab" aria-pressed={!hideSelf} onClick={() => setHideSelf(v => !v)}>self</button>}
          {tab === "feed" && <button className="tab" aria-pressed={!hideAI} onClick={() => setHideAI(v => !v)}>AI</button>}
        </span>
      </div>
      {tab === "analyst" ? (
        <Assistant />
      ) : (
        <>
          <div className="feed" ref={scrollRef}>
            {shown.length === 0 && <div className="empty">No messages yet — the mesh is quiet.</div>}
            {shown.map(m => (
              <div key={m.id} className={`msg ${m.direction} ${m.is_ai ? "aiMsg" : ""}`}>
                <span className="ts">{hhmm(m.ts)}</span>
                <div className="body">
                  <span className="who">{m.direction === "out" ? (m.is_dm ? `RZRB → ${m.node_name}` : `RZRB → ch${m.channel}`) : m.node_name}</span>
                  <span className="tags">
                    {m.direction === "out" ? <span className="tag out">out</span> : null}
                    {m.is_dm ? <span className="tag dm">dm</span> : null}
                    {m.is_ai ? <span className="tag ai">ai</span> : null}
                    {m.direction === "out" ? deliveryGlyph(m.ack_state) : null}
                  </span>
                  <div className="txt">{m.text}</div>
                </div>
              </div>
            ))}
          </div>
          <SendBox nodes={nodes} value={dmTarget} onChange={onDmTargetChange} showOffline={showOffline} />
        </>
      )}
    </section>
  );
}
