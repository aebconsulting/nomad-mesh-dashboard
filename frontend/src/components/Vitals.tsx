import type { Node, Status, Stats as StatsData } from "../api";
import { isOffline } from "../api";

// The signature mesh-vitals strip: glanceable radio-console readouts.
// All values derive client-side from data the app already polls; status
// values are words (OK/DOWN), never color alone (dataviz rule).
export function Vitals({ status, stats, nodes }: { status: Status | null; stats: StatsData | null; nodes: Node[] }) {
  const online = nodes.filter(n => !isOffline(n));
  const direct = online.filter(n => n.hops === 0);
  // Weakest direct RF link: min SNR across online hops==0 nodes that report one.
  const withSnr = direct.filter(n => n.snr != null);
  const weakest = withSnr.length ? withSnr.reduce((a, b) => (a.snr! <= b.snr! ? a : b)) : null;
  const now = status?.now ?? Date.now() / 1000;
  const snapAge = status?.last_node_update != null ? Math.round(now - status.last_node_update) : null;
  const num = (v: number | null | undefined) => (v == null ? "—" : v);
  const radioOk = status?.bridge?.ok ?? null;
  return (
    <div className="vitals" role="status" aria-label="Mesh vitals">
      <div className="vital"><span className="k">Nodes online</span><span className="v">{online.length}<small>/ {nodes.length}</small></span><span className="sub"><span className="up">{direct.length} direct</span> · rest via hops</span></div>
      <div className="vital"><span className="k">Weakest link</span><span className="v">{weakest ? `${weakest.snr} dB` : "—"}</span><span className="sub">{weakest ? `${weakest.short_name ?? weakest.node_id} · direct RF` : "no direct SNR yet"}</span></div>
      <div className="vital"><span className="k">Messages · 24h</span><span className="v">{num(stats?.msgs_24h)}</span><span className="sub">{stats ? `${stats.in_24h} in · ${stats.out_24h} out` : "loading…"}</span></div>
      <div className="vital"><span className="k">AI queries · 24h</span><span className="v">{num(stats?.ai_24h)}</span><span className="sub">via @ai</span></div>
      <div className="vital"><span className="k">Radio link</span><span className={radioOk == null ? "v" : radioOk ? "v up" : "v down"}>{radioOk == null ? "—" : radioOk ? "OK" : "DOWN"}</span><span className="sub">bridge → radio</span></div>
      <div className="vital"><span className="k">Snapshot</span><span className={snapAge != null && snapAge > 300 ? "v down" : "v"}>{snapAge == null ? "—" : `${snapAge}s`}</span><span className="sub">node data age</span></div>
    </div>
  );
}
