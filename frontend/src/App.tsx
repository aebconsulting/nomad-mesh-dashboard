import { useState } from "react";
import { Header } from "./components/Header";
import { Vitals } from "./components/Vitals";
import { Feed, authorOf } from "./components/Feed";
import { Nodes } from "./components/Nodes";
import { MeshMap } from "./components/MeshMap";
import { NodeDetail } from "./components/NodeDetail";
import { LogPanel } from "./components/LogPanel";
import { usePoll, fetchStatus, fetchStats, fetchFeed, fetchNodes, fetchLog, sendMessage } from "./api";
import type { Msg, ReplyTarget, TraceResult } from "./api";

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
  const [focusNode, setFocusNode] = useState<string | null>(null); // node table → map: highlighted node
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  // NodeDetail reports the terminal trace result here; MeshMap draws the hop chain.
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null);

  // Reply scope rule: a channel message replies as a broadcast on that channel
  // (dm null); a DM (inbound OR outbound — outbound DM rows store the PEER in
  // node_id) replies back into that same DM thread, never broadcast.
  const onReply = (m: Msg) => {
    if (m.mesh_id == null) return;
    const dm = m.is_dm ? m.node_id : null;
    setReplyingTo({ meshId: m.mesh_id, name: authorOf(m), text: m.text, channel: m.channel, dm });
    setDmTarget(dm ?? "");
  };
  const onReact = (m: Msg, emoji: string): Promise<void> => {
    if (m.mesh_id == null) return Promise.resolve();
    const dm = m.is_dm ? m.node_id : null;
    return sendMessage(emoji, m.channel, dm, m.mesh_id, true);
  };
  return (
    <div className="wrap">
      <Header status={status.data} unreachable={status.stale} />
      <Vitals status={status.data} stats={stats.data} nodes={nodes.data?.items ?? []} />
      <div className="cmd-grid">
        <div className="chat-rail">
          <Feed
            items={feed.data?.items ?? []} nodes={nodes.data?.items ?? []} stale={feed.stale}
            dmTarget={dmTarget} onDmTargetChange={setDmTarget} showOffline={showOffline}
            replies={feed.data?.replies ?? false} onReply={onReply} onReact={onReact}
            replyingTo={replyingTo} onClearReply={() => setReplyingTo(null)}
            onSelectUser={setFocusNode}
          />
        </div>
        <MeshMap
          nodes={nodes.data?.items ?? []} stale={nodes.stale} showOffline={showOffline} onToggleOffline={() => setShowOffline(v => !v)} onOpenDetail={setDetailNode}
          focusNode={focusNode} onFocusClear={() => setFocusNode(null)} ownNodes={status.data?.pinned_nodes ?? status.data?.own_nodes ?? []}
          traceRoute={traceResult} baseNode={status.data?.base_node ?? null}
        />
      </div>
      <div className="lower-grid">
        <Nodes
          items={nodes.data?.items ?? []} stale={nodes.stale}
          onSelectNode={(id) => { setDmTarget(id); setFocusNode(id); }}
          onOpenDetail={setDetailNode}
          showOffline={showOffline} onToggleOffline={() => setShowOffline(v => !v)}
          focusNode={focusNode}
          ownNodes={status.data?.pinned_nodes ?? status.data?.own_nodes ?? []} baseNode={status.data?.base_node ?? null}
        />
        <LogPanel items={log.data?.items ?? []} stale={log.stale} />
      </div>
      {detailNode && (
        <NodeDetail
          nodeId={detailNode}
          onClose={() => { setDetailNode(null); setTraceResult(null); }}
          onDm={(id) => { setDmTarget(id); setDetailNode(null); }}
          canTrace={status.data?.traceroute ?? false}
          nodes={nodes.data?.items ?? []}
          baseNode={status.data?.base_node ?? null}
          onTraceDone={setTraceResult}
        />
      )}
    </div>
  );
}
