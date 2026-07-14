import { useEffect, useRef, useState } from "react";

export interface Msg { id: number; ts: number; direction: "in" | "out"; node_id: string; node_name: string; channel: number; is_dm: number; is_ai: number; text: string; ack_state: string | null; mesh_id: number | null; reply_to_id: number | null; is_reaction: number | null; }
export type ReplyTarget = { meshId: number; name: string; text: string; channel: number; dm: string | null };
export interface AssistantReply { answer: string; window_note: string | null; truncated: boolean; }
export interface Node {
  node_id: string; short_name: string | null; long_name: string | null; lat: number | null; lon: number | null;
  battery: number | null; snr: number | null; hops: number | null; last_heard: number | null; updated: number | null;
  hw_model: string | null; role: string | null; altitude: number | null; voltage: number | null;
  chan_util: number | null; air_util_tx: number | null; uptime_s: number | null; sats: number | null;
  loc_source: string | null; temperature: number | null; humidity: number | null; pressure: number | null; env_ts: number | null;
}
export interface Status { ok: boolean; db_ok: boolean; last_msg_ts: number | null; last_node_update: number | null; own_nodes?: string[]; base_node?: string | null; bridge: { ok: boolean; node: string | null } | null; now: number; }
export interface Stats { msgs_24h: number; in_24h: number; out_24h: number; ai_24h: number; }
export interface Img { name: string; url: string; }
export interface TelemetryPoint { metric: string; value: number; ts: number; }
export interface WeatherPoint { ts: number; temperature: number | null; humidity: number | null; pressure: number | null; }
export interface NodeDetail {
  node: Record<string, any>;
  telemetry: Record<string, TelemetryPoint[]>;
  weather: WeatherPoint[];
}
export interface NeighborLink {
  from_id: string; from_name: string | null; from_lat: number; from_lon: number;
  to_id: string; to_name: string | null; to_lat: number; to_lon: number;
  snr: number | null; ts: number;
}

export const OFFLINE_SECS = 7200; // 2 hours
export const STALE_SECS = 300;    // node-snapshot age that means "bridge data stopped"

/** Shared "Nm ago" formatter for last-heard style timestamps. */
export const ago = (ts: number | null) => ts == null ? "—" : `${Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))}m ago`;
export function isOffline(n: Node): boolean {
  return n.last_heard == null || (Date.now() / 1000 - n.last_heard) > OFFLINE_SECS;
}

/** Raw hardware model string is already a recognizable device name (e.g. "RAK4631"). */
export function deviceType(hw: string | null): string {
  return hw ?? "—";
}

const ROLE_LABELS: Record<string, string> = {
  CLIENT: "Client",
  CLIENT_MUTE: "Client (mute)",
  CLIENT_BASE: "Base",
  ROUTER: "Router",
  ROUTER_LATE: "Router",
  REPEATER: "Repeater",
  TRACKER: "Tracker",
  SENSOR: "Sensor",
};
export function roleLabel(role: string | null): string {
  if (role == null) return "—";
  return ROLE_LABELS[role] ?? role;
}

// Plain-English role definitions from the official Meshtastic docs — what the role
// is for and, crucially, whether the node RELAYS other people's packets (the thing
// that decides if it helps carry the mesh or just rides it).
const ROLE_INFO: Record<string, string> = {
  CLIENT: "Standard node. Relays others' packets when no one else has yet — every client helps carry the mesh.",
  CLIENT_MUTE: "Does NOT relay other nodes' packets — sends and receives only its own traffic. Rides the mesh without carrying it (used to reduce congestion in dense areas).",
  CLIENT_HIDDEN: "Stealth / power-save: transmits only when it must and hides from node lists. Relays locally only.",
  CLIENT_BASE: "Personal base station: ALWAYS relays packets to/from its favorited nodes (e.g. weaker indoor devices); handles everything else like a Client.",
  ROUTER: "Infrastructure relay: ALWAYS rebroadcasts every packet once, ahead of clients. The mesh backbone — intended for high, remote placements.",
  ROUTER_LATE: "Infrastructure relay that always rebroadcasts once but LAST, after everyone else — fills dead spots and backs up local clusters without hogging airtime.",
  REPEATER: "Pure relay: always rebroadcasts once with minimal overhead and hides itself from node lists entirely.",
  TRACKER: "Prioritizes broadcasting its GPS position; relays others' packets only while awake.",
  SENSOR: "Prioritizes broadcasting its telemetry (weather/power); relays others' packets only while awake.",
  LOST_AND_FOUND: "Broadcasts its location to the default channel regularly to help recover the device.",
  TAK: "Optimized for ATAK tactical systems; reduces routine broadcasts. Relays like a client.",
  TAK_TRACKER: "Standalone ATAK position beacon; reduces routine broadcasts. Relays like a client.",
};
export function roleInfo(role: string | null): string {
  if (role == null) return "This node has not reported a role.";
  return ROLE_INFO[role] ?? "Unrecognized role (newer firmware than this dashboard knows).";
}

/** Compact uptime: "Xd Yh" >= 1 day, "Yh Zm" >= 1 hour, else "Zm". */
export function fmtUptime(s: number | null): string {
  if (s == null) return "—";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export const fetchFeed = () => get<{ items: Msg[]; delivery_tracking?: boolean; replies?: boolean }>("/api/feed?limit=100");
export const fetchNodes = () => get<{ items: Node[]; snapshot_ts: number | null }>("/api/nodes");
export const fetchLog = () => get<{ items: Msg[] }>("/api/log?limit=200");
export const fetchImages = () => get<{ items: Img[]; mounted: boolean }>("/api/images");
export const fetchStatus = () => get<Status>("/api/status");
export const fetchStats = () => get<Stats>("/api/stats");
export const fetchNodeDetail = (id: string) => get<NodeDetail>(`/api/nodes/${encodeURIComponent(id)}/detail`);
export const fetchNeighbors = () => get<{ items: NeighborLink[] }>("/api/neighbors");

export async function sendMessage(text: string, channel: number, to: string | null, replyId?: number | null, react?: boolean): Promise<void> {
  const r = await fetch("/api/send", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Dashboard": "1" },
    body: JSON.stringify({ text, channel, to, reply_id: replyId ?? null, react: react ?? false }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    const d = j?.detail;
    const detail = Array.isArray(d) ? d.map((x: any) => x?.msg ?? String(x)).join("; ") : d ?? `send failed (${r.status})`;
    throw new Error(detail);
  }
}

export async function shortenUrl(url: string): Promise<string> {
  const r = await fetch("/api/shorten", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Dashboard": "1" },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    const d = j?.detail;
    throw new Error(Array.isArray(d) ? d.map((x: any) => x?.msg ?? String(x)).join("; ") : d ?? `shorten failed (${r.status})`);
  }
  return (await r.json()).short;
}

export async function askAssistant(question: string): Promise<AssistantReply> {
  const r = await fetch("/api/assistant", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Dashboard": "1" },
    body: JSON.stringify({ question }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    const d = j?.detail;
    const detail = Array.isArray(d) ? d.map((x: any) => x?.msg ?? String(x)).join("; ") : d ?? `analyst error (${r.status})`;
    throw new Error(detail);
  }
  return r.json();
}

/** Poll a fetcher every `ms`; keeps last good data and exposes staleness. */
export function usePoll<T>(fn: () => Promise<T>, ms: number): { data: T | null; stale: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState(false);
  const seqRef = useRef(0);
  useEffect(() => {
    let live = true;
    // Monotonic sequence guard: only the most-recently-issued tick may apply its
    // result, so a slow older response can't clobber newer data or wrongly clear
    // (or set) staleness after a fresher tick has already resolved.
    const tick = () => {
      const seq = ++seqRef.current;
      return fn().then(d => { if (live && seq === seqRef.current) { setData(d); setStale(false); } })
                 .catch(() => { if (live && seq === seqRef.current) setStale(true); });
    };
    tick();
    let id = setInterval(tick, ms);
    // Browsers throttle timers in hidden tabs (desktop: ~1/min) and freeze them
    // outright on locked/backgrounded phones — and don't reliably resume them.
    // Refetch the moment the app is visible/focused/back online and restart the
    // cadence, so returning to the tab never shows frozen data.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      clearInterval(id);
      tick();
      id = setInterval(tick, ms);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      live = false; clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, []);
  return { data, stale };
}
