import { useEffect, useState } from "react";
import { fetchNodeDetail, deviceType, roleLabel, fmtUptime } from "../api";
import type { NodeDetail as NodeDetailData } from "../api";

const ago = (ts: number | null | undefined) => ts == null ? "—" : `${Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))}m ago`;
const fmtTs = (ts: number) => new Date(ts * 1000).toLocaleString();
const round2 = (v: number) => Math.round(v * 100) / 100;

const GROUP_LABELS: Record<string, string> = {
  deviceMetrics: "Device telemetry",
  environmentMetrics: "Environment",
  powerMetrics: "Power",
  airQualityMetrics: "Air quality",
  localStats: "Local stats",
  healthMetrics: "Health",
};

/** Slide-in node detail drawer: identity, position, device, per-group telemetry, weather. */
export function NodeDetail({ nodeId, onClose, onDm }: {
  nodeId: string; onClose: () => void; onDm: (id: string) => void;
}) {
  const [data, setData] = useState<NodeDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setData(null);
    fetchNodeDetail(nodeId)
      .then(d => { if (live) { setData(d); setLoading(false); } })
      .catch(e => { if (live) { setError(e?.message ?? "load failed"); setLoading(false); } });
    return () => { live = false; };
  }, [nodeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const n = data?.node;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Node details">
        <div className="drawer-h">
          <span className="t">{n ? (n.long_name ?? n.short_name ?? nodeId) : nodeId}</span>
          <span className="right">
            <button className="tab" onClick={() => { onDm(nodeId); onClose(); }}>DM this node</button>
            <button className="drawer-close" onClick={onClose} aria-label="Close">✕</button>
          </span>
        </div>
        <div className="drawer-body">
          {loading && <div className="empty">Loading…</div>}
          {error && <div className="empty warn">Failed to load: {error}</div>}
          {data && n && (
            <>
              <section className="dd-sec">
                <h4>Identity</h4>
                <dl className="dd-dl">
                  <div><dt>Device</dt><dd>{deviceType(n.hw_model ?? null)}</dd></div>
                  <div><dt>Role</dt><dd>{roleLabel(n.role ?? null)}</dd></div>
                  <div><dt>Node ID</dt><dd>{n.node_id ?? nodeId}</dd></div>
                </dl>
              </section>

              <section className="dd-sec">
                <h4>Position</h4>
                <dl className="dd-dl">
                  <div><dt>Lat</dt><dd>{n.lat ?? "—"}</dd></div>
                  <div><dt>Lon</dt><dd>{n.lon ?? "—"}</dd></div>
                  <div><dt>Altitude</dt><dd>{n.altitude != null ? `${n.altitude} m` : "—"}</dd></div>
                  <div><dt>Sats</dt><dd>{n.sats ?? "—"}</dd></div>
                  <div><dt>Loc source</dt><dd>{n.loc_source ?? "—"}</dd></div>
                  <div><dt>Hops</dt><dd>{n.hops ?? "—"}</dd></div>
                  <div><dt>Last heard</dt><dd>{ago(n.last_heard)}</dd></div>
                </dl>
              </section>

              <section className="dd-sec">
                <h4>Device</h4>
                <dl className="dd-dl">
                  <div><dt>Battery</dt><dd>{n.battery != null ? `${n.battery}%` : "—"}</dd></div>
                  <div><dt>Voltage</dt><dd>{n.voltage != null ? `${n.voltage}V` : "—"}</dd></div>
                  <div><dt>Chan util</dt><dd>{n.chan_util != null ? `${n.chan_util}%` : "—"}</dd></div>
                  <div><dt>Air util TX</dt><dd>{n.air_util_tx != null ? `${n.air_util_tx}%` : "—"}</dd></div>
                  <div><dt>Uptime</dt><dd>{fmtUptime(n.uptime_s ?? null)}</dd></div>
                </dl>
              </section>

              {Object.entries(data.telemetry ?? {}).map(([group, points]) => (
                points && points.length > 0 && (
                  <section className="dd-sec" key={group}>
                    <h4>{GROUP_LABELS[group] ?? group}<span className="dd-fresh">{ago(points[0]?.ts)}</span></h4>
                    <table className="dd-tbl">
                      <tbody>
                        {points.map((p, i) => (
                          <tr key={i}><td>{p.metric}</td><td>{round2(p.value)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )
              ))}

              {data.weather && data.weather.length > 0 && (
                <section className="dd-sec">
                  <h4>Weather<span className="dd-fresh">{ago(data.weather[0].ts)}</span></h4>
                  <dl className="dd-dl">
                    <div><dt>Temp</dt><dd>{data.weather[0].temperature != null ? `${data.weather[0].temperature}°C` : "—"}</dd></div>
                    <div><dt>Humidity</dt><dd>{data.weather[0].humidity != null ? `${data.weather[0].humidity}%` : "—"}</dd></div>
                    <div><dt>Pressure</dt><dd>{data.weather[0].pressure != null ? `${data.weather[0].pressure}hPa` : "—"}</dd></div>
                  </dl>
                  <ul className="dd-wx">
                    {data.weather.map((w, i) => (
                      <li key={i}>
                        <span className="dim">{fmtTs(w.ts)}</span>
                        <span>{w.temperature != null ? `${w.temperature}°C` : "—"}</span>
                        <span>{w.humidity != null ? `${w.humidity}%` : "—"}</span>
                        <span>{w.pressure != null ? `${w.pressure}hPa` : "—"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
