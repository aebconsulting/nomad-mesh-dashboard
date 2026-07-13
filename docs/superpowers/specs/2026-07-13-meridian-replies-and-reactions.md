# Meridian Phase 6 — Replies & Reactions (design spec)

**Written:** 2026-07-13. **Status:** SPEC — awaiting Aaron's review before any build.
**Builds on:** bridge v11 (image `mesh-ai-bridge:v5`, delivery tracking LIVE) and dashboard v21
(`nomad-mesh-dashboard:v21`, node→map linking LIVE). Supersedes the protocol/wiring sections of
`HANDOFF-reply-feature.md` (2026-07-08), which predates Phase 5a — outbound `mesh_id` capture it
called for already exists.

## Goal

From the Meridian feed, an operator can:
1. **Reply to a specific message** — Discord-style quoted reply, carried on the mesh as a
   first-class Meshtastic reply (`reply_id`), so official apps (and RZRD) render the quote too.
2. **React to a message** with an emoji tapback (`emoji` flag + `reply_id`), rendered as
   reaction chips under the target message instead of cluttering the feed.
3. **See** inbound replies (quoted header) and inbound reactions (chips) that other mesh users
   send — including reactions to the bridge/AI/dashboard's own messages.

## Protocol facts (verified live 2026-07-13 on the running bridge container, meshtastic 2.7.10)

- `MeshInterface.sendText(text, destinationId, wantAck, ..., replyId: Optional[int], hopLimit)`
  — **`replyId` is a first-class param**. Quoted replies need no custom packet work.
- `sendData(..., replyId)` sets `meshPacket.decoded.reply_id` but **never sets `decoded.emoji`**
  — NO public API sends a tapback. The tapback path must hand-build the `MeshPacket` exactly as
  `sendData` does (channel, `decoded.payload`, `decoded.portnum=TEXT_MESSAGE_APP`,
  `id=self._generatePacketId()`, `decoded.reply_id`, priority RELIABLE) **plus
  `decoded.emoji = 1`**, then call `iface._sendPacket(pkt, destinationId=..., wantAck=True)`.
  `_sendPacket` returns the packet with `.id` populated (same contract `_send_and_log` relies on).
- `mesh_pb2.Data` fields: `portnum, payload, want_response, dest, source, request_id, reply_id,
  emoji, bitfield` — `reply_id`/`emoji` confirmed present.
- Inbound: the pubsub packet dict is protobuf-camelCase with **defaults omitted** —
  `packet["decoded"].get("replyId")` is absent (None) on normal messages; a tapback arrives as
  `portnum=TEXT_MESSAGE_APP` with `decoded.emoji` truthy, `decoded.replyId` = target packet id,
  and `decoded.text` = the emoji character(s). (Live evidence: the 👍 from `!6985f458` on
  2026-07-13 morning sits in the feed as a bare message today.)
- `reply_id` is packet METADATA — it does not consume the 190-byte LoRa text budget. A tapback's
  payload is just the emoji char (1–8 bytes).

## Current state deltas (what the 2026-07-08 handoff missed)

- `msg_log` ALREADY has `mesh_id` + `ack_state` (v11/5a) and **outbound sends already capture
  `packet.id`** via `_send_and_log` (that's how delivery glyphs work). Do NOT re-add.
- **Inbound rows do NOT store `mesh_id`** — `on_receive` line `log_traffic("in", ...)` passes no
  mesh_id even though `packet["id"]` is read two lines later for dedup. This is the gap that
  makes replying to OTHER PEOPLE's messages impossible today.
- No `reply_to_id`, no reaction awareness, send API accepts only `{text, to, channel}`.
- Dashboard `/api/feed` already feature-detects `ack_state` (`delivery_tracking` flag) — the same
  pattern extends to the new columns.

## Design

### Bridge v12 (image `mesh-ai-bridge:v6`) — all changes additive, gate-review before deploy

**Schema** (idempotent `_add_cols`, same as v9/v11 migrations):
- `msg_log` + `reply_to_id INTEGER` (mesh packet id this message replies/reacts to; NULL = none)
- `msg_log` + `is_reaction INTEGER` (1 = emoji tapback; NULL/0 = normal message)
- `CREATE INDEX IF NOT EXISTS idx_msg_log_reply_to ON msg_log(reply_to_id)`
- Old rows stay NULL; replies/reactions only resolve against messages logged after upgrade.
- Reactions live IN `msg_log` flagged `is_reaction=1` (single write path through `log_traffic`),
  NOT a separate table — the handoff's `reactions` table idea is rejected: two write paths, and
  the feed API would need a join anyway.

**Inbound (`on_receive`)** — one changed call:
- `log_traffic("in", ..., mesh_id=packet.get("id"), reply_to_id=dec.get("replyId"),
  is_reaction=1 if dec.get("emoji") else None)` — every inbound text row now carries its packet
  id, its reply target if any, and the tapback flag.
- A tapback is logged and then **returns before the @ai path** (an emoji is never a query; today
  a "👍" DM at the AI would burn an LLM slot).
- `log_traffic` gains the two kwargs (default None) — INSERT extends accordingly. Never raises
  (existing contract).

**Send API (`POST /api/send`)** — two optional fields, all existing validation unchanged:
- `reply_id`: int, `1 <= reply_id <= 0xFFFFFFFF`, else 400. Passed as `replyId=` to `sendText`.
- `react`: bool. When true: `reply_id` REQUIRED (400 without), `text` must be ≤ 8 bytes after
  strip (an emoji, incl. multi-codepoint like 🙏 = 4B; we do not police "is it really an emoji" —
  the mesh carries whatever, official apps render short text tapbacks fine). Sends via the new
  tapback helper below instead of `sendText`.
- Both paths keep `wantAck=True` (5a owned-TX rule) and go through `_send_and_log`, which gains
  pass-through `reply_to_id`/`is_reaction` kwargs so the outbound row is logged with its target
  and delivery tracking keeps working on replies AND reactions (a reaction gets ✓/✓✓ like any DM).

**New helper `_send_tapback(iface, text, reply_id, destinationId=None, channelIndex=0)`**:
replicates `sendData`'s packet assembly + `decoded.emoji = 1` + `portnum = TEXT_MESSAGE_APP`,
`_sendPacket(..., wantAck=True)`, returns the packet. ~12 lines, fully wrapped by the caller's
existing try/except. This is the ONLY new radio-touching code in the feature.

**@ai quoted answers** (small, high-visibility win): the FIRST chunk of an @ai reply passes
`replyId=packet["id"]` of the query — official apps and Meridian render the answer visually
attached to the question. Continuation chunks stay plain (stacked quote headers are noise).
Outbound AI rows log `reply_to_id` accordingly.

**Unchanged:** ACK correlation (`on_routing`), health counters, chunking, rate limits, memory,
RAG — this feature adds two columns, two kwargs, one helper, one guard clause.

### Dashboard v22

**Backend (`app.py`)**:
- Feature-detect `reply_to_id`/`is_reaction` columns alongside the existing `ack_state` probe;
  `/api/feed` response gains `"replies": bool` capability flag. Pre-v12 bridge → flag false,
  no 500s (same degradation contract as `delivery_tracking`).
- `/api/feed` + `/api/log` SELECT and return `mesh_id`, `reply_to_id`, `is_reaction` per row
  (NULL-safe when detection failed).
- `SendReq` gains `reply_id: int | None` (ge=1, le=4294967295) and `react: bool = False`;
  validator: `react` requires `reply_id`, and `react` caps text at 8 bytes. Forwarded verbatim
  to the bridge send API. No new security surface: same token-gated, CSRF-checked, 6/min
  rate-limited path (a reaction SPENDS a send slot — documented, not exempted).

**Frontend**:
- `Msg` type + `mesh_id`, `reply_to_id`, `is_reaction`.
- Feed builds `byMeshId: Map<mesh_id, Msg>` and `reactions: Map<reply_to_id, Msg[]>` per render
  (100-row window — trivial).
- **Rows with `is_reaction` do NOT render as feed messages.** They render as **chips** under the
  target message (`👍 2` style, title = who reacted); a reaction whose target is outside the
  loaded window is dropped from the FEED view (the Combined Log still shows the raw row, marked
  `react`). Own sent reactions keep their delivery glyph inside the chip's tooltip line.
- **Reply affordance**: an ↩ button on each message row (visible on hover, always on mobile),
  only when the row has a `mesh_id` AND the `replies` capability is on. Sets lifted
  `replyingTo = {mesh_id, node_name, text}` state in App.
- **Reply scope follows the original**: replying to a channel message pre-sets broadcast on that
  channel; replying to a DM pre-sets that node as DM target (reuses the existing
  `dmTarget`/`onDmTargetChange` path the node table already drives). The operator can still
  change the recipient before sending — `reply_id` rides along regardless.
- **SendBox**: quoted strip above the input ("↳ Replying to <name>: <text ≤60ch>  ✕"), ✕ or a
  successful send clears it. `sendMessage(text, channel, to, replyId?)`.
- **React affordance**: a small 😀+ button next to ↩ opens a fixed 6-emoji picker
  (👍 ❤️ 😂 😮 😢 🙏 — no free-form input). Tap = immediate send via the same send path with
  `react: true`, `text` = the emoji, scope = same rule as replies.
- **Inbound reply rendering**: a message with `reply_to_id` gets a compact quoted header
  ("↳ <name>: <text ≤60ch>", resolved via `byMeshId`; fallback "↳ replying to an earlier
  message"). One level deep only — no thread tree.
- Feed/Analyst tab persistence, auto-scroll, and delivery glyphs are untouched.

## Degradation matrix

| Bridge | Dashboard | Behavior |
|---|---|---|
| v11 (:v5) | v22 | `replies:false` → no ↩/😀 buttons, no chips; feed identical to v21. No errors. |
| v12 (:v6) | v21 | Extra columns unread; tapbacks appear as bare emoji messages (today's behavior). |
| v12 (:v6) | v22 | Full feature. |

## Testing (all radio-free, same harness patterns as 5a)

- **Bridge** (`test_bridge_replies.py`, ast-extraction like `test_bridge_acks.py`): send-API
  validation matrix (reply_id bounds, react-requires-reply_id, react byte cap); `_send_tapback`
  packet assembly (emoji=1, reply_id, portnum, payload bytes — against a stub iface);
  `log_traffic` kwargs; on_receive tapback guard (emoji packet → logged flagged, never queued
  for @ai). Existing 18 ack tests must stay green (\_send_and_log signature change).
- **Dashboard backend**: feature-detect on a pre-v12 fixture (no 500, `replies:false`);
  passthrough of reply_id/react to the bridge (respx/httpx mock); SendReq validation.
- **Frontend/live QA** (Playwright against staging/prod): reply flow end-to-end (↩ → quoted
  strip → send → quoted header renders on own message); react flow (chip appears under target,
  bare emoji row absent); pre-existing 👍 from `!6985f458` renders as chip IF its target is in
  window, else only in Combined Log.

## Deploy order & rollback

1. **Bridge v12 first** (build on box → **Aaron** pushes ghcr `mesh-ai-bridge:v6` → PUT with FULL
   env — unchanged env list — poll image tag). Soak ≥ a few hours: verify inbound rows get
   `mesh_id` populated and a live tapback logs `is_reaction=1`
   (`SELECT mesh_id, reply_to_id, is_reaction FROM msg_log ORDER BY id DESC LIMIT 20`).
2. **Dashboard v22 second** (same loop, `nomad-mesh-dashboard:v22`; PUT must carry
   `OWN_NODE_IDS` — standing rule).
3. Rollbacks independent: bridge → `:v5`, dashboard → `:v21`. Either direction degrades per the
   matrix above; nothing 500s.

## Out of scope (explicit)

- Un-reacting / editing / deleting (no standardized Meshtastic semantics).
- Multi-level thread trees, reply counts, jump-to-original scrolling.
- Reacting from the mesh-side AI, reactions in the analyst tab.
- Backfilling `mesh_id` for pre-v12 rows (impossible — ids were discarded).

## Open questions for Aaron

1. **Emoji picker set**: 👍 ❤️ 😂 😮 😢 🙏 — right six? (Fixed set keeps the tapback ≤8B and the
   UI one-tap.)
2. **@ai quoted answers** (bridge sets replyId on the first chunk of AI replies): include in v12,
   or hold? It's 2 lines inside the existing send lambdas, but it changes what every mesh user
   sees for AI answers (a quote header in official apps).
3. **Reactions spending the 6/min dashboard send budget**: acceptable, or should reactions get
   their own smaller bucket (e.g. 12/min) bridge-side? Recommend: shared budget, revisit if it
   ever bites.
