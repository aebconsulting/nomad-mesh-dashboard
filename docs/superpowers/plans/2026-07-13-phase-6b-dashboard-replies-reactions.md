# Phase 6b — Dashboard v22: Replies & Reactions UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meridian's feed gains reply (quoted) and react (emoji tapback) affordances; inbound replies render with quoted headers and inbound tapbacks render as reaction chips under their target instead of bare messages.

**Architecture:** Backend feature-detects the bridge v12 columns (same pattern as `delivery_tracking`) and forwards `reply_id`/`react` on the already-guarded send path. Frontend lifts a `replyingTo` state into App (like `dmTarget`/`focusNode`), groups reaction rows client-side over the 100-row window, and keeps Feed/Analyst mount persistence, auto-scroll, and delivery glyphs untouched.

**Tech Stack:** FastAPI + pydantic v2 (backend), React 18 + TypeScript + Vite (frontend), pytest + httpx TestClient (backend tests), Playwright for live QA.

## Global Constraints (from the spec — verbatim)

- Spec: `docs/superpowers/specs/2026-07-13-meridian-replies-and-reactions.md`. Canonical repo `C:\Users\AB Digial\projects\nomad-mesh-dashboard` is the working tree; mirror to `projects/project-nomad/mesh-dashboard` at the end.
- Depends on Phase 6a (bridge v12) being DEPLOYED for live behavior, but every task here must be green against a pre-v12 bridge too (degradation matrix: `replies:false` → UI hides all new affordances, feed identical to v21).
- Picker set (approved): 👍 ❤️ 😂 😮 😢 🙏 — fixed, no free-form input.
- `reply_id` range 1..4294967295; `react` requires `reply_id`; react text ≤ 8 bytes.
- Reactions spend the shared 6/min send budget (approved — no separate bucket).
- Reply scope follows the original message: channel msg → broadcast on that channel; DM → DM the sender. Operator may still change recipient; `reply_id` rides along.
- Existing 52+ backend tests stay green: `cd backend && python -m pytest -q`.
- Deploy PUT must carry `OWN_NODE_IDS` (standing rule). Image `nomad-mesh-dashboard:v22`, rollback `:v21`.

---

### Task 1: Backend — feature-detect reply columns, return them from `/api/feed` + `/api/log`

**Files:**
- Modify: `backend/app.py` (`_msg_log_has_ack` block ~lines 104-133)
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Produces: `/api/feed` items gain `mesh_id`, `reply_to_id`, `is_reaction` (None-safe); response gains `"replies": bool`. Task 3's frontend types consume these exact names.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_api.py`; the existing `client` fixture creates a v11-shaped `msg_log` with `mesh_id`/`ack_state` — check its CREATE TABLE and extend the INSERT helpers as needed):

```python
def test_feed_replies_flag_false_on_pre_v12_db(client):
    # The default fixture msg_log has NO reply_to_id/is_reaction columns.
    r = client.get("/api/feed")
    assert r.status_code == 200
    body = r.json()
    assert body["replies"] is False
    assert all(m["reply_to_id"] is None and m["is_reaction"] is None and "mesh_id" in m
               for m in body["items"])

def test_feed_returns_reply_columns_when_present(client, monkeypatch):
    import app as m
    con = sqlite3.connect(m.DB_PATH)
    con.execute("ALTER TABLE msg_log ADD COLUMN reply_to_id INTEGER")
    con.execute("ALTER TABLE msg_log ADD COLUMN is_reaction INTEGER")
    con.execute("INSERT INTO msg_log(ts, direction, node_id, node_name, channel, is_dm, is_ai, text, "
                "mesh_id, ack_state, reply_to_id, is_reaction) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (time.time(), "in", "!11111111", "A", 0, 0, 0, "👍", 500, None, 400, 1))
    con.commit(); con.close()
    m._ack_cache = None          # bust the 30s capability cache
    m._replies_cache = None
    r = client.get("/api/feed")
    assert r.json()["replies"] is True
    row = next(x for x in r.json()["items"] if x["mesh_id"] == 500)
    assert row["reply_to_id"] == 400 and row["is_reaction"] == 1
```

(Adjust imports at the top of the test file if `sqlite3`/`time` aren't imported; match the fixture's actual column list — read it first. If the fixture DB already lacks `mesh_id`, the first test's `"mesh_id" in m` assertion still holds because the feed setdefaults it.)

- [ ] **Step 2: Run to verify FAIL**: `cd backend && python -m pytest tests/test_api.py -k replies -v` → FAIL (`replies` key absent).

- [ ] **Step 3: Implement in `app.py`.** Below `_msg_log_has_ack()` add the sibling probe (same 30s TTL shape):

```python
_replies_cache = None  # (value, ts) — bridge v12 reply/reaction columns

def _msg_log_has_replies():
    """True when bridge v12's reply columns exist. Same degradation contract
    as _msg_log_has_ack: a pre-v12 bridge or rollback yields replies:false,
    never a 500."""
    global _replies_cache
    now = time.time()
    if _replies_cache and now - _replies_cache[1] < 30:
        return _replies_cache[0]
    try:
        cols = {r["name"] for r in q("PRAGMA table_info(msg_log)")}
        val = "reply_to_id" in cols and "is_reaction" in cols
    except HTTPException:
        val = False
    _replies_cache = (val, now)
    return val
```

Update `feed()`:

```python
@app.get("/api/feed")
def feed(since: float = 0.0, limit: int = Query(100, ge=1, le=FEED_CAP)):
    has_ack = _msg_log_has_ack()
    has_replies = _msg_log_has_replies()
    cols = "id, ts, direction, node_id, node_name, channel, is_dm, is_ai, text"
    cols += ", mesh_id" if has_ack else ""
    cols += ", ack_state" if has_ack else ""
    cols += ", reply_to_id, is_reaction" if has_replies else ""
    rows = q("SELECT {} FROM msg_log WHERE ts > ? ORDER BY ts DESC LIMIT ?".format(cols), (since, limit))
    for r in rows:
        r.setdefault("mesh_id", None)
        r.setdefault("ack_state", None)
        r.setdefault("reply_to_id", None)
        r.setdefault("is_reaction", None)
    return {"items": rows, "delivery_tracking": has_ack, "replies": has_replies}
```

(`mesh_id` piggybacks on `has_ack` — it arrived in the same v11 migration. `/api/log` calls `feed()` so it inherits everything.)

- [ ] **Step 4: Run**: `python -m pytest tests/ -q` → ALL PASS (old + new).

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(6b): /api/feed returns mesh_id/reply_to_id/is_reaction + replies capability flag"`

---

### Task 2: Backend — `SendReq` gains `reply_id` + `react`, forwarded to the bridge

**Files:**
- Modify: `backend/app.py` (`SendReq` ~line 291, `send()` ~line 346)
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: bridge v12 `/api/send` fields (`reply_id`, `react`) from plan 6a Task 6.
- Produces: `POST /api/send` body `{text, channel, to, reply_id?, react?}`. Task 3's `sendMessage` posts these exact names.

- [ ] **Step 1: Write the failing tests** (follow the file's existing send-test pattern for headers + the httpx mock — read a passing send test first and reuse its helper; the sketch below assumes a `_mock_bridge(monkeypatch)` helper that captures the forwarded JSON and returns 200, which may already exist for the 5a tests):

```python
def _capture_bridge_send(monkeypatch):
    import app as m
    sent = {}
    class _R:
        status_code = 200
        def json(self): return {"ok": True}
    def fake_post(url, json=None, headers=None, timeout=None):
        sent.update(json or {})
        return _R()
    monkeypatch.setattr(m.httpx, "post", fake_post)
    return sent

def test_send_forwards_reply_id(client, monkeypatch):
    sent = _capture_bridge_send(monkeypatch)
    r = client.post("/api/send", json={"text": "hi", "channel": 0, "reply_id": 777},
                    headers={"X-Mesh-Dashboard": "1"})
    assert r.status_code == 200
    assert sent["reply_id"] == 777 and sent["react"] is False

def test_send_react_valid(client, monkeypatch):
    sent = _capture_bridge_send(monkeypatch)
    r = client.post("/api/send", json={"text": "👍", "channel": 0, "reply_id": 777, "react": True},
                    headers={"X-Mesh-Dashboard": "1"})
    assert r.status_code == 200
    assert sent["react"] is True

def test_send_react_requires_reply_id(client):
    r = client.post("/api/send", json={"text": "👍", "channel": 0, "react": True},
                    headers={"X-Mesh-Dashboard": "1"})
    assert r.status_code == 422

def test_send_react_caps_bytes(client):
    r = client.post("/api/send", json={"text": "not an emoji", "channel": 0, "reply_id": 7, "react": True},
                    headers={"X-Mesh-Dashboard": "1"})
    assert r.status_code == 422

def test_send_reply_id_bounds(client):
    for bad in (0, -1, 4294967296):
        r = client.post("/api/send", json={"text": "hi", "channel": 0, "reply_id": bad},
                        headers={"X-Mesh-Dashboard": "1"})
        assert r.status_code == 422, bad
```

(Rate limiting: the existing tests handle the 6/min bucket — if these five sends trip it, reset `app._send_times.clear()` between tests the same way the 5a tests do.)

- [ ] **Step 2: Run to verify FAIL**: `python -m pytest tests/test_api.py -k "reply_id or react" -v`

- [ ] **Step 3: Implement.** `SendReq` grows:

```python
class SendReq(BaseModel):
    text: str = Field(min_length=1)
    channel: int = Field(0, ge=0, le=7)
    to: str | None = None
    reply_id: int | None = Field(None, ge=1, le=4294967295)
    react: bool = False

    # ...existing text/dest validators unchanged...

    @model_validator(mode="after")
    def react_rules(self):
        if self.react:
            if self.reply_id is None:
                raise ValueError("react requires reply_id")
            if len(self.text.encode()) > 8:
                raise ValueError("a reaction is a single emoji (max 8 bytes)")
        return self
```

(Add `model_validator` to the pydantic import line.) In `send()`, the forward becomes:

```python
        r = httpx.post(BRIDGE_URL + "/api/send",
                       json={"text": body.text, "channel": body.channel, "to": body.to,
                             "reply_id": body.reply_id, "react": body.react},
                       headers={"X-Send-Token": SEND_TOKEN}, timeout=10)
```

(Bridge v11 ignores unknown JSON fields — `data.get("reply_id")` simply returns None there — so this is safe to deploy before OR after 6a.)

- [ ] **Step 4: Run**: `python -m pytest tests/ -q` → ALL PASS.

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(6b): send API forwards reply_id/react with validation"`

---

### Task 3: Frontend types + send plumbing

**Files:**
- Modify: `frontend/src/api.ts` (Msg type ~line 3, fetchFeed ~line 74, sendMessage ~line 83)

**Interfaces:**
- Produces: `Msg` + `mesh_id: number | null; reply_to_id: number | null; is_reaction: number | null`; feed response type + `replies?: boolean`; `sendMessage(text, channel, to, replyId?: number | null, react?: boolean)`. Tasks 4-5 consume these exact signatures.

- [ ] **Step 1: Implement** (no unit harness exists for the frontend — the compile IS the test; live QA in Task 6):

```typescript
export interface Msg { id: number; ts: number; direction: "in" | "out"; node_id: string; node_name: string; channel: number; is_dm: number; is_ai: number; text: string; ack_state: string | null; mesh_id: number | null; reply_to_id: number | null; is_reaction: number | null; }
```

```typescript
export const fetchFeed = () => get<{ items: Msg[]; delivery_tracking?: boolean; replies?: boolean }>("/api/feed?limit=100");
```

```typescript
export async function sendMessage(text: string, channel: number, to: string | null, replyId?: number | null, react?: boolean): Promise<void> {
  const r = await fetch("/api/send", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Dashboard": "1" },
    body: JSON.stringify({ text, channel, to, reply_id: replyId ?? null, react: react ?? false }),
  });
  // ...existing error handling unchanged...
}
```

- [ ] **Step 2: Verify it compiles**: `cd frontend && npm run build` → `✓ built`.

- [ ] **Step 3: Commit**: `git add -u && git commit -m "feat(6b): Msg reply fields + sendMessage replyId/react"`

---

### Task 4: App state + Feed rendering (chips, quoted headers, reply/react buttons)

**Files:**
- Modify: `frontend/src/App.tsx`, `frontend/src/components/Feed.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `Msg` fields + `replies` flag (Task 3).
- Produces: App-lifted `replyingTo: {meshId: number, name: string, text: string, channel: number, dm: string | null} | null` + `setReplyingTo`; Feed props gain `replies: boolean`, `onReply(m: Msg)`, `onReact(m: Msg, emoji: string)`. Task 5's SendBox consumes `replyingTo`/`onClearReply`.

- [ ] **Step 1: App.tsx** — lift the state and thread it (alongside the existing `dmTarget`/`focusNode` lifts):

```tsx
export type ReplyTarget = { meshId: number; name: string; text: string; channel: number; dm: string | null };
```

```tsx
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
```

Reply scope rule (spec): channel msg → broadcast (dm null, keep channel); DM → DM the sender. Handler passed to Feed:

```tsx
  const onReply = (m: Msg) => {
    if (m.mesh_id == null) return;
    const dm = m.is_dm && m.direction === "in" ? m.node_id : null;
    setReplyingTo({ meshId: m.mesh_id, name: m.node_name, text: m.text, channel: m.channel, dm });
    setDmTarget(dm ?? "");
  };
  const onReact = async (m: Msg, emoji: string) => {
    if (m.mesh_id == null) return;
    const dm = m.is_dm && m.direction === "in" ? m.node_id : null;
    await sendMessage(emoji, m.channel, dm, m.mesh_id, true).catch(() => {});
  };
```

(Import `sendMessage` + `Msg` in App.tsx.) Pass `replies={feed.data?.replies ?? false}`, `onReply`, `onReact`, `replyingTo`, `onClearReply={() => setReplyingTo(null)}` into `<Feed>`.

- [ ] **Step 2: Feed.tsx** — reaction grouping + chips + quoted headers + hover buttons. Above the component:

```tsx
const PICKER = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
```

Inside, after `chrono`:

```tsx
  const byMeshId = new Map<number, Msg>();
  for (const m of chrono) if (m.mesh_id != null) byMeshId.set(m.mesh_id, m);
  const reactions = new Map<number, Msg[]>();
  for (const m of chrono) {
    if (m.is_reaction && m.reply_to_id != null) {
      const arr = reactions.get(m.reply_to_id) ?? [];
      arr.push(m); reactions.set(m.reply_to_id, arr);
    }
  }
  const shown = chrono.filter(m => !m.is_reaction && !(hideSelf && isSelf(m)) && !(hideAI && isAI(m)));
```

Per-row rendering additions (inside the existing `shown.map(m => ...)` row, after the `.txt` div):

```tsx
              {m.reply_to_id != null && (() => {
                const t = byMeshId.get(m.reply_to_id);
                return <div className="quote">↳ {t ? `${t.node_name}: ${t.text.slice(0, 60)}` : "replying to an earlier message"}</div>;
              })()}
              {(reactions.get(m.mesh_id ?? -1) ?? []).length > 0 && (
                <div className="chips">
                  {Object.entries(
                    (reactions.get(m.mesh_id ?? -1) ?? []).reduce<Record<string, string[]>>((acc, r) => {
                      (acc[r.text] = acc[r.text] ?? []).push(r.node_name); return acc;
                    }, {})
                  ).map(([emoji, who]) => (
                    <span key={emoji} className="chip" title={who.join(", ")}>{emoji}{who.length > 1 ? ` ${who.length}` : ""}</span>
                  ))}
                </div>
              )}
              {replies && m.mesh_id != null && (
                <span className="row-actions">
                  <button className="act" title="Reply" onClick={() => onReply(m)}>↩</button>
                  <span className="react-wrap">
                    <button className="act" title="React">😀+</button>
                    <span className="picker">
                      {PICKER.map(e => <button key={e} className="pick" onClick={() => onReact(m, e)}>{e}</button>)}
                    </span>
                  </span>
                </span>
              )}
```

NOTE — quoted header placement: render the `.quote` div ABOVE the `.txt` div (a quote introduces the message), i.e. reorder so quote comes first inside `.body`. The snippet above shows content; final order in `.body`: `.who`+`.tags` row, `.quote`, `.txt`, `.chips`.

Feed props signature becomes:

```tsx
export function Feed({ items, nodes, stale, dmTarget, onDmTargetChange, showOffline, replies, onReply, onReact, replyingTo, onClearReply }: {
  items: Msg[]; nodes: Node[]; stale?: boolean;
  dmTarget: string; onDmTargetChange: (id: string) => void; showOffline: boolean;
  replies: boolean; onReply: (m: Msg) => void; onReact: (m: Msg, emoji: string) => void;
  replyingTo: ReplyTarget | null; onClearReply: () => void;
}) {
```

(`ReplyTarget` imported from App — or move the type into `api.ts` to avoid a component→App import; put it in `api.ts`.) Pass `replyingTo`/`onClearReply` down to `<SendBox>` (Task 5).

- [ ] **Step 3: styles.css** — append to the feed section:

```css
/* ---------- replies & reactions ---------- */
.quote { font-size: 12px; color: var(--muted); border-left: 2px solid var(--line); padding-left: 8px; margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips { display: flex; gap: 6px; margin-top: 3px; }
.chip { font-size: 12px; padding: 1px 7px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); cursor: default; }
.row-actions { margin-left: 8px; opacity: 0; transition: opacity .12s; display: inline-flex; gap: 4px; vertical-align: 1px; }
.msg:hover .row-actions { opacity: 1; }
.act { background: none; border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font-size: 11px; padding: 0 5px; cursor: pointer; }
.act:hover { color: var(--text); border-color: var(--accent); }
.react-wrap { position: relative; }
.react-wrap .picker { display: none; position: absolute; bottom: 100%; right: 0; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 3px; gap: 2px; z-index: 30; white-space: nowrap; }
.react-wrap:hover .picker, .react-wrap:focus-within .picker { display: inline-flex; }
.pick { background: none; border: 0; font-size: 15px; cursor: pointer; padding: 2px 4px; }
.pick:hover { transform: scale(1.25); }
@media (max-width: 600px) { .row-actions { opacity: 1; } }  /* always visible on mobile */
```

- [ ] **Step 4: Compile**: `npm run build` → `✓ built` (Task 5 completes the SendBox props before the full app typechecks — if the build fails ONLY on SendBox props, proceed to Task 5 and compile there).

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(6b): feed reply/react affordances, reaction chips, quoted headers"`

---

### Task 5: SendBox — quoted reply strip + reply-aware submit

**Files:**
- Modify: `frontend/src/components/SendBox.tsx`

**Interfaces:**
- Consumes: `replyingTo: ReplyTarget | null`, `onClearReply: () => void` (Task 4); `sendMessage(text, channel, to, replyId, react)` (Task 3).

- [ ] **Step 1: Implement.** Props:

```tsx
export function SendBox({ nodes, value, onChange, showOffline, replyingTo, onClearReply }: {
  nodes: Node[]; value: string; onChange: (id: string) => void; showOffline: boolean;
  replyingTo: ReplyTarget | null; onClearReply: () => void;
}) {
```

Submit (channel comes from the reply target when set — today's box always sends ch0):

```tsx
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || bytes > 200) return;
    if (clearRef.current) { clearTimeout(clearRef.current); clearRef.current = null; }
    setNote("sending…");
    try {
      await sendMessage(text.trim(), replyingTo?.channel ?? 0, value || null, replyingTo?.meshId ?? null);
      setText(""); setNote("sent");
      onClearReply();
      clearRef.current = setTimeout(() => { setNote(null); clearRef.current = null; }, 3000);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "send failed");
    }
  };
```

Quoted strip — render ABOVE the existing form row (inside the `<form>`, first child):

```tsx
      {replyingTo && (
        <div className="reply-strip">
          <span className="reply-quote">↳ Replying to {replyingTo.name}: {replyingTo.text.slice(0, 60)}</span>
          <button type="button" className="reply-x" title="Cancel reply" onClick={onClearReply}>✕</button>
        </div>
      )}
```

CSS (append to styles.css send section):

```css
.reply-strip { display: flex; align-items: center; gap: 8px; width: 100%; font-size: 12px; color: var(--muted); border-left: 2px solid var(--accent); padding: 2px 8px; margin-bottom: 6px; }
.reply-strip .reply-quote { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.reply-x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 13px; }
.reply-x:hover { color: var(--crit); }
```

(Check the `.send` form's flex layout — if it's `display:flex; flex-direction: row`, wrap it or set `flex-wrap: wrap` so the strip takes the full first line: add `.send { flex-wrap: wrap; }` if needed.)

- [ ] **Step 2: Compile + backend tests**: `npm run build` → `✓ built`; `cd ../backend && python -m pytest -q` → ALL PASS.

- [ ] **Step 3: Commit**: `git add -u && git commit -m "feat(6b): SendBox quoted reply strip, reply-aware submit"`

---

### Task 6: Live QA + deploy v22

**Files:**
- Create (temp, deleted after): `frontend/qa-replies.mjs`

- [ ] **Step 1: Local QA against the live backend** — tunnel + dev server (`ssh -fN -L 8000:127.0.0.1:8420 aibox`, `npm run dev`), then a Playwright script asserting, in order:
  1. With bridge still v11 (`replies:false`): NO ↩/😀 buttons render; feed identical to v21 (degradation gate — run this BEFORE the bridge deploy if sequencing allows).
  2. After bridge v12: buttons render on rows with `mesh_id`; ↩ shows the reply strip with the quoted name/text; ✕ clears it.
  3. Send a reply to a recent channel message (LIVE TX — one real message on CH0, content "test reply — ignore"); assert the new outbound row renders with a `.quote` header naming the target.
  4. React 👍 to the same message; assert a `.chip` appears under it and NO new bare feed row.
  5. The pre-existing 👍 from `!6985f458` (2026-07-13 morning) renders as a chip IF its target is in the window (it predates v12 columns so it will remain a bare row — EXPECTED; assert it stays a bare row, documenting the no-backfill rule).
- [ ] **Step 2: Build image on aibox** (standard loop): `git archive HEAD -o /tmp/dash-v22.tar && scp /tmp/dash-v22.tar aibox:/tmp/ && ssh aibox 'rm -rf ~/mesh-dashboard && mkdir -p ~/mesh-dashboard && tar -xf /tmp/dash-v22.tar -C ~/mesh-dashboard && docker build -q -t ghcr.io/aebconsulting/nomad-mesh-dashboard:v22 ~/mesh-dashboard'`
- [ ] **Step 3: AARON pushes** `ghcr.io/aebconsulting/nomad-mesh-dashboard:v22`.
- [ ] **Step 4: PUT** (full config, env MUST include `OWN_NODE_IDS=!849a5bc8`, `force:true`), poll to `:v22` running, page 200 local + gateway.
- [ ] **Step 5: Live prod QA** — repeat QA items 2-4 against `http://192.168.1.197:8420`; screenshot the chips + quoted reply. Verify delivery glyph appears on the sent reply (ack tracking through the new path).
- [ ] **Step 6: Mirror + docs**: copy changed files to `projects/project-nomad/mesh-dashboard`, commit monorepo mirror; update CLAUDE.md Meridian bullet (Phase 6 live, rollback tags); delete `HANDOFF-reply-feature.md`'s stale sections or mark it superseded by the spec.

## Self-review notes

- Spec coverage: capability flag ✓ (T1), SendReq ✓ (T2), types ✓ (T3), chips/quotes/buttons ✓ (T4), reply strip + scope rule ✓ (T5), degradation + live QA + deploy ✓ (T6).
- Reaction rows excluded from `shown` BEFORE the self/AI filters — a tapback never renders as a message regardless of toggles; Combined Log (`/api/log` → LogPanel) still shows raw rows.
- `sendMessage` keeps old call sites valid (new params optional) — SendBox is the only caller today.
- Type name consistency: `ReplyTarget` lives in `api.ts`; `onReply`/`onReact`/`replyingTo`/`onClearReply` names match across App/Feed/SendBox tasks.
