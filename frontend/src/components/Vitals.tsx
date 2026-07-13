import type { Node, Status, Stats as StatsData } from "../api";
import { isOffline, STALE_SECS } from "../api";

const isRouter = (n: Node) => (n.role ?? "").toUpperCase().includes("ROUTER");
const byStrength = (arr: Node[]) => [...arr].filter(n => n.snr != null).sort((a, b) => b.snr! - a.snr!);

// The signature mesh-vitals strip: glanceable radio-console readouts.
// All values derive client-side from data the app already polls; status
// values are words (OK/DOWN), never color alone (dataviz rule).
export function Vitals({ status, stats, nodes }: { status: Status | null; stats: StatsData | null; nodes: Node[] }) {
  const online = nodes.filter(n => !isOffline(n));
  const direct = online.filter(n => n.hops === 0);
  // "Nearest router" = your strongest DIRECT (hops=0) relay to OTHERS — the node
  // that carries your channel traffic into the mesh. Prefer an actual router
  // role; else the strongest direct partner (clients relay too). EXCLUDE the
  // operator's own co-located devices (base + second radio): they always read
  // strong but say nothing about whether other people will hear a send. The
  // partner count is real broadcast reach; 0 means a channel send may go unheard.
  const own = new Set(status?.own_nodes ?? []);
  const relayPartners = direct.filter(n => !own.has(n.node_id));
  const nearest = byStrength(relayPartners.filter(isRouter))[0] ?? byStrength(relayPartners)[0] ?? relayPartners[0] ?? null;
  const partners = relayPartners.length;
  const now = status?.now ?? Date.now() / 1000;
  const snapAge = status?.last_node_update != null ? Math.round(now - status.last_node_update) : null;
  const num = (v: number | null | undefined) => (v == null ? "—" : v);
  // null only while status itself is loading; a loaded status with no bridge
  // block IS a radio-path outage and must read DOWN, not "—" (review finding).
  const radioOk = status == null ? null : (status.bridge?.ok ?? false);
  // Humanize large ages: seconds are only readable while fresh.
  const age = (s: number) => s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  const partnerWord = `${partners} direct partner${partners === 1 ? "" : "s"}`;
  return (
    <div className="vitals" aria-label="Mesh vitals">
      <div className="vital"><span className="k">Nodes online</span><span className="v">{online.length}<small>/ {nodes.length}</small></span><span className="sub"><span className="up">{direct.length} direct</span> · rest via hops</span></div>
      <div className="vital">
        <span className="k">Nearest router</span>
        <span className={partners ? "v" : "v down"}>{nearest ? (nearest.short_name ?? nearest.node_id) : "none"}</span>
        <span className="sub">{partners === 0
          ? "no direct RF — channel sends may not be heard"
          : `${nearest?.snr != null ? nearest.snr + " dB · " : ""}${partnerWord} can relay`}</span>
      </div>
      <div className="vital"><span className="k">Messages · 24h</span><span className="v">{num(stats?.msgs_24h)}</span><span className="sub">{stats ? `${stats.in_24h} in · ${stats.out_24h} out` : "loading…"}</span></div>
      <div className="vital"><span className="k">AI queries · 24h</span><span className="v">{num(stats?.ai_24h)}</span><span className="sub">via @ai</span></div>
      <div className="vital"><span className="k">Radio link</span><span className={radioOk == null ? "v" : radioOk ? "v up" : "v down"}>{radioOk == null ? "—" : radioOk ? "OK" : "DOWN"}</span><span className="sub">bridge → radio</span></div>
      <div className="vital"><span className="k">Snapshot</span><span className={snapAge != null && snapAge > STALE_SECS ? "v down" : "v"}>{snapAge == null ? "—" : age(snapAge)}</span><span className="sub">node data age</span></div>
    </div>
  );
}
