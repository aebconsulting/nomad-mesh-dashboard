import { useState } from "react";
import { isOffline, deviceType, roleLabel } from "../api";
import type { Node } from "../api";

const ago = (ts: number | null) => ts == null ? "—" : `${Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))}m ago`;
const battClass = (b: number | null) => b == null ? "" : b < 25 ? "low" : b < 60 ? "mid" : "";
const sig = (snr: number | null) => snr == null ? ["—", ""] : snr > 5 ? ["Strong", ""] : snr > -5 ? ["Fair", "mid"] : ["Weak", "low"];

type SortKey = "name" | "hw_model" | "role" | "battery" | "snr" | "hops" | "last_heard";

// Numeric/string comparator for the node table. Nulls always sort to the bottom
// regardless of direction, so an unknown value never masquerades as "smallest".
function sortVal(n: Node, key: SortKey): string | number | null {
  switch (key) {
    case "name": return (n.short_name ?? n.node_id).toLowerCase();
    case "hw_model": return n.hw_model ? n.hw_model.toLowerCase() : null;
    case "role": return n.role ? n.role.toLowerCase() : null;
    case "battery": return n.battery;
    case "snr": return n.snr;
    case "hops": return n.hops;
    case "last_heard": return n.last_heard;
  }
}
function cmpNodes(a: Node, b: Node, key: SortKey, dir: 1 | -1): number {
  const av = sortVal(a, key), bv = sortVal(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
  return ((av as number) - (bv as number)) * dir;
}

// Table-only node roster (the map lives in MeshMap.tsx, the command-center hero).
export function Nodes({ items, stale, onSelectNode, onOpenDetail, showOffline, onToggleOffline }: {
  items: Node[]; stale?: boolean; onSelectNode: (id: string) => void; onOpenDetail: (id: string) => void;
  showOffline: boolean; onToggleOffline: () => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "last_heard", dir: -1 });

  const shown = showOffline ? items : items.filter(n => !isOffline(n));
  const rows = [...shown].sort((a, b) => cmpNodes(a, b, sort.key, sort.dir));

  const onSort = (key: SortKey) => setSort(s => s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) } : { key, dir: 1 });
  const caret = (key: SortKey) => sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "";

  return (
    <section className="panel nodes-panel">
      <div className="panel-h">
        <span className="t">Mesh nodes</span><span className="n">{shown.length} of {items.length} heard · 60s refresh</span>
        {stale && <span className="tag stale">STALE</span>}
        <span className="right">
          <label className="offl"><input type="checkbox" checked={showOffline} onChange={onToggleOffline} /> offline</label>
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th onClick={() => onSort("name")}>Node{caret("name")}</th>
              <th className="col-type" onClick={() => onSort("hw_model")}>Type{caret("hw_model")}</th>
              <th className="col-role" onClick={() => onSort("role")}>Role{caret("role")}</th>
              <th onClick={() => onSort("battery")}>Battery{caret("battery")}</th>
              <th onClick={() => onSort("snr")}>Signal{caret("snr")}</th>
              <th className="col-hops" onClick={() => onSort("hops")}>Hops{caret("hops")}</th>
              <th onClick={() => onSort("last_heard")}>Last heard{caret("last_heard")}</th>
              <th>·</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(n => {
              const [label, cls] = sig(n.snr);
              return (
                <tr key={n.node_id}>
                  <td><button className="nm-btn" onClick={() => onSelectNode(n.node_id)} title="DM this node">{n.short_name ?? n.node_id}</button></td>
                  <td className="col-type">{deviceType(n.hw_model)}</td>
                  <td className="col-role">{roleLabel(n.role)}</td>
                  <td><span className={`batt ${battClass(n.battery)}`}><span className="bar"><i style={{ width: `${n.battery ?? 0}%` }} /></span>{n.battery ?? "—"}%</span></td>
                  <td className={`sig ${cls}`}>{label}</td>
                  <td className="col-hops">{n.hops ?? "—"}</td>
                  <td className="dim">{ago(n.last_heard)}</td>
                  <td><button className="info-btn" title="Node details" onClick={() => onOpenDetail(n.node_id)}>ⓘ</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
