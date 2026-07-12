# Meridian Phase 5 — Delivery Tracking + AI Mesh-Analyst — Design Spec

**Date:** 2026-07-12 · **Status:** Draft for review · **Reviewed by:** execution-realist, meshtastic-domain, silent-failure-hunter, security (4 adversarial panels — findings folded in below)

## 1. Goal
Two capabilities, shipped as **two decoupled deploys**:
- **5a — Delivery tracking (bridge).** The mesh AI bridge records each outbound packet's id and its ACK/NAK state into `memory.db`, so Meridian can show honest per-message delivery status.
- **5b — AI mesh-analyst (Meridian).** An in-dashboard chat helper that explains signal strength and metrics using live node data and answers operator questions ("which router will hear me?", "did my message go through?"), backed by the same aibox-local LLM the mesh `@ai` uses — read-only, advisory-only, no radio path.

## 2. Anchoring decisions (settled — do not re-litigate)
- **wantAck on operator sends: YES.** Dashboard send sites gain `wantAck=True` so operator messages earn a real delivery signal. This IS a TX-behavior change (destination transmits an ACK; sender firmware retransmits ≤3× on silence — modest extra airtime), owned explicitly. @ai replies already use wantAck.
- **DM privacy: DMs stay visible.** Solo operator on a home LAN behind Caddy; matches today's `/api/feed` behavior. (The `facts` and `messages` tables are still excluded from the analyst pack — see §7.)
- **Sequencing: decoupled.** Bridge `:v5` ships first and soaks (verify ACK rows actually land via live query) before dashboard `:v16`. The analyst has zero hard dependency on the bridge; only the glyphs do, and they degrade cleanly.
- **Analyst reuses the main @ai brain** (aibox-local Qwen3-30B instruct, Ollama `:11434/v1`) — same model/identity as the mesh assistant, but a separate non-RF call path (web questions never transit the radio).

## 3. THE GATE — live radio probe before any bridge code (BLOCKER)
This is the third plan in this project written against assumed radio behavior; the prior two were refuted by live data. Before writing 5a, **Aaron runs one throwaway probe** (~15 min, mesh briefly in use, 2nd device):
- `iface.sendText("probe", destinationId=<2nd device>, wantAck=True)` through the VNS; capture the returned packet `.id`.
- Subscribe to `meshtastic.receive`; dump every packet where `decoded.portnum == "ROUTING_APP"`.
- **Confirm:** a routing packet returns with `decoded.requestId == <returned .id>`, `decoded.routing` has no `errorReason` on success (present = NAK), and `packet["from"] == <2nd device num>` for the real end-to-end ACK.
- Repeat with a **broadcast** wantAck send: confirm the implicit ACK arrives with `from == my_num` (relay/self), distinguishable from the DM case.

**Domain review (verified against meshtastic-2.7.10 source + MeshMonitor VNS source):** the id is minted client-side and survives the VNS byte-intact; the VNS forwards all FromRadio including ROUTING_APP; the mechanism *should* hold. The probe confirms the python↔VNS handshake on the live box — the one thing unverifiable from source. **If the probe fails, 5a stops here** and we reconsider; 5b (analyst) can still ship on today's data with honest "delivery not tracked" answers.

## 4. Phase 5a — Bridge delivery tracking

### 4.1 Schema (additive, duplicate-column-safe migration — the v9 pattern)
`msg_log` gains:
- `mesh_id INTEGER` — the packet id `sendText` returns (raw wire id).
- `ack_state TEXT` — NULL (no signal yet) · `radio-accepted` (local transmit ACK) · `ack` (DM, real end-to-end) · `relayed` (broadcast, neighbor rebroadcast) · `failed:<reason>` (NAK, reason = firmware enum e.g. `NO_ROUTE`/`MAX_RETRANSMIT`).
- Index `msg_log(mesh_id)`.
Migration guarded with `ALTER … except "duplicate column name"` (v9-proven). Raw wire id kept alongside the resolved row id.

### 4.2 Send-then-log — one helper, three phases (replaces the 4 send sites)
The two AI-reply lambdas currently log-then-send (a raised `sendText` logs a phantom "sent"); naive inversion flips it to the opposite lie (send succeeds, id-extraction raises → 502 → operator resends a message that already went out on a life-safety mesh). One helper separates the phases:
```python
def _send_and_log(send_fn, node_id, node_name, ch, is_dm, is_ai, text):
    try:
        pkt = send_fn()                       # phase 1: RADIO. failure here = real send failure
    except Exception:
        log_traffic("out", node_id, node_name, ch, is_dm, is_ai, text,
                    mesh_id=None, ack_state="failed")   # attempt RECORDED, glyph=failed (never blank)
        raise                                  # SendHandler still maps to 502
    mesh_id = getattr(pkt, "id", None)         # phase 2: id extraction can NEVER fail the send
    if mesh_id is None: _sends_without_id += 1 # health counter — a permanently glyphless DM is tracked
    log_traffic("out", node_id, node_name, ch, is_dm, is_ai, text,
                mesh_id=mesh_id, ack_state=None)         # phase 3: log_traffic already never raises
    return pkt
```
All 4 sites route through this. Dashboard send sites (currently no wantAck) gain `wantAck=True` per §2. Startup `hasattr` smoke check on the meshtastic lib → one loud line at boot if the API shape is wrong (not 100% id-less sends discovered weeks later).

### 4.3 ACK correlation — pubsub, exact requestId (NOT onResponse)
`onResponse`/`onAckNak` is a **trap**: its handler is one-shot and firmware sends TWO routing packets per wantAck DM (transmit-ACK first, real end-to-end ACK second) — the callback latches the transmit-ACK as "delivered" (the false-success bug MeshMonitor itself had to fix). Instead, one isolated co-subscriber (the `on_neighbor` pattern), fully try/except-wrapped:
- Subscribe `meshtastic.receive`, filter `decoded.portnum == "ROUTING_APP"`.
- Read `decoded.requestId`, `decoded.routing.errorReason` (absent = success), `packet["from"]`.
- State machine per outstanding send: `errorReason` present → `failed:<reason>`; success ACK with `from == dest` → `ack` (DM); success with `from == my_num`/relay → `relayed` (terminal for broadcast, transient for DM); local transmit ACK → `radio-accepted`.
- **Exact match, recency-fenced** (the reused-uint32 guard):
  ```sql
  UPDATE msg_log SET ack_state=? WHERE mesh_id=? AND direction='out'
    AND ack_state IS NULL AND ts > (strftime('%s','now') - 300)
  ORDER BY ts DESC LIMIT 1
  ```
  `rowcount == 0` → orphan ACK: increment a counter, don't fall back to "most recent."

### 4.4 Observability (fail-loud, not fail-silent)
The never-raise wrapper must not turn a dead subsystem into permanent "no glyph." Module-global counters exposed in the bridge `/api/health` (which `/api/status` already embeds → free to the frontend): `acks_seen`, `acks_matched`, `ack_orphans`, `ack_db_errors`, `sends_without_id`, `last_ack_ts`. One-shot loud log on first matched ACK ("ACK TRACKING CONFIRMED — matched msg_log row N"). `ack_db_errors` incremented **before** the log call (survives a log-format throw).

### 4.5 Deploy + soak
Bridge image `:v5` via NOMAD health-gated update (PUT full config, never POST /update). **Soak 24–48h; verify with a fresh live query** that ACK rows land: `SELECT ack_state, COUNT(*) FROM msg_log WHERE ts > … GROUP BY 1`. Rollback = stop container + prior tag (bridge `:v4`). Aaron runs the ghcr push and any radio-host write; the auto-mode classifier blocks the agent from both.

## 5. Phase 5b — Meridian AI mesh-analyst

### 5.1 Backend `/api/assistant` (mirror `/api/send`'s trust shape)
POST, requires `X-Mesh-Dashboard` CSRF header, own rate-limit bucket (separate from send), **concurrency gate = 1** (an in-flight flag → 429 "analyst busy" when occupied) so the analyst can never starve the mesh `@ai` lifeline. Server-side hard caps: question ≤ 500 chars, fixed model + fixed Ollama URL + fixed endpoint (no user-supplied model — that would expose Ollama pull/delete), explicit `options.num_ctx`, output `max_tokens`, httpx `timeout` (60–120s → 504 "analyst timed out (shared with mesh replies)").

### 5.2 Context pack — deny-by-default, public-only, deterministic budget
The pack defines the exfiltration blast radius (a visitor can ask the model to repeat its context). Rules:
- **Only data already public on the anonymous dashboard**: the rows `/api/nodes`, `/api/stats`, `/api/feed` already return. **Exclude the `facts` and `messages` tables** (private @ai memory; `get_facts()` is global/un-scoped — never reaches the pack).
- **Precompute every aggregate server-side** (count online, min/max/avg SNR, worst-battery node, nearest routers by SNR/hops, per-message `ack_state`) and put the *answers* in the pack — the model narrates, never calculates (kills confident-wrong-arithmetic).
- **Deterministic char budget** (the bridge `LIBRARY_CONTEXT_CHARS` break-on-budget pattern): hard caps (top ~40 nodes by last_heard, routers first; last ~30 outbound), and state the window in the prompt itself ("20 of 235 nodes shown, lowest battery first") so the model says "of the nodes I can see."
- RF-authored strings (`long_name`, message text) fenced in a labeled **data role, never system**; length-capped; control chars stripped. This is defense-in-depth — the real control is §5.4.
- Verify `usage.prompt_tokens` against `num_ctx`; if within ~5%, log/flag (Ollama silently truncates from the front — dropping the guardrail system prompt first).

### 5.3 Guardrail system prompt
Answer only from the supplied data; label measured vs inferred; **never state delivery as fact** — use the honest vocabulary ("radio acknowledged, not confirmed read"; "relayed by a neighbor"); say plainly when the data can't answer; plain text, no markdown.

### 5.4 Security controls (structural — string filtering is theater)
The analyst is safe by **capability + data scope**, not by sanitizing hostile strings:
- **Can't act:** no tool/function-calling, no code path from analyst output to `/api/send`, no automation keyed on analyst text, no "send this suggestion" button. The air-gapped input is the control.
- **Can't render markup:** answer rendered as **plain text** (`textContent`, never `dangerouslySetInnerHTML`) + strict **CSP** (`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'`). An XSS in this origin = radio takeover (same-origin JS knows the CSRF header, can call `/api/send`), so this is the top control.
- **Can't see private data:** §5.2 pack scoping.
- **Ephemeral:** Q&A kept in session state only — never persisted to `memory.db`, never echoed to other viewers (that would make one visitor's injected prompt stored-injection served to the operator).

### 5.5 Frontend
Left rail gains **FEED / ANALYST** tabs (one surface, no layout change). Analyst view: teal `--ai` accent, persistent banner "Local analysis · nothing here transmits to the mesh", its own input (no path to SendBox), conversation in session state, loud error bubbles (checks `res.ok`, renders the `detail` string — a 502/504/429 must never render blank). Feed messages gain delivery glyphs from `ack_state` (§6).

## 6. Delivery glyphs (the honest state machine)
Rule: **absent/NULL = no glyph** (never a fake state). Wording never contains "delivered":
- `radio-accepted` → ✓ "radio accepted" · `ack` (DM) → ✓✓ "radio acknowledged — not confirmed read" · `relayed` (broadcast) → ↻ "relayed by a neighbor — not delivery confirmation" (distinct glyph from ✓✓) · `failed:<reason>` → ✗ with the reason in the tooltip.
- Client-side aging: a DM still NULL ~90s past send renders "no confirmation" (presentation only — never written to the DB), distinct from blank and from failed.
- Multi-chunk AI replies: one glyph per row (each chunk is its own feed line, its own state).

## 7. Version-skew safety (`/api/feed` must not 500 on an old DB)
Dashboard v16 deployed before bridge v5 (or a bridge rollback) = `msg_log` without `ack_state` → every `/api/feed`/`/api/log`/pack query 500s (the whole feed goes dark). **Feature-detect** (`PRAGMA table_info(msg_log)`, short-TTL cached): if `ack_state` absent, select without it, return `ack_state: null` + a top-level `"delivery_tracking": false` flag; frontend shows a one-line "delivery tracking unavailable (bridge pre-v5)" notice. Never COALESCE-and-hide (that's indistinguishable from "no ACKs yet").

## 8. Error handling (fail-loud everywhere new)
- `/api/assistant`: connection-refused/model-not-loaded → 502 with Ollama's error detail; empty-after-`<think>`-strip → 502 "empty answer (think leak)"; timeout → 504; rate/concurrency → 429 — **all rendered as visible bubbles** (a 200 with empty answer is forbidden).
- ACK subscriber: every failure path increments a counter and is visible in `/api/health`; stale `last_ack_ts` with outbound DMs present → "delivery tracking degraded" banner (distinct from per-message glyph absence).

## 9. Testing
- **5a bridge:** unit tests for `_send_and_log` (send raises → failed row; id-less pkt → counter + NULL row; happy → mesh_id set), ACK state machine (DM ack / broadcast relayed / NAK reason / orphan rowcount=0), migration idempotency. **Live:** post-soak query proves rows land.
- **5b backend:** contract tests for the context packer (public-only, budget cap, aggregates precomputed, facts/messages excluded) and `/api/assistant` against a **mocked** Ollama (happy, 502, timeout, empty-answer, num_ctx-near-cap flag, concurrency 429) on the fixture DB. Feature-detect test: pre-migration DB → `/api/feed` 200 with `delivery_tracking:false`, not 500.
- **UI:** Playwright both viewports — FEED/ANALYST toggle, error bubble on backend 502, glyph rendering per state, banner on the pre-v5 flag. CSP header present; answer renders injected markup inert.

## 10. Deployment order
1. Probe (§3) — Aaron. GO/NO-GO gate.
2. Bridge `:v5` — build on aibox, Aaron pushes ghcr, agent PUTs NOMAD. Soak 24–48h, verify live.
3. Dashboard `:v16` — includes 5b + the already-committed Combined-Log restrict-to-filter change; standard build→push→PUT. Feature-detect means it's safe even if run against a pre-v5 DB.
Rollbacks independent: bridge `:v4`, dashboard `:v15`.

## 11. Out of scope (deliberately)
Real dashboard auth (the anonymous-read model is the root weakness; a shared operator secret would collapse most of the threat model — revisit if the dashboard is ever Cloudflare-tunneled). Reactions/replies (separate feature). MeshMonitor `/api/v1` ACK source (the bridge is the ACK owner here). No automation keyed on ACK or analyst output — ever.
