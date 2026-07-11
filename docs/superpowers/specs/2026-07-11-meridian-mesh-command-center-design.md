# Meridian — NOMAD Mesh Command Center — Design Spec

**Date:** 2026-07-11 · **Status:** Draft for review · **Supersedes:** the "fork MeshMonitor" idea (rejected — see Decision Record)

## 1. Goal
Evolve the existing `nomad-mesh-dashboard` into **Meridian**, one distinctive command-center UI for the off-grid LoRa mesh: the chat-next-to-map layout, plus the feature depth the other displays (MeshMonitor, the official web client) expose — built as a **decoupled companion** that reads data and never touches MeshMonitor's code.

## 2. Decision Record (why this shape)
- MeshMonitor was adopted to STOP maintaining a custom mesh UI and to keep the sole radio owner on upstream `:latest` (security/protocol fixes keep flowing).
- A fork to re-layout MeshMonitor was pressure-tested (execution-realist) and **REJECTED**: it re-introduces the maintenance treadmill (worse — upstream owns the cadence), the manual ghcr-push is a human single-point-of-failure that freezes the fork, a stale fork as sole radio owner is a life-safety risk, and two Leaflet maps sharing one MapContext is a runtime bug — all to buy "a slightly different box arrangement."
- **Chosen (hater-blessed):** a decoupled, read-mostly companion that consumes MeshMonitor's data/API + the bridge's `memory.db`, never touches MeshMonitor's code. Total layout freedom, zero rebase treadmill, upstream stays pristine, and a bad deploy of Meridian cannot crash the radio owner.

## 3. Architecture
- **Decoupled companion.** React + Vite frontend + FastAPI backend (evolve `nomad-mesh-dashboard`). Own container behind Caddy (`dashboard.meshnomad.ai` vhost already exists).
- **Read-mostly.** Reads sources read-only; the ONLY write is the mesh send path (bridge `:8700` send API — @ai + mesh text). Never mutates MeshMonitor or radio config.
- **Isolation.** A Meridian outage cannot affect MeshMonitor (radio owner) or the bridge. It is a viewer plus a send button.

## 4. Data sources
| Source | Access | Provides |
|---|---|---|
| Bridge `memory.db` | sqlite read-only (`?mode=ro`) — already wired | messages, nodes + telemetry (v9/v10 cols), neighbors/topology, env/weather, @ai memory |
| MeshMonitor `/api/v1` | token-auth HTTP (read) | the feature superset MeshMonitor captures: channels, per-node telemetry series, packet-level, config *view* |
| Bridge `:8700` send API | HTTP POST (SEND_TOKEN) | send mesh text (channel + DM), @ai |
| MeshMonitor (deep link) | link out | config *edit*, security/keys, automation — NOT rebuilt (not in v1 API; not worth it) |

Rule: prefer `memory.db` for what it already has (lowest coupling); use `/api/v1` only for data `memory.db` lacks.

## 5. Feature scope
**In Meridian (the daily command center):**
- Nodes: list + detail (hw, role, battery, SNR, last-heard, position); online/offline filter
- Live chat: channels + DMs, send/receive, quoted replies (bridge stores mesh packet ids), unread counts
- Map: offline PMTiles basemap + node markers + neighbor-link topology overlay (already built) + live activity
- Telemetry: per-node + aggregate graphs (battery, SNR, chan-util, air-util-tx, env temp/humidity/pressure)
- Mesh-vitals strip (SIGNATURE): nodes online/total, weakest-SNR link, mesh health, queue/denial
- Env/weather panel (bridge `env_log`)
- Packet monitor (via MeshMonitor `/api/v1` if exposed; else defer to a later phase)

**Out of scope (deep-link into MeshMonitor):** config editing, security/key management, automation engine, MQTT admin, source management. MeshMonitor's job; Meridian links to them.

## 6. Layout (command center)
```
+-----------------------------------------------------------------------+
| HEADER: Meridian . connection/status . [Open MeshMonitor]             |
+-----------------------------------------------------------------------+
| MESH VITALS: 218/232 online . weakest link -12 SNR . health OK ...    |  <- signature strip
+---------------------------------------------+-------------------------+
|                                             |  CHAT (Feed)            |
|                MAP (hero)                    |  [channel / DM switch]  |
|   offline PMTiles + nodes + topology        |  messages ...           |
|                                             |  [SendBox]              |
+---------------------------------------------+-------------------------+
| NODES (list + filter)   | TELEMETRY tiles/graphs | ENV / packet panel |
+-----------------------------------------------------------------------+
```
- Map is the hero (a mesh is geographic). Chat is a persistent right rail. The vitals strip is the memorable element.
- Responsive: <=900px stacks map -> chat -> nodes -> telemetry; <=600px single column, node table collapses to a drawer (reuse existing mobile-QA patterns).

## 7. Design system — "Meridian"
Subject: a field radio at night. Distinctive; deliberately none of the AI-default looks.
- **Neutrals (dark):** base `#131923`, mantle `#0e131a`, crust `#0a0e13`, surfaces `#1c2431 / #27303f / #35404f`, text `#e8edf4`, subtext `#b7c2d2 / #94a1b5`.
- **Signature accent (amber phosphor):** `#ffb020` (radio-dial / CRT heritage — used with restraint).
- **Status (reserved; icon + label, never color-alone):** good/online `#28a860`, warning `#e8a13a`, serious `#d17f26`, critical `#d83c3c`.
- **Categorical series/markers (VALIDATED, dark, dataviz validator = ALL CHECKS PASS; L 0.48-0.67, CVD 13.1, contrast OK):**
  `#3f6fd0 blue, #28a860 green, #bd7320 amber, #9d5fd0 mauve, #1a9e93 teal, #d83c3c red, #2f95c8 sky, #c85f9e pink` — assigned in this FIXED order, never cycled; a 9th series folds into "Other."
- **Type:** display = a technical/mono face for headers + data readouts (radio/console heritage, restraint); body = a clean humanist sans; numerals = tabular/mono. (Pick specific faces in the plan; self-hostable/offline.)
- **Charts (dataviz rules):** pick-form-first; single-axis only (never dual); thin marks, 4px rounded data-ends, >=8px markers, 2px surface gaps; hover crosshair+tooltip by default; legend for >=2 series + selective direct labels; text in ink tokens, not series color. Light mode derived from the same ramps and validated separately (not an auto-flip).
- **Signature element:** the live mesh-vitals strip — glanceable, radio-console styling.

## 8. Prerequisites
- **P0 — Repo reconciliation (BLOCKER).** Two diverging copies exist: authoritative/ahead = `projects/project-nomad/mesh-dashboard` (has the map-topology commits; lives inside the monorepo, no own git); public/behind = `projects/nomad-mesh-dashboard` (own git, single "initial public release" commit). Before building: pick ONE canonical home (recommend the standalone public repo), fast-forward it to the deploy dir's current state, and make deploy/build flow from it. Building on a diverged base guarantees pain.

## 9. Error handling (reuse existing patterns)
- `memory.db` unmounted/missing -> loud 500 (existing guarded connect).
- MeshMonitor `/api/v1` down / token expired -> only the affected panels show a clear "MeshMonitor data unavailable" state; the rest of Meridian (memory.db-backed) keeps working. Never blank the whole page.
- Send path: 4 explicit delivery states, never blank (reuse the reply-feature review's rule).
- Stale data: existing `usePoll` `stale` flag drives per-panel staleness banners.

## 10. Testing
- Extend the existing Playwright mobile-QA harness (`scratchpad/mobile-qa`) for the new panels + breakpoints.
- Backend: contract tests per data adapter (memory.db reader + MeshMonitor v1 client) against fixture DBs/responses.
- Palette: run the dataviz validator in CI; fail the build on a non-passing categorical set.

## 11. Deployment
- Own container (evolve the existing dashboard image); NOMAD custom app or current deploy path. Caddy vhost `dashboard.meshnomad.ai` already exists -> point at Meridian.
- Config via env (mirror the existing dashboard contract): `MEM_DB`, `BRIDGE_URL`, `SEND_TOKEN`, plus new `MESHMONITOR_API_URL` + read token, `MAPS_DIR`/`BASEMAP_PMTILES`.

## 12. Phasing (ship value early; each phase independently shippable)
1. **Phase 1 — command-center shell + existing features, re-themed.** Meridian layout (map hero + chat rail + nodes + vitals) on `memory.db`, Meridian palette. This alone is "much nicer."
2. **Phase 2 — telemetry + env graphs** (memory.db telemetry EAV + `env_log`), dataviz charts.
3. **Phase 3 — MeshMonitor `/api/v1` panels** (channels, packet monitor, extra telemetry) — the feature superset.
4. **Phase 4 — polish:** deep-links into MeshMonitor, light mode, PWA, mobile-QA pass.
