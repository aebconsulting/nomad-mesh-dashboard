# Meridian Phase 1 — Command-Center Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-shape the existing nomad-mesh-dashboard into the Meridian command-center layout (map hero + chat rail + node table + mesh-vitals strip) in the validated Meridian dark palette, backed entirely by the existing `memory.db` endpoints, and ship it live at dashboard.meshnomad.ai.

**Architecture:** Pure frontend re-theme + re-layout of the existing React+Vite app. Zero backend changes (all vitals derive client-side from `/api/nodes`, `/api/stats`, `/api/status`). The map is extracted from `Nodes.tsx` into a standalone always-mounted hero component; `Nodes.tsx` becomes table-only. Deploys as image `:v13` via the proven aibox-build → Aaron-ghcr-push → NOMAD-PUT loop.

**Tech Stack:** React 18 + TypeScript + Vite, MapLibre GL + PMTiles (offline basemap), FastAPI backend (untouched), @fontsource self-hosted fonts, Playwright MCP for QA.

## Global Constraints (from spec §2–§7 + CLAUDE.md)

- **Never touch MeshMonitor's code or the radio path.** Meridian reads + one send button. Zero change to the bridge.
- **Palette is VALIDATED — do not re-derive.** Base `#131923`; mantle `#0e131a`; crust `#0a0e13`; surfaces `#1c2431 / #27303f / #35404f`; text `#e8edf4`; subtext `#b7c2d2 / #94a1b5`; accent `#ffb020`; status good `#28a860` / warn `#e8a13a` / critical `#d83c3c`; categorical FIXED order `#3f6fd0 #28a860 #bd7320 #9d5fd0 #1a9e93 #d83c3c #2f95c8 #c85f9e`.
- Status colors are reserved for status; never color-alone (keep icon/label pairing).
- Fonts must be self-hosted/offline (LAN-only deploy — no CDN).
- Aaron runs all ghcr pushes and radio-host writes; agent builds on aibox + does NOMAD PUTs.
- NOMAD image-tag change = **PUT `/api/system/services/custom`** with FULL config + `force:true` (POST `/update` ignores the image field).
- Verify every claim against live state (life-safety mesh); never report success from inference.
- Canonical repo: `C:\Users\AB Digial\projects\nomad-mesh-dashboard` (own git). Mirror copy for the monorepo build dir gets synced at the end.
- Invoke **dataviz** skill before styling the vitals strip (stat tiles trigger it); **frontend-design** for the layout work.

## File Structure

- Modify: `frontend/src/styles.css` — Meridian tokens + new layout classes (single stylesheet stays; it's 280 lines, cohesive)
- Modify: `frontend/src/main.tsx` — font imports
- Modify: `frontend/index.html` — title
- Modify: `frontend/package.json` — @fontsource deps
- Create: `frontend/src/components/MeshMap.tsx` — always-mounted map hero (extracted from Nodes.tsx)
- Modify: `frontend/src/components/Nodes.tsx` — table-only panel (map code removed)
- Create: `frontend/src/components/Vitals.tsx` — signature mesh-vitals strip (replaces Stats.tsx)
- Delete: `frontend/src/components/Stats.tsx`
- Modify: `frontend/src/components/Header.tsx` — Meridian brand + Open MeshMonitor link
- Modify: `frontend/src/App.tsx` — command-center grid
- Backend + tests: **no changes** (Phase 1 uses existing endpoints only)

Data notes for the vitals strip (spec §5): "queue/denial" has **no data source in memory.db** — omitted in Phase 1 (revisit when MeshMonitor `/api/v1` lands in Phase 3). "Mesh health" = the header status badge + radio-link tile (no second derivation).

---

### Task 1: Meridian design tokens + typography

**Files:**
- Modify: `frontend/src/styles.css:1-18` (`:root` block) + color sweeps listed below
- Modify: `frontend/src/main.tsx`, `frontend/index.html`, `frontend/package.json`

**Interfaces:**
- Produces: CSS custom properties `--bg --bg-deep --panel --panel-2 --line --line-soft --text --muted --faint --accent --accent-dim --ok --warn --crit --in --out --ai --mono --sans` — every later task styles against these names only.

- [ ] **Step 1: Install self-hosted fonts**

```bash
cd "/c/Users/AB Digial/projects/nomad-mesh-dashboard/frontend"
npm install @fontsource/ibm-plex-mono @fontsource/ibm-plex-sans
```

- [ ] **Step 2: Import font weights in `main.tsx`** (before `styles.css`)

```tsx
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
```

- [ ] **Step 3: Replace the `:root` token block in `styles.css`**

```css
:root, :root[data-theme="dark"], :root[data-theme="light"] {
  color-scheme: dark;
  /* Meridian — a field radio at night (validated palette, spec §7) */
  --bg: #131923;        /* base */
  --bg-deep: #0a0e13;   /* crust: on-accent text, map dot strokes */
  --panel: #1c2431;     /* surface 1: cards */
  --panel-2: #0e131a;   /* mantle: inset wells (send box, map bg) */
  --line: #35404f;      /* surface 3: strong borders */
  --line-soft: #27303f; /* surface 2: soft borders */
  --text: #e8edf4;
  --muted: #94a1b5;
  --faint: #6b7789;     /* dimmest subtext step */
  --accent: #ffb020;    /* amber phosphor — restraint */
  --accent-dim: #8a6210;
  --ok: #28a860;
  --warn: #e8a13a;
  --crit: #d83c3c;
  --in: #3f6fd0;        /* categorical blue — inbound senders */
  --out: #ffb020;       /* self/outbound = accent */
  --ai: #1a9e93;        /* categorical teal — AI voice */
  --mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  --sans: "IBM Plex Sans", system-ui, "Segoe UI", sans-serif;
}
```

- [ ] **Step 4: Sweep semantic selectors from green-accent to the split tokens** (the old theme used `--accent` for both brand AND "good"; Meridian separates them)

In `styles.css`, change ONLY the value side of these rules:
- `.badge-live` → `color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent);`
- `.dot` → `background: var(--ok);`
- `.up` → `color: var(--ok);`
- `.in .who` → `color: var(--in);` ; `.out .who` → `color: var(--out);` ; `.aiMsg .who` → `color: var(--ai);`
- `.tag.ai` → `color: var(--ai); border-color: color-mix(in srgb, var(--ai) 40%, transparent);`
- `.batt .bar i` → `background: var(--ok);`
- `.sig` → `color: var(--ok);`
- `.k-mesh` → `color: var(--ok);` ; `.k-ai` → `color: var(--ai);` (`.k-tx` stays `var(--warn)`)
- `.send button` → `background: var(--accent); color: var(--bg-deep);`
- `.g1/.g2/.g3` gradients (hidden gallery): retint inner stops to `#3f6fd0`, `#1a9e93`, `#bd7320` with outer stops `#1c2431` → `#0e131a`.
- Leave every rule that already reads `var(--accent)` for brand emphasis (node names `.nm`, `.nm-btn`, pressed `.tab`, focus outlines, `.combo-opt.sel`) — amber IS the brand there.

- [ ] **Step 5: Retitle the app** — `frontend/index.html`: `<title>Meridian — Mesh Command Center</title>`

- [ ] **Step 6: Build + visual check**

```bash
npm run build   # expect: tsc + vite OK
```
Start dev stack (Task 6 Step 1 shows the full local-data recipe; for a quick check `npm run dev` against the deployed API is fine if on LAN) and confirm: dark blue-slate surfaces, amber names/buttons, green LIVE badge, blue inbound senders.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(meridian): design tokens — validated dark palette + IBM Plex type"
```

---

### Task 2: Extract MeshMap.tsx — always-mounted map hero; Nodes.tsx goes table-only

**Files:**
- Create: `frontend/src/components/MeshMap.tsx`
- Modify: `frontend/src/components/Nodes.tsx` (remove all map code + the map/table toggle)

**Interfaces:**
- Consumes: `fetchNeighbors`, `isOffline`, types `Node`, `NeighborLink` from `../api` (unchanged).
- Produces: `MeshMap({ nodes, stale, showOffline, onOpenDetail }: { nodes: Node[]; stale?: boolean; showOffline: boolean; onOpenDetail: (id: string) => void })` and `Nodes({ items, stale, onSelectNode, onOpenDetail, showOffline, onToggleOffline })` (same as today minus the internal `view` state).

- [ ] **Step 1: Create `MeshMap.tsx`** — move from `Nodes.tsx` verbatim: the pmtiles `Protocol` registration (lines 8–11), `FLORIDA_CENTER`, `NODES_SOURCE/LAYER`, `LINKS_SOURCE/LAYER`, `LINK_COLOR_EXPR`, `NodeProps`/`NodeFeature`, `escapeHtml`, `popupHtml`, `loadStyle`, `toFeatureCollection`, `toLinkFeatureCollection`, `fitToPositioned`, the three map `useEffect`s, `refit`, and the map JSX. Changes while moving:
  - The component is ALWAYS mounted — delete every `view !== "map"` guard and the `view` dep from the three effects (the lifecycle effect now runs once on mount: deps `[onOpenDetail]`).
  - Update `LINK_COLOR_EXPR` colors to Meridian status values (MapLibre expressions can't read CSS vars): null → `"#566275"` (neutral slate), `>=5` → `"#28a860"`, `>=-5` → `"#e8a13a"`, else `"#d83c3c"`.
  - Node dots: `"circle-color": "#ffb020"`, `"circle-stroke-color": "#0a0e13"` (amber markers on the dark map — the radar-console signature).
  - Panel JSX:

```tsx
export function MeshMap({ nodes, stale, showOffline, onOpenDetail }: {
  nodes: Node[]; stale?: boolean; showOffline: boolean; onOpenDetail: (id: string) => void;
}) {
  // ...state/refs/effects moved from Nodes.tsx...
  const positioned = nodes.filter(n => n.lat != null && n.lon != null && (showOffline || !isOffline(n)));
  return (
    <section className="panel map-hero">
      <div className="panel-h">
        <span className="t">Mesh map</span><span className="n">{positioned.length} nodes positioned · offline basemap</span>
        {stale && <span className="tag stale">STALE</span>}
        <span className="right">
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
```

- [ ] **Step 2: Strip `Nodes.tsx` to table-only** — delete the maplibre/pmtiles imports, all constants/helpers/effects/refs moved in Step 1, the `view`/`mapReady`/`showLinks` state, and the Map/Table/FIT/Links buttons. Keep: sort machinery, `ago/battClass/sig`, offline toggle, the table JSX, `onSelectNode`/`onOpenDetail`. Panel header becomes: title `Mesh nodes`, count, STALE tag, offline checkbox only.

- [ ] **Step 3: Map hero CSS** — add to `styles.css` (map section):

```css
.map-hero { display: flex; flex-direction: column; min-height: 0; }
.map-hero-body { position: relative; flex: 1; min-height: 520px; }
.map-hero-body .map { position: absolute; inset: 0; background: var(--panel-2); }
@media (max-width: 1100px) { .map-hero-body { min-height: 380px; } }
@media (max-width: 600px)  { .map-hero-body { min-height: 300px; } }
```

- [ ] **Step 4: Temporary wiring so the app still runs** — in `App.tsx`, render `<MeshMap nodes={nodes.data?.items ?? []} stale={nodes.stale} showOffline={showOffline} onOpenDetail={setDetailNode} />` above the existing grid (final layout lands in Task 5).

- [ ] **Step 5: Build + behavior check** — `npm run build` passes; in the browser: map renders tiles + amber dots, hover popup, click-dot opens detail drawer, FIT refits, Links toggle draws SNR-colored edges, node table still sorts/DMs/opens detail, offline toggle affects both.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "refactor(meridian): extract always-mounted MeshMap hero from Nodes; Nodes goes table-only"`

---

### Task 3: Vitals strip — the signature element

**Invoke the `dataviz` skill BEFORE this task's styling** (stat tiles/KPI row trigger). Reuse the validated palette; no charts in Phase 1.

**Files:**
- Create: `frontend/src/components/Vitals.tsx`
- Delete: `frontend/src/components/Stats.tsx`
- Modify: `frontend/src/styles.css` (replace the `.stats` block with `.vitals`)

**Interfaces:**
- Consumes: `Status`, `Stats`, `Node`, `isOffline` from `../api`.
- Produces: `Vitals({ status, stats, nodes }: { status: Status | null; stats: StatsData | null; nodes: Node[] })`.

- [ ] **Step 1: Write `Vitals.tsx`**

```tsx
import type { Node, Status, Stats as StatsData } from "../api";
import { isOffline } from "../api";

// The signature mesh-vitals strip: glanceable radio-console readouts.
// All values derive client-side from data the app already polls.
export function Vitals({ status, stats, nodes }: { status: Status | null; stats: StatsData | null; nodes: Node[] }) {
  const online = nodes.filter(n => !isOffline(n));
  const direct = online.filter(n => n.hops === 0);
  // Weakest direct RF link: min SNR across online hops==0 nodes that report one.
  const withSnr = direct.filter(n => n.snr != null);
  const weakest = withSnr.length ? withSnr.reduce((a, b) => (a.snr! <= b.snr! ? a : b)) : null;
  const now = status?.now ?? Date.now() / 1000;
  const snapAge = status?.last_node_update != null ? Math.round(now - status.last_node_update) : null;
  const num = (v: number | null | undefined) => (v == null ? "—" : v);
  const radioOk = status?.bridge?.ok ?? null;
  return (
    <div className="vitals" role="status" aria-label="Mesh vitals">
      <div className="vital"><span className="k">Nodes online</span><span className="v">{online.length}<small>/ {nodes.length}</small></span><span className="sub"><span className="up">{direct.length} direct</span> · rest via hops</span></div>
      <div className="vital"><span className="k">Weakest link</span><span className="v">{weakest ? `${weakest.snr} dB` : "—"}</span><span className="sub">{weakest ? `${weakest.short_name ?? weakest.node_id} · direct RF` : "no direct SNR yet"}</span></div>
      <div className="vital"><span className="k">Messages · 24h</span><span className="v">{num(stats?.msgs_24h)}</span><span className="sub">{stats ? `${stats.in_24h} in · ${stats.out_24h} out` : "loading…"}</span></div>
      <div className="vital"><span className="k">AI queries · 24h</span><span className="v">{num(stats?.ai_24h)}</span><span className="sub">via @ai</span></div>
      <div className="vital"><span className="k">Radio link</span><span className={radioOk == null ? "v" : radioOk ? "v up" : "v down"}>{radioOk == null ? "—" : radioOk ? "OK" : "DOWN"}</span><span className="sub">bridge → radio</span></div>
      <div className="vital"><span className="k">Snapshot</span><span className={snapAge != null && snapAge > 300 ? "v down" : "v"}>{snapAge == null ? "—" : `${snapAge}s`}</span><span className="sub">node data age</span></div>
    </div>
  );
}
```

- [ ] **Step 2: Vitals CSS** — replace the `.stats/.stat` block:

```css
/* ---------- mesh-vitals strip (signature) ---------- */
.vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.vital {
  background: var(--panel); border: 1px solid var(--line-soft); border-radius: 3px;
  border-top: 2px solid var(--accent-dim);
  padding: 10px 14px; display: flex; flex-direction: column; gap: 2px;
}
.vital .k { font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em; color: var(--faint); text-transform: uppercase; }
.vital .v { font-family: var(--mono); font-size: 22px; font-variant-numeric: tabular-nums; color: var(--text); }
.vital .v small { font-size: 12px; color: var(--muted); margin-left: 4px; }
.vital .sub { font-size: 11.5px; color: var(--muted); }
@media (max-width: 600px) { .vitals { grid-template-columns: repeat(2, 1fr); } }
```
(The amber top rule is the restrained accent — one 2px line per tile, no amber numerals. `.up`/`.down` value coloring keeps its icon-free OK/DOWN **text** so status is never color-alone.)

- [ ] **Step 3: Swap it in** — `App.tsx`: replace the `Stats` import/usage with `Vitals` (same props). Delete `Stats.tsx`.

- [ ] **Step 4: Build + cross-check values** — `npm run build`; in the browser verify Nodes online + weakest link against the API: `curl -s localhost:8420/api/nodes | python -c "..."` on aibox or the browser devtools — the tile numbers must match a hand count of the JSON (online = last_heard within 7200s; weakest = min snr among hops==0 online).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(meridian): mesh-vitals strip — nodes online, weakest direct link, 24h traffic, radio health"`

---

### Task 4: Header rebrand + Open MeshMonitor deep link

**Files:**
- Modify: `frontend/src/components/Header.tsx`

**Interfaces:**
- Produces: same `Header({ status, unreachable })` signature; only presentation changes.

- [ ] **Step 1: Rebrand the header JSX** (status-level logic stays byte-identical):

```tsx
  return (
    <header>
      <div className="brand"><b>MERIDIAN</b><span>mesh command center · {status?.bridge?.node ?? "RZRB"} · aibox</span></div>
      <span className={`badge-live lvl-${level}`}><span className="dot" />{label}</span>
      <div className="hdr-right">
        <a className="tab ext" href="https://meshmonitor.meshnomad.ai" target="_blank" rel="noopener noreferrer" title="Radio owner UI — config, channels, packet admin">MeshMonitor ↗</a>
        <span>{new Date().toLocaleString()}</span>
      </div>
    </header>
  );
```

- [ ] **Step 2: Link style** — add to `styles.css` header section: `.tab.ext { text-decoration: none; display: inline-flex; align-items: center; }`

- [ ] **Step 3: Build + check** — `npm run build`; header reads MERIDIAN, badge behavior unchanged, MeshMonitor opens in a new tab.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(meridian): header rebrand + MeshMonitor deep link"`

---

### Task 5: Command-center layout

**Invoke `frontend-design` for this task.**

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css` (grid + responsive)

**Interfaces:**
- Consumes: `MeshMap`, `Vitals`, `Feed`, `Nodes`, `Header`, `LogPanel`, `NodeDetail` as defined in Tasks 2–4.

- [ ] **Step 1: New `App.tsx` return** (state/polling identical to today):

```tsx
  return (
    <div className="wrap">
      <Header status={status.data} unreachable={status.stale} />
      <Vitals status={status.data} stats={stats.data} nodes={nodes.data?.items ?? []} />
      <div className="cmd-grid">
        <MeshMap nodes={nodes.data?.items ?? []} stale={nodes.stale} showOffline={showOffline} onOpenDetail={setDetailNode} />
        <div className="chat-rail">
          <Feed
            items={feed.data?.items ?? []} nodes={nodes.data?.items ?? []} stale={feed.stale}
            dmTarget={dmTarget} onDmTargetChange={setDmTarget} showOffline={showOffline}
          />
        </div>
      </div>
      <div className="lower-grid">
        <Nodes
          items={nodes.data?.items ?? []} stale={nodes.stale}
          onSelectNode={(id) => setDmTarget(id)}
          onOpenDetail={setDetailNode}
          showOffline={showOffline} onToggleOffline={() => setShowOffline(v => !v)}
        />
        <LogPanel items={log.data?.items ?? []} stale={log.stale} />
      </div>
      {detailNode && <NodeDetail nodeId={detailNode} onClose={() => setDetailNode(null)} onDm={(id) => { setDmTarget(id); setDetailNode(null); }} />}
    </div>
  );
```

- [ ] **Step 2: Grid CSS** — replace the `.grid/.col` block:

```css
/* ---------- command-center grid ---------- */
.wrap { max-width: 1600px; }
.cmd-grid { display: grid; grid-template-columns: minmax(0, 8fr) minmax(0, 4fr); gap: 14px; align-items: stretch; }
.chat-rail { display: flex; flex-direction: column; min-width: 0; }
.chat-rail .panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.chat-rail .feed { flex: 1; max-height: none; min-height: 0; }
.lower-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 14px; align-items: start; }
.nodes-panel .tbl-wrap { height: 420px; }
@media (max-width: 1100px) {
  .cmd-grid, .lower-grid { grid-template-columns: 1fr; }
  .chat-rail .feed { max-height: 52vh; }
}
```
Remove the now-dead `.grid`/`.col` rules and the old `.nodes-body` absolute-positioning block if nothing references them after Task 2.

- [ ] **Step 3: Build + full-viewport checks** — `npm run build`; verify at 1600/1280 (map hero left ≈ 2/3, chat rail right full-height, vitals across the top, nodes+log below), at 900 (stacked: map → chat → nodes → log), at 390 (single column, mobile header wrap, table columns hidden per existing ≤600px rules).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(meridian): command-center layout — map hero, chat rail, vitals strip, nodes+log row"`

---

### Task 6: QA against real data + code review

- [ ] **Step 1: Local stack on a real memory.db snapshot** — extract from the nightly backup pull:

```bash
SCRATCH="/c/Users/ABDIGI~1/AppData/Local/Temp/claude/C--Users-AB-Digial/515c4f0a-bed0-4412-b935-ad006c3ef50f/scratchpad"
mkdir -p "$SCRATCH/meridian-qa" && cd "$SCRATCH/meridian-qa"
tar -xzf /c/Backups/aibox/latest.tgz --wildcards '*memory.db*' 2>/dev/null; find . -name 'memory.db'
```
Run backend (from repo `backend/`, reuse the monorepo venv): `MEM_DB=<extracted path> SEND_TOKEN=dev BRIDGE_URL=http://127.0.0.1:1 ../../project-nomad/mesh-dashboard/backend/.venv/Scripts/python.exe -m uvicorn app:app --port 8000`, then `npm run dev` (vite proxies `/api` per `vite.config.ts`). Maps are absent locally (`/maps` 404) — the map panel styling still verifies; tiles verify on the live deploy.

- [ ] **Step 2: Playwright pass (MCP)** — desktop 1440×900 and mobile 390×844 screenshots of `http://localhost:5173`; exercise: feed scroll, self/AI filters, node sort, offline toggle, click-to-DM populates SendBox, detail drawer, send-box validation (byte counter, empty reject). Compare screenshots against the spec layout diagram (§6).

- [ ] **Step 3: Backend tests still green** — `cd backend && <venv python> -m pytest tests/ -q` → `32 passed` (proves zero backend drift).

- [ ] **Step 4: Code review** — invoke `superpowers:requesting-code-review` + `/code-review` on the branch diff; the adversarial pass (execution-realist) reviews the result against the DoD. Fix findings; commit fixes.

---

### Task 7: Deploy `:v13` + live verification

- [ ] **Step 1: Sync repo → aibox build dir** (build dir only, NOT the radio host path):

```bash
cd "/c/Users/AB Digial/projects/nomad-mesh-dashboard"
tar --exclude=node_modules --exclude=.git --exclude=dist --exclude='backend/.venv' -czf /tmp/meridian.tgz .
scp /tmp/meridian.tgz aibox:/tmp/ && ssh aibox "cd ~/mesh-dashboard && rm -rf ./* && tar -xzf /tmp/meridian.tgz && docker build -t ghcr.io/aebconsulting/nomad-mesh-dashboard:v13 ."
```

- [ ] **Step 2: HAND TO AARON — ghcr push (classifier blocks the agent):**

```bash
ssh aibox "docker push ghcr.io/aebconsulting/nomad-mesh-dashboard:v13"
```
(Package must stay public — NOMAD pulls anonymously.)

- [ ] **Step 3: NOMAD PUT to `:v13`** — GET `/api/system/services/custom/nomad_custom_mesh_dashboard` → `.app`, set `image: ...:v13`, PUT `/api/system/services/custom` with the FULL config + `force:true`; poll `docker inspect nomad_custom_mesh_dashboard --format '{{.Config.Image}}'` until `:v13`. Rollback = PUT back to `:v12` (image stays local).

- [ ] **Step 4: Live verification (evidence, not inference)** —
  - API: `/api/stats`, `/api/nodes`, `/api/neighbors` → 200 via `https://dashboard.meshnomad.ai`.
  - Playwright on the live URL: desktop + mobile screenshots show the Meridian layout with live node counts; map tiles render (PMTiles range requests OK); Links toggle draws edges.
  - **Working send:** DM `@ai <test>` to the base node via the UI; confirm the reply arrives in the feed (bridge round-trip proven). No channel-0 broadcast noise.
  - Vitals numbers cross-checked against `/api/nodes` JSON.

- [ ] **Step 5: Commit any deploy-doc tweaks; tag** — `git tag v13 && git log --oneline -1`

---

### Task 8: Repo/docs settlement

- [ ] **Step 1: Sync the monorepo mirror** — `rsync`/`cp` the changed `frontend/` + `Dockerfile` (minus OCI labels? no — keep trees identical except labels: copy everything except keep each side's Dockerfile) from the canonical repo to `projects/project-nomad/mesh-dashboard/`; run `pytest` there; commit in the home repo.
- [ ] **Step 2: Update CLAUDE.md** (mesh-dashboard bullet): canonical repo = standalone `nomad-mesh-dashboard`, image `:v13` = Meridian Phase 1, monorepo dir = build mirror.
- [ ] **Step 3: Push the canonical repo** — `git push origin main` (coordinate with the doc-finalizing session first).
- [ ] **Step 4: Invoke `superpowers:verification-before-completion`** and re-check the Phase 1 DoD line by line.

---

## Phases 2–4 (separate plans when reached)

- **Phase 2 — telemetry + env graphs:** memory.db `telemetry` EAV + `env_log` → dataviz-compliant charts (categorical palette fixed order; single-axis; crosshair+tooltip). Add the palette validator to CI here.
- **Phase 3 — MeshMonitor `/api/v1` panels:** channels, packet monitor, extra telemetry; per-panel "MeshMonitor data unavailable" states; read token config (`MESHMONITOR_API_URL` + token env).
- **Phase 4 — polish:** deep links, light mode (validated separately), PWA, full mobile-QA sweep.
