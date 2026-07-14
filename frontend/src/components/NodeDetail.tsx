import { useEffect, useState } from "react";
import { fetchNodeDetail, deviceType, roleLabel, roleInfo, fmtUptime, postTraceroute, getTraceroute } from "../api";
import type { NodeDetail as NodeDetailData, Node, TraceResult } from "../api";

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

const TRACE_POLL_MS = 3000;
const TRACE_TIMEOUT_MS = 90_000;
const TRACE_COOLDOWN_MS = 35_000; // radio only permits ~1 traceroute per ~35s

const fmtSnr = (v: number | null | undefined) => v == null ? "?" : `${v} dB`;

/** `ok` renders the hop chain instead; everything else renders as this line. */
function traceStatusLine(status: string): string {
  if (status === "timeout") return "no response (timed out)";
  if (status.startsWith("failed:")) return `failed: ${status.slice("failed:".length)}`;
  return status;
}

/** Slide-in node detail drawer: identity, position, device, per-group telemetry, weather, trace route. */
export function NodeDetail({ nodeId, onClose, onDm, canTrace, nodes, baseNode, onTraceDone }: {
  nodeId: string; onClose: () => void; onDm: (id: string) => void;
  canTrace: boolean; nodes: Node[]; baseNode: string | null; onTraceDone: (r: TraceResult | null) => void;
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

  // ---- Trace route ----
  const [traceId, setTraceId] = useState<number | null>(null);
  const [tracePending, setTracePending] = useState(false);
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceTimedOut, setTraceTimedOut] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Reset all trace state whenever the traced node changes, and tell App the
  // shown route is gone on unmount too (App already clears its own copy on
  // close — this covers a node-switch with the drawer left open).
  useEffect(() => {
    setTraceId(null);
    setTracePending(false);
    setTraceResult(null);
    setTraceError(null);
    setTraceTimedOut(false);
    setCooldownUntil(null);
    return () => { onTraceDone(null); };
  }, [nodeId, onTraceDone]);

  // 1s ticker purely to refresh the pending/cooldown countdown text — no network activity.
  useEffect(() => {
    if (!tracePending && cooldownUntil == null) return;
    const iv = setInterval(() => {
      setNowTick(Date.now());
      setCooldownUntil(c => (c != null && c <= Date.now() ? null : c));
    }, 1000);
    return () => clearInterval(iv);
  }, [tracePending, cooldownUntil]);

  // Poll the result while a trace is outstanding; ~90s of "pending" gives up.
  useEffect(() => {
    if (traceId == null) return;
    let live = true;
    const start = Date.now();
    const poll = () => {
      getTraceroute(traceId).then(r => {
        if (!live) return;
        if (r.status === "pending") {
          if (Date.now() - start > TRACE_TIMEOUT_MS) {
            setTracePending(false);
            setTraceTimedOut(true);
            setCooldownUntil(Date.now() + TRACE_COOLDOWN_MS);
            setTraceId(null);
          }
          return;
        }
        setTracePending(false);
        setTraceResult(r);
        setCooldownUntil(Date.now() + TRACE_COOLDOWN_MS);
        if (r.status === "ok") onTraceDone(r);
        setTraceId(null);
      }).catch(e => {
        if (!live) return;
        setTracePending(false);
        setTraceError(e?.message ?? "poll failed");
        setTraceId(null);
      });
    };
    poll();
    const iv = setInterval(poll, TRACE_POLL_MS);
    return () => { live = false; clearInterval(iv); };
  }, [traceId, onTraceDone]);

  const cooldownS = cooldownUntil != null ? Math.max(0, Math.ceil((cooldownUntil - nowTick) / 1000)) : 0;

  async function startTrace() {
    if (tracePending || cooldownS > 0) return;
    setTraceError(null);
    setTraceResult(null);
    setTraceTimedOut(false);
    setTracePending(true);
    try {
      const r = await postTraceroute(nodeId);
      setTraceId(r.id);
    } catch (e: any) {
      setTracePending(false);
      setTraceError(e?.message ?? "traceroute failed");
    }
  }

  /** `!hex` -> long_name ?? short_name ?? the raw id; null (base unconfigured) -> "base". */
  const resolveName = (id: string | null): string => {
    if (id == null) return "base";
    const found = nodes.find(x => x.node_id === id);
    if (found) return found.long_name ?? found.short_name ?? id;
    if (traceResult && id === traceResult.dest && traceResult.dest_name) return traceResult.dest_name;
    return id;
  };

  /** Endpoints are implicit: `hops` is intermediate-only, `snrs` has hops.length+1
   *  entries (last one belongs to `end`). Renders start -> hop -> … -> end. */
  function renderChain(start: string | null, hops: string[], snrs: (number | null)[], end: string | null) {
    const stops = [...hops, end];
    return (
      <div className="dd-trace-chain">
        <span className="dd-trace-node">{resolveName(start)}</span>
        {stops.map((id, i) => (
          <span className="dd-trace-hop" key={i}>
            <span className="dd-trace-arrow">→</span>
            <span className="dd-trace-node">{resolveName(id)}</span>
            <span className="dd-trace-snr">{fmtSnr(snrs[i])}</span>
          </span>
        ))}
      </div>
    );
  }

  // Honesty constraint (bridge): for any `ok` result the bridge guarantees
  // snr_back.length == route_back.length + 1 (padding with unknown-SNR
  // placeholders, never truncating). A genuine direct (0-hop) reply is
  // route_back=[] with exactly one snr_back entry — which CAN legitimately
  // be null (reply arrived, SNR unknown). So presence must be judged by
  // LENGTH, not by whether any SNR value is non-null: a truly empty
  // snr_back (length 0) only happens when the backend's defensive DB read
  // hit a NULL/malformed column, i.e. no back data was ever recorded.
  const hasBack = !!traceResult && (traceResult.route_back.length > 0 || traceResult.snr_back.length > 0);

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
                  <div><dt>Role</dt><dd className="role-help" title={roleInfo(n.role ?? null)}>{roleLabel(n.role ?? null)}</dd></div>
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

              {canTrace && (
                <section className="dd-sec">
                  <h4>Trace route</h4>
                  <button className="tab" disabled={tracePending || cooldownS > 0} onClick={startTrace}>
                    {tracePending ? "Tracing…" : cooldownS > 0 ? `cooling down ${cooldownS}s` : "Trace route"}
                  </button>
                  {tracePending && <div className="dd-trace-msg">Waiting for response… (up to ~90s)</div>}
                  {traceTimedOut && <div className="dd-trace-msg warn">No response — node unreachable or asleep.</div>}
                  {traceError && <div className="dd-trace-msg warn">{traceError}</div>}
                  {traceResult && (
                    traceResult.status !== "ok" ? (
                      <div className="dd-trace-msg warn">{traceStatusLine(traceResult.status)}</div>
                    ) : (
                      <>
                        <div className="dd-trace-dir">
                          <span className="dd-trace-label">Towards</span>
                          {renderChain(baseNode, traceResult.route, traceResult.snr_towards, traceResult.dest)}
                        </div>
                        {hasBack && (
                          <div className="dd-trace-dir">
                            <span className="dd-trace-label">Back</span>
                            {renderChain(traceResult.dest, traceResult.route_back, traceResult.snr_back, baseNode)}
                          </div>
                        )}
                      </>
                    )
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
