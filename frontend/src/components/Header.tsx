import type { Status } from "../api";

export function Header({ status, unreachable }: { status: Status | null; unreachable: boolean }) {
  const now = status?.now ?? Date.now() / 1000;
  const connecting = !status && !unreachable;
  const nodeAge = status?.last_node_update != null ? now - status.last_node_update : null;

  let level: "ok" | "warn" | "crit";
  let label: string;
  if (unreachable) {
    level = "crit";
    label = "DASHBOARD OFFLINE";
  } else if (connecting) {
    level = "warn";
    label = "CONNECTING…";
  } else if (nodeAge == null) {
    level = "crit";
    label = "STALE — no node data yet";
  } else if (nodeAge > 300) {
    level = "crit";
    label = `STALE — no bridge data for ${Math.round(nodeAge / 60)}m`;
  } else if (!status?.ok) {
    level = "warn";
    label = "DEGRADED — bridge API unreachable";
  } else {
    level = "ok";
    label = `LIVE — snapshot ${Math.round(nodeAge)}s ago`;
  }

  return (
    <header>
      <div className="brand"><b>MESH BASE — {status?.bridge?.node ?? "RZRB"}</b><span>NOMAD · aibox</span></div>
      <span className={`badge-live lvl-${level}`}><span className="dot" />{label}</span>
      <div className="hdr-right"><span>{new Date().toLocaleString()}</span></div>
    </header>
  );
}
