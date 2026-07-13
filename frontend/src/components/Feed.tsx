import { useEffect, useRef, useState } from "react";
import type { Msg, Node, ReplyTarget } from "../api";
import { SendBox } from "./SendBox";
import { Assistant } from "./Assistant";

const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NEAR_BOTTOM_PX = 60;
const isSelf = (m: Msg) => m.direction === "out" && m.is_ai !== 1;
const isAI = (m: Msg) => m.is_ai === 1;
const PICKER = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Outbound rows store the DM PEER's name in node_name (bridge fact) — the base's
// own short name is RZRB. Any surface that attributes authorship (quotes, chip
// tooltips, reply targets) must show RZRB for our own outbound rows, not the peer.
export const authorOf = (m: Msg) => m.direction === "out" ? "RZRB" : m.node_name;

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

export function Feed({ items, nodes, stale, dmTarget, onDmTargetChange, showOffline, replies, onReply, onReact, replyingTo, onClearReply }: {
  items: Msg[]; nodes: Node[]; stale?: boolean;
  dmTarget: string; onDmTargetChange: (id: string) => void; showOffline: boolean;
  replies: boolean; onReply: (m: Msg) => void; onReact: (m: Msg, emoji: string) => Promise<void>;
  replyingTo: ReplyTarget | null; onClearReply: () => void;
}) {
  const [tab, setTab] = useState<"feed" | "analyst">("feed");
  const [hideSelf, setHideSelf] = useState(false);
  const [hideAI, setHideAI] = useState(false);
  const [openPicker, setOpenPicker] = useState<number | null>(null);
  const [reactPending, setReactPending] = useState<number | null>(null);
  const [reactErr, setReactErr] = useState<{ id: number; msg: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);   // follow the newest message while pinned to the bottom

  const chrono = [...items].reverse(); // API is newest-first; feed reads top→bottom oldest→newest
  const byMeshId = new Map<number, Msg>();
  for (const m of chrono) if (m.mesh_id != null) byMeshId.set(m.mesh_id, m);
  const reactions = new Map<number, Msg[]>();
  for (const m of chrono) {
    if (m.is_reaction && m.reply_to_id != null) {
      const arr = reactions.get(m.reply_to_id) ?? [];
      arr.push(m); reactions.set(m.reply_to_id, arr);
    }
  }
  const shown = chrono.filter(m => !m.is_reaction && !(hideSelf && isSelf(m)) && !(hideAI && isAI(m)));

  // The user scrolling toggles "stick": at/near the bottom keeps following new
  // messages; scrolling up to read history stops the follow so they aren't yanked.
  const onFeedScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  // Keep the newest message in view — on new data AND when the feed tab becomes
  // visible again. Guarded to the visible feed: while the analyst tab is up the
  // feed is display:none (its scroll metrics all read 0), and measuring then
  // would strand scrollTop at 0 and silently kill auto-follow. The feed + send
  // box stay MOUNTED across tabs (hidden via CSS) so scroll and drafts survive.
  useEffect(() => {
    if (tab !== "feed") return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, tab]);

  return (
    <section className="panel">
      <div className="panel-h">
        <span className="t">{tab === "feed" ? "Message feed" : "Mesh analyst"}</span>
        <span className="n">{tab === "feed" ? "all channels · newest last" : "local · read-only"}</span>
        {stale && <span className="tag stale">STALE</span>}
        <span className="right">
          <button className="tab" aria-pressed={tab === "feed"} onClick={() => setTab("feed")}>Feed</button>
          <button className="tab" aria-pressed={tab === "analyst"} onClick={() => setTab("analyst")}>Analyst</button>
          {tab === "feed" && <button className="tab" aria-pressed={!hideSelf} onClick={() => setHideSelf(v => !v)}>self</button>}
          {tab === "feed" && <button className="tab" aria-pressed={!hideAI} onClick={() => setHideAI(v => !v)}>AI</button>}
        </span>
      </div>
      {/* Analyst, feed, and send box ALL stay mounted across tabs, toggled with
          `hidden`: the analyst keeps its conversation (and an in-flight answer
          still lands) while the feed keeps its scroll and any draft. State lives
          for the app session; a reload starts fresh. */}
      <Assistant hidden={tab !== "analyst"} />
      <div className="feed" ref={scrollRef} onScroll={onFeedScroll} hidden={tab !== "feed"}>
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
              {m.reply_to_id != null && (() => {
                const t = byMeshId.get(m.reply_to_id);
                return <div className="quote">↳ {t ? `${authorOf(t)}: ${t.text.slice(0, 60)}` : "replying to an earlier message"}</div>;
              })()}
              <div className="txt">{m.text}</div>
              {(reactions.get(m.mesh_id ?? -1) ?? []).length > 0 && (
                <div className="chips">
                  {Object.entries(
                    (reactions.get(m.mesh_id ?? -1) ?? []).reduce<Record<string, string[]>>((acc, r) => {
                      (acc[r.text] = acc[r.text] ?? []).push(authorOf(r)); return acc;
                    }, {})
                  ).map(([emoji, who]) => (
                    <span key={emoji} className="chip" title={who.join(", ")}>{emoji}{who.length > 1 ? ` ${who.length}` : ""}</span>
                  ))}
                </div>
              )}
              {replies && m.mesh_id != null && (
                <span className="row-actions">
                  <button className="act" title="Reply" onClick={() => onReply(m)}>↩</button>
                  <span className="react-wrap" onKeyDown={(ev) => { if (ev.key === "Escape") setOpenPicker(null); }}>
                    <button
                      className="act" title="React"
                      aria-haspopup="true" aria-expanded={openPicker === m.id}
                      onClick={() => setOpenPicker(p => p === m.id ? null : m.id)}
                    >😀+</button>
                    <span className={`picker${openPicker === m.id ? " open" : ""}`}>
                      {PICKER.map(e => (
                        <button
                          key={e} className="pick" disabled={reactPending !== null}
                          onClick={() => {
                            if (reactPending !== null) return;
                            setOpenPicker(null);
                            setReactPending(m.id);
                            onReact(m, e)
                              .catch(err => {
                                setReactErr({ id: m.id, msg: err instanceof Error ? err.message : "send failed" });
                                setTimeout(() => setReactErr(null), 4000);
                              })
                              .finally(() => setReactPending(null));
                          }}
                        >{e}</button>
                      ))}
                    </span>
                  </span>
                  {reactErr?.id === m.id && <span className="act-err">{reactErr.msg}</span>}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div hidden={tab !== "feed"}>
        <SendBox nodes={nodes} value={dmTarget} onChange={onDmTargetChange} showOffline={showOffline} replyingTo={replyingTo} onClearReply={onClearReply} />
      </div>
    </section>
  );
}
