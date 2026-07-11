# Next-session prompt — build "Meridian" (NOMAD Mesh Command Center)

> Paste the block below as the first message of a fresh session.

---

You are continuing a project designed in the previous session. Build **Meridian**, a distinctive command-center web UI for my off-grid LoRa mesh, by evolving the existing `nomad-mesh-dashboard`. It is a **decoupled companion** that only reads data and sends messages — it must NEVER touch MeshMonitor's code or the radio path.

## Read these first, in order
1. **The design spec (authoritative — architecture, data, layout, palette, phasing all here):**
   `C:\Users\AB Digial\projects\nomad-mesh-dashboard\docs\superpowers\specs\2026-07-11-meridian-mesh-command-center-design.md` (branch `docs/meridian-spec`).
2. **MeshMonitor adoption handoff (the data backend — read the TL;DR at top):**
   `C:\Users\AB Digial\projects\project-nomad\docs\HANDOFF-meshmonitor-eval.md`.
3. `CLAUDE.md` — all aibox / mesh / dashboard facts.

## The anchoring decision (do NOT re-litigate)
A fork of MeshMonitor to re-skin it was pressure-tested by the `execution-realist` hater and **rejected** (rebase treadmill, manual-ghcr single-point-of-failure, a stale fork owning the life-safety radio, two-Leaflet-maps runtime bug). Meridian is the hater-blessed alternative: a **decoupled, read-mostly companion** reading the bridge `memory.db` + MeshMonitor `/api/v1`, sending via the bridge `:8700`, touching MeshMonitor not at all. A Meridian outage cannot affect the radio owner. Keep it that way.

## Task
1. **P0 — reconcile the two dashboard repos (BLOCKER, do first).** Ahead/authoritative = `C:\Users\AB Digial\projects\project-nomad\mesh-dashboard` (inside the monorepo, has the map-topology commits, no own git). Behind/public = `C:\Users\AB Digial\projects\nomad-mesh-dashboard` (own git, only "initial public release"). Pick ONE canonical home (recommend the standalone public repo), bring it up to the deploy dir's current state, make deploy/build flow from it, and verify `dashboard.meshnomad.ai` still builds/runs after.
2. Run the **superpowers `writing-plans`** skill to turn the spec into a phase plan (brainstorming already produced the spec; writing-plans is the next step). Then execute Phase 1 first.
3. **Phase 1** (per the spec's phasing): the Meridian command-center shell + existing features, re-themed, on `memory.db` — map hero + persistent chat rail + node list + a live **mesh-vitals** signature strip, in the Meridian palette. Ship it, verify it live (desktop + mobile), then Phases 2 (telemetry graphs), 3 (MeshMonitor `/api/v1` panels), 4 (polish).

## Key facts
- **Meridian palette (dark, already VALIDATED with the dataviz validator — do not re-derive):** base `#131923`; surfaces `#1c2431 / #27303f / #35404f`; text `#e8edf4`, subtext `#b7c2d2 / #94a1b5`; accent (amber phosphor) `#ffb020`; status good `#28a860`, warn `#e8a13a`, critical `#d83c3c`; categorical series in FIXED order `#3f6fd0 #28a860 #bd7320 #9d5fd0 #1a9e93 #d83c3c #2f95c8 #c85f9e`.
- **Existing dashboard stack:** React + Vite frontend, FastAPI backend, reads `memory.db` read-only (`MEM_DB=/opt/mesh-ai-bridge/memory.db`), sends via `BRIDGE_URL=http://nomad_custom_mesh_ai_bridge:8700` + `SEND_TOKEN`, serves offline PMTiles maps. Live at `dashboard.meshnomad.ai` (Caddy vhost + UniFi DNS already exist). Components: `Header, Stats, Feed (chat), Nodes, NodeDetail, LogPanel, SendBox` (map is inline in `App.tsx`).
- **MeshMonitor data (the feature superset):** `/api/v1` token-auth — `/sources/{id}/nodes`, `/telemetry`, `/channels`, `/messages` (read + send). Mint a read token via MeshMonitor's api-token route (admin `VzUp9k0PqLb4A39YYfV9`). Its DB is `meshmonitor.db` in the `meshmonitor-eval-data` volume. Deep-admin screens (config edit, security/keys, automation) stay a DEEP LINK into MeshMonitor — not rebuilt.
## Skills to invoke (and when)
**Process (superpowers):**
- `superpowers:writing-plans` — FIRST: turn the spec into a phase plan.
- `superpowers:executing-plans` (or `superpowers:subagent-driven-development` for independent tasks) — execute with review checkpoints.
- `superpowers:test-driven-development` — write failing tests first for the backend data adapters.
- `superpowers:systematic-debugging` — any bug/unexpected behavior (find root cause, don't guess-fix).
- `superpowers:verification-before-completion` — before ANY "done" claim; verify live, never infer.
- `superpowers:requesting-code-review` + the `/code-review` skill — after each phase, before shipping.

**Design + implementation:**
- `dataviz` — MANDATORY before writing ANY chart/telemetry code (validate palettes with its script, single-axis, hover layer). The Meridian categorical palette above is already validated — reuse it, don't re-derive.
- `frontend-design` — the Meridian visual identity + layout (distinctive; avoid the AI-default looks).
- `senior-frontend` — React + Vite + TypeScript component build + performance.
- `senior-backend` — the FastAPI backend, the `memory.db` reader, and the MeshMonitor `/api/v1` client.
- `senior-qa` — extend the Playwright mobile-QA harness + backend contract tests.

**Adversarial review (standing ask):**
- The "hater" agents — `execution-realist` (execution/maintenance) and others as they fit — to pressure-test the plan BEFORE building and the result AFTER. (They already killed the fork idea; keep using them on big calls.)

## Hard constraints
- **Aaron runs all ghcr pushes, radio-host writes, and any MeshMonitor/radio reconfiguration** (the auto-mode classifier blocks the agent). The agent CAN: read-only inspect aibox, build images on the box, prepare code, and do NOMAD PUTs (the "controller does the PUT + verify" convention). Hand Aaron exact copy-paste commands for anything he must run.
- **Never touch MeshMonitor's code or the radio path.** Meridian is read-only + a send button.
- Life-safety mesh: verify every claim against live state; never report success from inference (CLAUDE.md rules).

## Definition of done (Phase 1)
A Meridian URL shows the command-center layout (map hero + chat rail + node list + mesh-vitals strip) in the Meridian dark palette, backed by live `memory.db` data, with working send, verified live on desktop + mobile. Repos reconciled. Zero change to MeshMonitor or the bridge's radio ownership.
