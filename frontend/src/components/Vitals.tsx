import type { Node, Status, Stats as StatsData } from "../api";
import { ago, isOffline, STALE_SECS } from "../api";

// The signature mesh-vitals strip: glanceable radio-console readouts.
// All values derive client-side from data the app already polls; status
// values are words (OK/DOWN), never color alone (dataviz rule).
export function Vitals({ status, stats, nodes }: { status: Status | null; stats: StatsData | null; nodes: Node[] }) {
  const online = nodes.filter(n => !isOffline(n));
  // Direct + weakest-link derive from the ONLINE population by design: the tile
  // reads "x/y online · N direct", and a direct node that goes offline leaves
  // both readouts together (the online count drops with it). The reading's age
  // is shown so a quiet-but-online node can't pass off an old SNR as live.
  const direct = online.filter(n => n.hops === 0);
  const withSnr = direct.filter(n => n.snr != null);
  const weakest = withSnr.length ? withSnr.reduce((a, b) => (a.snr! <= b.snr! ? a : b)) : null;
  const now = status?.now ?? Date.now() / 1000;
  const snapAge = status?.last_node_update != null ? Math.round(now - status.last_node_update) : null;
  const num = (v: number | null | undefined) => (v == null ? "—" : v);
  // null only while status itself is loading; a loaded status with no bridge
  // block IS a radio-path outage and must read DOWN, not "—" (review finding).
  const radioOk = status == null ? null : (status.bridge?.ok ?? false);
  // Humanize large ages: seconds are only readable while fresh.
  const age = (s: number) => s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  return (
    <div className="vitals" aria-label="Mesh vitals">
      <div className="vital"><span className="k">Nodes online</span><span className="v">{online.length}<small>/ {nodes.length}</small></span><span className="sub"><span className="up">{direct.length} direct</span> · rest via hops</span></div>
      <div className="vital"><span className="k">Weakest link</span><span className="v">{weakest ? `${weakest.snr} dB` : "—"}</span><span className="sub">{weakest ? `${weakest.short_name ?? weakest.node_id} · ${ago(weakest.last_heard)}` : "no direct SNR yet"}</span></div>
      <div className="vital"><span className="k">Messages · 24h</span><span className="v">{num(stats?.msgs_24h)}</span><span className="sub">{stats ? `${stats.in_24h} in · ${stats.out_24h} out` : "loading…"}</span></div>
      <div className="vital"><span className="k">AI queries · 24h</span><span className="v">{num(stats?.ai_24h)}</span><span className="sub">via @ai</span></div>
      <div className="vital"><span className="k">Radio link</span><span className={radioOk == null ? "v" : radioOk ? "v up" : "v down"}>{radioOk == null ? "—" : radioOk ? "OK" : "DOWN"}</span><span className="sub">bridge → radio</span></div>
      <div className="vital"><span className="k">Snapshot</span><span className={snapAge != null && snapAge > STALE_SECS ? "v down" : "v"}>{snapAge == null ? "—" : age(snapAge)}</span><span className="sub">node data age</span></div>
    </div>
  );
}
