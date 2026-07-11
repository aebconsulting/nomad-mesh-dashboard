import { useState } from "react";
import { Header } from "./components/Header";
import { Vitals } from "./components/Vitals";
import { Feed } from "./components/Feed";
import { Nodes } from "./components/Nodes";
import { MeshMap } from "./components/MeshMap";
import { NodeDetail } from "./components/NodeDetail";
import { LogPanel } from "./components/LogPanel";
import { usePoll, fetchStatus, fetchStats, fetchFeed, fetchNodes, fetchLog } from "./api";

// AI images gallery hidden until images can be generated/delivered over the mesh
// (re-enable: restore the Images import, its usePoll, and the <Images> row below).

export default function App() {
  const status = usePoll(fetchStatus, 5000);
  const stats = usePoll(fetchStats, 30000);
  const feed = usePoll(fetchFeed, 5000);
  const nodes = usePoll(fetchNodes, 15000);
  const log = usePoll(fetchLog, 10000);
  const [dmTarget, setDmTarget] = useState("");       // "" = Broadcast CH0, else a node_id — shared by the node table and the send box
  const [showOffline, setShowOffline] = useState(false);
  const [detailNode, setDetailNode] = useState<string | null>(null);
  return (
    <div className="wrap">
      <Header status={status.data} unreachable={status.stale} />
      <Vitals status={status.data} stats={stats.data} nodes={nodes.data?.items ?? []} />
      <MeshMap nodes={nodes.data?.items ?? []} stale={nodes.stale} showOffline={showOffline} onOpenDetail={setDetailNode} />
      <div className="grid">
        <div className="col">
          <Feed
            items={feed.data?.items ?? []} nodes={nodes.data?.items ?? []} stale={feed.stale}
            dmTarget={dmTarget} onDmTargetChange={setDmTarget} showOffline={showOffline}
          />
        </div>
        <div className="col">
          <Nodes
            items={nodes.data?.items ?? []} stale={nodes.stale}
            onSelectNode={(id) => setDmTarget(id)}
            onOpenDetail={setDetailNode}
            showOffline={showOffline} onToggleOffline={() => setShowOffline(v => !v)}
          />
        </div>
      </div>
      <LogPanel items={log.data?.items ?? []} stale={log.stale} />
      {detailNode && <NodeDetail nodeId={detailNode} onClose={() => setDetailNode(null)} onDm={(id) => { setDmTarget(id); setDetailNode(null); }} />}
    </div>
  );
}
