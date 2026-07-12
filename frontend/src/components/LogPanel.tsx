import { useState } from "react";
import type { Msg } from "../api";

const t = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
const kind = (m: Msg) => m.direction === "out" ? (m.is_ai ? "ai" : "tx") : m.is_ai ? "ai" : "mesh";
const isSelf = (m: Msg) => m.direction === "out" && m.is_ai !== 1;
const isAI = (m: Msg) => m.is_ai === 1;

export function LogPanel({ items, stale }: { items: Msg[]; stale?: boolean }) {
  // Restrict-to filters (not hide filters): pressing a toggle narrows the log to
  // ONLY that category; with both pressed the log shows self OR AI rows and the
  // channel chatter drops out. Neither pressed = everything (the default).
  const [onlySelf, setOnlySelf] = useState(false);
  const [onlyAI, setOnlyAI] = useState(false);
  // API returns ts DESC, so items[0] is newest — render top→bottom as-is to keep
  // newest at the top (the feed is the opposite: newest at the bottom).
  const shown = items.filter(m =>
    (!onlySelf && !onlyAI) || (onlySelf && isSelf(m)) || (onlyAI && isAI(m))
  );
  return (
    <section className="panel">
      <div className="panel-h">
        <span className="t">Combined log</span><span className="n">mesh · ai · tx</span>{stale && <span className="tag stale">STALE</span>}
        <span className="right">
          <button className="tab" aria-pressed={onlySelf} onClick={() => setOnlySelf(v => !v)} title="Show only this device's transmissions">self</button>
          <button className="tab" aria-pressed={onlyAI} onClick={() => setOnlyAI(v => !v)} title="Show only AI messages">AI</button>
        </span>
      </div>
      <div className="log">
        {shown.length === 0 && <div className="empty">No matching log lines yet.</div>}
        {shown.map(m => (
          <div key={m.id} className="row">
            <span className="ts">{t(m.ts)}</span>
            <span className={`kind k-${kind(m)}`}>{kind(m)}</span>
            <span className="txt">{m.direction === "out" ? (m.is_dm ? `RZRB → ${m.node_name}` : `RZRB → ch${m.channel}`) : `${m.node_name} → ch${m.channel}`}: {m.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
