import type { Node, Status, Stats as StatsData } from "../api";

export function Stats({ status, stats, nodes }: { status: Status | null; stats: StatsData | null; nodes: Node[] }) {
  const now = status?.now ?? Date.now() / 1000;
  const snapAge = status?.last_node_update ? Math.round(now - status.last_node_update) : null;
  const direct = nodes.filter(n => n.hops === 0).length;
  const num = (v: number | null | undefined) => (v == null ? "—" : v);
  return (
    <div className="stats">
      <div className="stat"><span className="k">Nodes heard</span><span className="v">{nodes.length}</span><span className="sub"><span className="up">{direct} direct</span> · rest via hops</span></div>
      <div className="stat"><span className="k">Messages · 24h</span><span className="v">{num(stats?.msgs_24h)}</span><span className="sub">{stats ? `${stats.in_24h} in · ${stats.out_24h} out` : "loading…"}</span></div>
      <div className="stat"><span className="k">AI queries · 24h</span><span className="v">{num(stats?.ai_24h)}</span><span className="sub">via @ai</span></div>
      <div className="stat"><span className="k">Node snapshot</span><span className="v">{snapAge === null ? "—" : `${snapAge}s`}</span><span className="sub">refreshes every 60s</span></div>
      <div className="stat"><span className="k">Radio link</span><span className={status === null ? "v" : status?.bridge?.ok ? "v up" : "v down"}>{status === null ? "—" : status?.bridge?.ok ? "OK" : "DOWN"}</span><span className="sub">via bridge</span></div>
    </div>
  );
}
