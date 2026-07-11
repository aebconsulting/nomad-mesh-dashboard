import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { ago, isOffline, deviceType, roleLabel, fetchNeighbors } from "../api";
import type { Node, NeighborLink } from "../api";

// Register the pmtiles:// protocol once at module load so MapLibre can pull
// vector tiles directly out of the offline PMTiles archive via HTTP range reads.
const pmtilesProtocol = new Protocol();
maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

const FLORIDA_CENTER: [number, number] = [-82.4, 27.9];
const NODES_SOURCE = "nodes";
const NODES_LAYER = "nodes";
const LINKS_SOURCE = "links";
const LINKS_LAYER = "mesh-links";

// Color-codes each edge by SNR so weak links (likely to drop) stand out from
// strong ones at a glance; a missing snr (older bridge payloads) gets a
// neutral slate rather than defaulting to "weak". "==" against null is
// used (rather than ">="/"has") because MapLibre's comparison operators are
// strictly typed and null-safe only under "==" — a numeric ">=" on a null
// "get" result throws at render time instead of falling through.
// (Meridian status colors; MapLibre expressions can't read CSS variables.)
const LINK_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "case",
  ["==", ["get", "snr"], null], "#566275",
  [">=", ["get", "snr"], 5], "#28a860",
  [">=", ["get", "snr"], -5], "#e8a13a",
  "#d83c3c",
];

type NodeProps = {
  node_id: string; label: string; battery: number | null; ago: string;
  hw_model: string | null; role: string | null; voltage: number | null;
  temperature: number | null; humidity: number | null; pressure: number | null;
};
type NodeFeature = GeoJSON.Feature<GeoJSON.Point, NodeProps>;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Builds the hover-popup body: label, then device/role, battery+voltage+age, and
// weather lines — each line/segment omitted entirely when its data is null.
function popupHtml(p: NodeProps): string {
  const lines: string[] = [escapeHtml(p.label)];
  const idRole = [p.hw_model ? deviceType(p.hw_model) : null, p.role ? roleLabel(p.role) : null].filter((x): x is string => x != null);
  if (idRole.length) lines.push(escapeHtml(idRole.join(" · ")));
  const dev = [p.battery != null ? `batt ${p.battery}%` : null, p.voltage != null ? `${p.voltage}V` : null, p.ago].filter((x): x is string => x != null);
  if (dev.length) lines.push(escapeHtml(dev.join(" · ")));
  const wx = [p.temperature != null ? `${p.temperature}°C` : null, p.humidity != null ? `${p.humidity}%` : null, p.pressure != null ? `${p.pressure}hPa` : null].filter((x): x is string => x != null);
  if (wx.length) lines.push(escapeHtml(wx.join(" ")));
  return lines.join("<br/>");
}

// Fetches the backend-served style as TEXT and rewrites its localhost:8080
// asset/source URLs to this origin's /maps/* routes before parsing, since the
// style.json is generated pointing at the map-tile-server's own bind address.
async function loadStyle(): Promise<maplibregl.StyleSpecification> {
  const res = await fetch("/maps/style.json");
  let txt = await res.text();
  txt = txt
    .replaceAll("http://localhost:8080/basemaps-assets", location.origin + "/maps/assets")
    .replaceAll("http://localhost:8080/maps/nomad.pmtiles", location.origin + "/maps/basemap.pmtiles");
  return JSON.parse(txt);
}

// Builds the marker source data + the bounds-fit target from the positioned nodes.
function toFeatureCollection(nodes: Node[]): GeoJSON.FeatureCollection<GeoJSON.Point, NodeProps> {
  return {
    type: "FeatureCollection",
    features: nodes.map((n): NodeFeature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [n.lon as number, n.lat as number] },
      properties: {
        node_id: n.node_id, label: n.short_name ?? n.node_id, battery: n.battery, ago: ago(n.last_heard),
        hw_model: n.hw_model, role: n.role, voltage: n.voltage,
        temperature: n.temperature, humidity: n.humidity, pressure: n.pressure,
      },
    })),
  };
}

// Builds one LineString feature per directed neighbor edge, carrying only the
// snr the line-color expression needs.
function toLinkFeatureCollection(links: NeighborLink[]): GeoJSON.FeatureCollection<GeoJSON.LineString, { snr: number | null }> {
  return {
    type: "FeatureCollection",
    features: links.map((l): GeoJSON.Feature<GeoJSON.LineString, { snr: number | null }> => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[l.from_lon, l.from_lat], [l.to_lon, l.to_lat]] },
      properties: { snr: l.snr },
    })),
  };
}

// Fits the map to all positioned nodes (or resets to the initial Florida view
// when none are positioned). fitBounds/jumpTo are programmatic camera moves —
// they fire "movestart" WITHOUT an originalEvent, so they never trip the
// user-took-control guard below.
function fitToPositioned(map: maplibregl.Map, nodes: Node[]) {
  if (!nodes.length) {
    map.jumpTo({ center: FLORIDA_CENTER, zoom: 5 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  nodes.forEach(n => bounds.extend([n.lon as number, n.lat as number]));
  map.fitBounds(bounds, { padding: 40, animate: false });
}

// The command-center hero: an always-mounted offline map of the mesh.
// Extracted from Nodes.tsx — same lifecycle guards, minus the map/table toggle.
export function MeshMap({ nodes, stale, showOffline, onToggleOffline, onOpenDetail }: {
  nodes: Node[]; stale?: boolean; showOffline: boolean; onToggleOffline: () => void; onOpenDetail: (id: string) => void;
}) {
  const [mapReady, setMapReady] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const divRef = useRef<HTMLDivElement | null>(null);
  const userMovedRef = useRef(false);       // user has panned/zoomed -> stop auto-refitting
  const prevCountRef = useRef(0);           // positioned-node count at last paint
  const positioned = nodes.filter(n => n.lat != null && n.lon != null && (showOffline || !isOffline(n)));

  // Owns the map's lifecycle: created once on mount, torn down on unmount.
  // Style load is async (fetch + text rewrite), so a `cancelled` flag guards
  // against the effect being torn down before it resolves — an unmount
  // mid-fetch must not create or keep a map.
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    let hoverPopup: maplibregl.Popup | null = null;
    userMovedRef.current = false;
    prevCountRef.current = 0;

    loadStyle().then(style => {
      if (cancelled) return;
      map = new maplibregl.Map({
        container: el,
        style,
        center: FLORIDA_CENTER,
        zoom: 5,
        minZoom: 2,
        attributionControl: false,
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "© OpenStreetMap" }));
      // Any drag or zoom the user initiates carries the native DOM event that
      // triggered it; our own fitBounds/jumpTo calls don't, so this only fires
      // on real user interaction, not on programmatic auto-fits.
      map.on("movestart", (e) => { if (e.originalEvent) userMovedRef.current = true; });

      map.on("load", () => {
        if (cancelled || !map) return;
        map.addSource(NODES_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: NODES_LAYER,
          type: "circle",
          source: NODES_SOURCE,
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffb020",
            "circle-opacity": 0.9,
            "circle-stroke-color": "#0a0e13",
            "circle-stroke-width": 1,
          },
        });
        // Neighbor-link edges live on their own source/layer, inserted BEFORE the
        // node layer in the stack (beforeId) so edges render under the node dots
        // rather than obscuring them. Empty until the Links toggle + poll fill it.
        map.addSource(LINKS_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: LINKS_LAYER,
          type: "line",
          source: LINKS_SOURCE,
          paint: {
            "line-width": 1.5,
            "line-opacity": 0.5,
            "line-color": LINK_COLOR_EXPR,
          },
        }, NODES_LAYER);
        map.on("mouseenter", NODES_LAYER, (e) => {
          map!.getCanvas().style.cursor = "pointer";
          const f = e.features?.[0] as NodeFeature | undefined;
          if (!f) return;
          hoverPopup = new maplibregl.Popup({ closeButton: false })
            .setLngLat(f.geometry.coordinates as [number, number])
            .setHTML(popupHtml(f.properties))
            .addTo(map!);
        });
        map.on("mouseleave", NODES_LAYER, () => {
          map!.getCanvas().style.cursor = "";
          hoverPopup?.remove();
          hoverPopup = null;
        });
        map.on("click", NODES_LAYER, (e) => {
          const f = e.features?.[0] as NodeFeature | undefined;
          if (f) onOpenDetail(f.properties.node_id);
        });
        mapRef.current = map;
        setMapReady(true);
      });
    }).catch(() => { /* style fetch failed — leave the panel blank rather than throw */ });

    // The map fills a flex cell whose height depends on sibling panels, which
    // grow as data loads; keep MapLibre's canvas size in sync with it.
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(el);

    return () => {
      cancelled = true;
      ro.disconnect();
      hoverPopup?.remove();
      map?.remove();
      mapRef.current = null;
      userMovedRef.current = false;
      prevCountRef.current = 0;
      setMapReady(false);
    };
  }, [onOpenDetail]);

  // Refreshes only the node source data on the existing map — never touches the
  // base style/layers, so a live poll can't disturb anything else on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource(NODES_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(toFeatureCollection(positioned));
    // Auto-fit when the positioned-node COUNT grows (first nodes appearing, or a
    // NEW positioned node showing up) as long as the user hasn't taken control.
    // Never refits on a count that stays flat or shrinks, so a live poll can't
    // yank the user's pan/zoom back.
    if (positioned.length > prevCountRef.current && !userMovedRef.current) {
      fitToPositioned(map, positioned);
    }
    prevCountRef.current = positioned.length;
  }, [nodes, showOffline, mapReady]);

  // Draws/clears the neighbor-link overlay. Independent of the node-refresh
  // effect above (own source, own poll cadence). The "links" source is only
  // created inside the map's "load" handler above, so this effect may run
  // BEFORE it exists (map still loading style) — every step no-ops on a
  // missing source rather than throwing, and the `mapReady` dep re-runs this
  // effect once the source is actually there.
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource(LINKS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!showLinks) {
      src?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    if (!src) return; // source not ready yet; mapReady flipping true will retry
    let cancelled = false;
    const load = () => {
      fetchNeighbors().then(({ items }) => {
        if (cancelled) return;
        const s = mapRef.current?.getSource(LINKS_SOURCE) as maplibregl.GeoJSONSource | undefined;
        s?.setData(toLinkFeatureCollection(items));
      }).catch(() => { /* transient fetch failure — leave last-good links on screen */ });
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [showLinks, mapReady]);

  // Manual escape hatch: clear the "user moved" flag and refit to all markers.
  const refit = () => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    userMovedRef.current = false;
    fitToPositioned(map, positioned);
  };

  return (
    <section className="panel map-hero">
      <div className="panel-h">
        <span className="t">Mesh map</span><span className="n">{positioned.length} nodes positioned · offline basemap</span>
        {stale && <span className="tag stale">STALE</span>}
        <span className="right">
          <label className="offl"><input type="checkbox" checked={showOffline} onChange={onToggleOffline} /> offline</label>
          <button className="tab" onClick={refit} title="Refit map to all nodes">FIT</button>
          <button className="tab" aria-pressed={showLinks} onClick={() => setShowLinks(v => !v)} title="Show neighbor links">Links</button>
        </span>
      </div>
      <div className="map-hero-body">
        <div ref={divRef} className="map" role="img" aria-label={`Node map: ${positioned.length} nodes with position`} />
      </div>
    </section>
  );
}
