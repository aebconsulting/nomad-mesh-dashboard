# Phase 6a — Bridge v12: Replies & Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge v12 stores every message's mesh packet id + reply target + reaction flag, accepts `reply_id`/`react` on the send API, sends emoji tapbacks via a hand-built MeshPacket, and quotes the query on the first chunk of @ai answers.

**Architecture:** All changes are additive to `bridge.py` (single file, single radio owner). Two new nullable `msg_log` columns via the existing `_add_cols` migration; `log_traffic`/`_send_and_log` gain pass-through kwargs; one new radio-touching helper (`_send_tapback`) replicating `sendData`'s packet assembly plus `decoded.emoji=1`; pure helpers (`_inbound_meta`, `_validate_reply_fields`, `make_quoted_send`) keep the new logic ast-extractable for radio-free tests.

**Tech Stack:** Python 3 stdlib + meshtastic 2.7.10 (already pinned in the image). Tests: pytest, radio-free via the `test_bridge_acks.py` ast-extraction harness pattern.

## Global Constraints (from the spec — verbatim)

- Spec: `docs/superpowers/specs/2026-07-13-meridian-replies-and-reactions.md`. Aaron's answers: picker set approved; @ai quoted answers INCLUDED in v12; reactions share the existing rate budget.
- Work in the WORKSTATION mirror `C:\Users\AB Digial\projects\project-nomad\mesh-ai-bridge\bridge.py`. NEVER write to aibox `/opt/mesh-ai-bridge` (Aaron-only, classifier-gated).
- Every new handler/branch fully wrapped (`try/except` + `log()`), additive only — no change to chunking, rate limits, ACK correlation, memory, RAG.
- `reply_id` valid range: `1 <= reply_id <= 0xFFFFFFFF`. `react` requires `reply_id`; react text ≤ 8 bytes after strip.
- Tapback = `decoded.emoji = 1` + `decoded.reply_id` + `portnum TEXT_MESSAGE_APP` + payload = emoji bytes; `sendText`/`sendData` cannot send one (verified 2026-07-13).
- A tapback received by the bridge is logged flagged and NEVER queued for @ai.
- All existing tests must stay green: `python -m pytest test_bridge_acks.py test_bridge_v6.py test_bridge_v9.py test_bridge_v10.py -q` from the mesh-ai-bridge dir.
- Image tag on completion: `ghcr.io/aebconsulting/mesh-ai-bridge:v6` (code v12). Rollback `:v5`.

---

### Task 1: Migration — `reply_to_id` + `is_reaction` columns

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (the `db()` function, currently lines ~166-168)
- Test: `projects/project-nomad/mesh-ai-bridge/test_bridge_replies.py` (create)

**Interfaces:**
- Produces: `msg_log.reply_to_id INTEGER` (nullable), `msg_log.is_reaction INTEGER` (nullable), index `idx_msg_log_reply_to`. Tasks 2-6 write these columns.

- [ ] **Step 1: Write the failing tests** (new file, reusing the acks-harness pattern)

```python
"""Phase 6a replies/reactions tests — radio-free.

Same harness as test_bridge_acks.py: pure functions are ast-extracted from
bridge.py source and exec'd (bridge.py imports meshtastic at module load, so
it is never imported here); migrations/SQL are mirrored against temp sqlite
and asserted byte-identical to the shipped source.
"""
import ast, io, os, sqlite3, tempfile

BRIDGE = os.path.join(os.path.dirname(__file__), "bridge.py")
SRC = io.open(BRIDGE, encoding="utf-8").read()


def _extract(func_name, extra_globals=None):
    tree = ast.parse(SRC)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            mod = ast.Module(body=[node], type_ignores=[])
            ns = dict(extra_globals or {})
            exec(compile(mod, BRIDGE, "exec"), ns)
            return ns[func_name], ns
    raise AssertionError("function {} not found in bridge.py".format(func_name))


# ---------- Task 1: migration ----------

def _apply_migration(dbpath):
    c = sqlite3.connect(dbpath)
    c.execute("CREATE TABLE IF NOT EXISTS msg_log(id INTEGER PRIMARY KEY, ts REAL, direction TEXT, "
              "node_id TEXT, node_name TEXT, channel INTEGER, is_dm INTEGER, is_ai INTEGER, text TEXT, "
              "mesh_id INTEGER, ack_state TEXT)")
    have = {r[1] for r in c.execute("PRAGMA table_info(msg_log)")}
    for name, decl in [("reply_to_id", "INTEGER"), ("is_reaction", "INTEGER")]:
        if name not in have:
            try:
                c.execute("ALTER TABLE msg_log ADD COLUMN {} {}".format(name, decl))
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_log_reply_to ON msg_log(reply_to_id)")
    c.commit()
    return c


def test_replies_migration_idempotent():
    d = tempfile.mkdtemp(); p = os.path.join(d, "m.db")
    _apply_migration(p).close()
    _apply_migration(p).close()   # second run must not raise
    c = sqlite3.connect(p)
    cols = {r[1] for r in c.execute("PRAGMA table_info(msg_log)")}
    assert "reply_to_id" in cols and "is_reaction" in cols
    idx = {r[1] for r in c.execute("PRAGMA index_list(msg_log)")}
    assert "idx_msg_log_reply_to" in idx


def test_bridge_source_contains_replies_migration():
    assert '_add_cols(c, "msg_log", [("reply_to_id", "INTEGER"), ("is_reaction", "INTEGER")])' in SRC
    assert "idx_msg_log_reply_to" in SRC
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `projects/project-nomad/mesh-ai-bridge`): `python -m pytest test_bridge_replies.py -v`
Expected: `test_replies_migration_idempotent` PASSES (it only exercises the mirror), `test_bridge_source_contains_replies_migration` FAILS (source lacks the migration).

- [ ] **Step 3: Add the migration to `bridge.py` `db()`** — directly under the existing v11 lines:

```python
    _add_cols(c, "msg_log", [("mesh_id", "INTEGER"), ("ack_state", "TEXT")])
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_log_mesh_id ON msg_log(mesh_id)")
    # v12/6a: reply threading + emoji tapbacks
    _add_cols(c, "msg_log", [("reply_to_id", "INTEGER"), ("is_reaction", "INTEGER")])
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_log_reply_to ON msg_log(reply_to_id)")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test_bridge_replies.py -v` → both PASS.
Also run: `python -m pytest test_bridge_acks.py -q` → all 18 still PASS.

- [ ] **Step 5: Commit**

```bash
git add mesh-ai-bridge/bridge.py mesh-ai-bridge/test_bridge_replies.py
git commit -m "feat(bridge/6a): msg_log reply_to_id + is_reaction migration"
```

---

### Task 2: `log_traffic` carries `reply_to_id` / `is_reaction`

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (`log_traffic`, currently lines ~171-176)
- Test: `projects/project-nomad/mesh-ai-bridge/test_bridge_replies.py`

**Interfaces:**
- Produces: `log_traffic(direction, node_id, node_name, channel, is_dm, is_ai, text, mesh_id=None, ack_state=None, reply_to_id=None, is_reaction=None)` — Tasks 3-6 call this signature.

- [ ] **Step 1: Write the failing test** (source-shape assertion — `log_traffic` touches the DB global, so like the acks tests we pin the INSERT SQL rather than exec it)

```python
# ---------- Task 2: log_traffic ----------

def test_log_traffic_inserts_reply_columns():
    assert ("INSERT INTO msg_log(ts, direction, node_id, node_name, channel, is_dm, is_ai, text, "
            "mesh_id, ack_state, reply_to_id, is_reaction)") in SRC
    assert "reply_to_id=None, is_reaction=None" in SRC   # kwargs with safe defaults
```

- [ ] **Step 2: Run to verify it fails**: `python -m pytest test_bridge_replies.py::test_log_traffic_inserts_reply_columns -v` → FAIL.

- [ ] **Step 3: Update `log_traffic` in `bridge.py`**:

```python
def log_traffic(direction, node_id, node_name, channel, is_dm, is_ai, text, mesh_id=None, ack_state=None,
                reply_to_id=None, is_reaction=None):
    try:
        with db_lock:
            c.execute("INSERT INTO msg_log(ts, direction, node_id, node_name, channel, is_dm, is_ai, text, "
                      "mesh_id, ack_state, reply_to_id, is_reaction) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                      (time.time(), direction, node_id, node_name, channel, int(is_dm), int(is_ai), text,
                       mesh_id, ack_state, reply_to_id, is_reaction))
```

(Keep the function's existing `try/except`/commit body otherwise identical — only the signature, SQL, and tuple change. Read the CURRENT body first; the lines above show the shape, the surrounding pruning/commit code stays.)

- [ ] **Step 4: Run**: `python -m pytest test_bridge_replies.py test_bridge_acks.py -q` → all PASS (the acks harness `fake_log_traffic` accepts `**kw`-style extras — if its signature is positional, extend it to `reply_to_id=None, is_reaction=None` in the same commit).

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(bridge/6a): log_traffic reply_to_id/is_reaction pass-through"`

---

### Task 3: `_send_and_log` passes reply metadata through (both success and failure rows)

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (`_send_and_log`, currently lines ~885-906)
- Test: `projects/project-nomad/mesh-ai-bridge/test_bridge_replies.py`

**Interfaces:**
- Consumes: `log_traffic(..., reply_to_id=, is_reaction=)` from Task 2.
- Produces: `_send_and_log(send_fn, node_id, node_name, ch, is_dm, is_ai, text, reply_to_id=None, is_reaction=None)` — Tasks 5 and 6 call this.

- [ ] **Step 1: Write the failing test** (extraction harness, mirroring `test_bridge_acks._send_and_log_harness`)

```python
# ---------- Task 3: _send_and_log passthrough ----------

class _Pkt:
    def __init__(self, id=1234):
        self.id = id

def _send_and_log_replies_harness():
    calls = []
    def fake_log_traffic(direction, node_id, node_name, channel, is_dm, is_ai, text,
                         mesh_id=None, ack_state=None, reply_to_id=None, is_reaction=None):
        calls.append(dict(direction=direction, mesh_id=mesh_id, ack_state=ack_state,
                          reply_to_id=reply_to_id, is_reaction=is_reaction))
    fn, ns = _extract("_send_and_log", {"log_traffic": fake_log_traffic, "log": lambda *a: None,
                                        "sends_without_id": 0})
    return fn, calls

def test_send_and_log_passes_reply_metadata_on_success():
    fn, calls = _send_and_log_replies_harness()
    fn(lambda: _Pkt(77), "!aabbccdd", "X", 0, True, False, "hi", reply_to_id=55, is_reaction=1)
    assert calls[-1]["mesh_id"] == 77 and calls[-1]["reply_to_id"] == 55 and calls[-1]["is_reaction"] == 1

def test_send_and_log_passes_reply_metadata_on_failure():
    fn, calls = _send_and_log_replies_harness()
    def boom(): raise RuntimeError("radio")
    try:
        fn(boom, "!aabbccdd", "X", 0, True, False, "hi", reply_to_id=55, is_reaction=1)
    except RuntimeError:
        pass
    assert calls[-1]["ack_state"] == "failed" and calls[-1]["reply_to_id"] == 55 and calls[-1]["is_reaction"] == 1
```

- [ ] **Step 2: Run to verify FAIL** (unexpected-kwarg TypeError): `python -m pytest test_bridge_replies.py -k send_and_log -v`

- [ ] **Step 3: Implement** — extend `_send_and_log`'s signature and BOTH `log_traffic` calls:

```python
def _send_and_log(send_fn, node_id, node_name, ch, is_dm, is_ai, text, reply_to_id=None, is_reaction=None):
    ...docstring unchanged...
    global sends_without_id
    try:
        pkt = send_fn()
    except Exception:
        log_traffic("out", node_id, node_name, ch, is_dm, is_ai, text, mesh_id=None, ack_state="failed",
                    reply_to_id=reply_to_id, is_reaction=is_reaction)
        raise
    mesh_id = getattr(pkt, "id", 0) or None
    if mesh_id is None:
        sends_without_id += 1
        log("send returned no packet id — row will stay glyphless")
    log_traffic("out", node_id, node_name, ch, is_dm, is_ai, text, mesh_id=mesh_id, ack_state=None,
                reply_to_id=reply_to_id, is_reaction=is_reaction)
    return pkt
```

- [ ] **Step 4: Run all**: `python -m pytest test_bridge_replies.py test_bridge_acks.py -q` → PASS.

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(bridge/6a): _send_and_log reply metadata passthrough"`

---

### Task 4: `_send_tapback` — the hand-built emoji packet (the ONLY new radio-touching code)

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (new top-level function directly above `_send_and_log`; new import line)
- Test: `projects/project-nomad/mesh-ai-bridge/test_bridge_replies.py`

**Interfaces:**
- Produces: `_send_tapback(interface, text, reply_id, destinationId=None, channelIndex=0)` → returns the sent packet (with `.id`). Task 6 wraps it in `_send_and_log`.

- [ ] **Step 1: Write the failing test** (fake protobuf modules injected as extraction globals)

```python
# ---------- Task 4: _send_tapback ----------

class _FakeDecoded:
    def __init__(self):
        self.payload = b""; self.portnum = None; self.want_response = False
        self.reply_id = 0; self.emoji = 0

class _FakeMeshPacket:
    def __init__(self):
        self.decoded = _FakeDecoded(); self.channel = 0; self.id = 0; self.priority = None

class _FakeMeshPb2:
    MeshPacket = _FakeMeshPacket
    class MeshPacket_Priority:  # namespaced below via attribute assignment
        RELIABLE = 70
_FakeMeshPb2.MeshPacket.Priority = _FakeMeshPb2.MeshPacket_Priority

class _FakePortnums:
    class PortNum:
        TEXT_MESSAGE_APP = 1

class _FakeIface:
    def __init__(self):
        self.sent = None; self.kwargs = None
    def _generatePacketId(self):
        return 4242
    def _sendPacket(self, pkt, destinationId="^all", wantAck=False, **kw):
        self.sent = pkt; self.kwargs = dict(destinationId=destinationId, wantAck=wantAck)
        return pkt

def _tapback():
    fn, ns = _extract("_send_tapback", {"mesh_pb2": _FakeMeshPb2, "portnums_pb2": _FakePortnums})
    return fn

def test_tapback_packet_fields_dm():
    fn = _tapback(); iface = _FakeIface()
    pkt = fn(iface, "👍", 999, destinationId="!849a5bc8")
    assert iface.sent.decoded.emoji == 1
    assert iface.sent.decoded.reply_id == 999
    assert iface.sent.decoded.portnum == 1                       # TEXT_MESSAGE_APP
    assert iface.sent.decoded.payload == "👍".encode("utf-8")
    assert iface.sent.id == 4242
    assert iface.kwargs == {"destinationId": "!849a5bc8", "wantAck": True}
    assert pkt is iface.sent

def test_tapback_packet_fields_broadcast():
    fn = _tapback(); iface = _FakeIface()
    fn(iface, "❤️", 1000, channelIndex=0)
    assert iface.sent.channel == 0
    assert iface.kwargs["destinationId"] == "^all"
```

- [ ] **Step 2: Run to verify FAIL** ("function _send_tapback not found"): `python -m pytest test_bridge_replies.py -k tapback -v`

- [ ] **Step 3: Implement in `bridge.py`.** Add to the imports block (top of file):

```python
from meshtastic.protobuf import mesh_pb2, portnums_pb2
```

Add the function (directly above `_send_and_log`):

```python
def _send_tapback(interface, text, reply_id, destinationId=None, channelIndex=0):
    """Send an emoji tapback. meshtastic 2.7.10 has NO public API for the Data
    `emoji` flag (sendData sets reply_id but never emoji — verified 2026-07-13),
    so this replicates sendData's packet assembly exactly, plus emoji=1.
    Returns the sent packet (id populated) — same contract _send_and_log expects."""
    pkt = mesh_pb2.MeshPacket()
    pkt.channel = channelIndex
    pkt.decoded.payload = text.encode("utf-8")
    pkt.decoded.portnum = portnums_pb2.PortNum.TEXT_MESSAGE_APP
    pkt.decoded.want_response = False
    pkt.id = interface._generatePacketId()
    pkt.decoded.reply_id = reply_id
    pkt.decoded.emoji = 1
    pkt.priority = mesh_pb2.MeshPacket.Priority.RELIABLE
    return interface._sendPacket(pkt, destinationId=destinationId or "^all", wantAck=True)
```

- [ ] **Step 4: Run**: `python -m pytest test_bridge_replies.py -q` → PASS. Then `python -c "import ast,io; ast.parse(io.open('bridge.py',encoding='utf-8').read())"` → clean parse.

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(bridge/6a): _send_tapback hand-built emoji packet"`

---

### Task 5: Inbound capture + tapback guard + @ai quoted first chunk

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (`on_receive` lines ~1116-1146; two new pure helpers above it)
- Test: `projects/project-nomad/mesh-ai-bridge/test_bridge_replies.py`

**Interfaces:**
- Consumes: `log_traffic` (Task 2), `_send_and_log` (Task 3).
- Produces: pure `_inbound_meta(packet, dec)` → `(mesh_id, reply_to_id, is_reaction)`; pure `make_quoted_send(send_raw, quote_id)` → single-arg `send(c)` closure that passes `quote_id` only on its FIRST call. `on_receive` uses both; the worker/`handle_query`/queue tuple are UNCHANGED.

- [ ] **Step 1: Write the failing tests**

```python
# ---------- Task 5: inbound meta + quoted send ----------

def test_inbound_meta_normal_message():
    fn, _ = _extract("_inbound_meta")
    assert fn({"id": 111}, {"text": "hello"}) == (111, None, None)

def test_inbound_meta_reply():
    fn, _ = _extract("_inbound_meta")
    assert fn({"id": 112}, {"text": "yes", "replyId": 111}) == (112, 111, None)

def test_inbound_meta_tapback():
    fn, _ = _extract("_inbound_meta")
    assert fn({"id": 113}, {"text": "👍", "replyId": 111, "emoji": 1}) == (113, 111, 1)

def test_inbound_meta_missing_id_is_none():
    fn, _ = _extract("_inbound_meta")
    assert fn({}, {}) == (None, None, None)

def test_quoted_send_quotes_only_first_call():
    fn, _ = _extract("make_quoted_send")
    seen = []
    send = fn(lambda c, rid=None: seen.append((c, rid)), 555)
    send("part 1"); send("part 2"); send("part 3")
    assert seen == [("part 1", 555), ("part 2", None), ("part 3", None)]

def test_on_receive_source_logs_meta_and_guards_reactions():
    # Shape assertions on the shipped source (on_receive itself needs the radio).
    assert "_inbound_meta(packet, dec)" in SRC
    assert "if is_reaction:" in SRC          # tapback logged, then return before @ai path
    assert "make_quoted_send(" in SRC
```

- [ ] **Step 2: Run to verify FAIL**: `python -m pytest test_bridge_replies.py -k "inbound or quoted or on_receive" -v`

- [ ] **Step 3: Implement.** Add the two pure helpers above `on_receive`:

```python
def _inbound_meta(packet, dec):
    """Pull (mesh_id, reply_to_id, is_reaction) from an inbound packet dict.
    Protobuf-dict defaults are OMITTED: replyId/emoji are absent on normal
    messages. is_reaction is 1 or None (never 0) to keep NULL semantics."""
    mesh_id = packet.get("id") or None
    reply_to = dec.get("replyId") or None
    reacted = 1 if dec.get("emoji") else None
    return mesh_id, reply_to, reacted

def make_quoted_send(send_raw, quote_id):
    """Wrap a two-arg send(chunk, rid) into the one-arg send(chunk) the worker
    uses, quoting quote_id on the FIRST call only — the @ai answer's first
    chunk renders attached to the question; continuations stay plain."""
    state = {"first": True}
    def send(c):
        rid = quote_id if state["first"] else None
        state["first"] = False
        return send_raw(c, rid)
    return send
```

Modify `on_receive` (the block from `node_name = ...` to the enqueue). The existing lines:

```python
        node_name = node_display(interface, sender)
        # Log ALL inbound mesh text (the dashboard feed), not just @ai queries.
        log_traffic("in", sender, node_name, ch, is_dm, is_ai, text)
        if not is_ai:
            return
```

become:

```python
        node_name = node_display(interface, sender)
        mesh_id, reply_to_id, is_reaction = _inbound_meta(packet, dec)
        # Log ALL inbound mesh text (the dashboard feed), not just @ai queries.
        log_traffic("in", sender, node_name, ch, is_dm, is_ai, text,
                    mesh_id=mesh_id, reply_to_id=reply_to_id, is_reaction=is_reaction)
        if is_reaction:
            return   # a tapback is never a query — logged flagged, nothing else
        if not is_ai:
            return
```

And the two send lambdas (DM and broadcast branches) grow an `rid` parameter, get wrapped, and pass the metadata:

```python
        if is_dm:
            send_raw = lambda c, rid=None: _send_and_log(
                lambda: interface.sendText(c, destinationId=sender, wantAck=True, replyId=rid),
                sender, node_name, ch, True, True, c, reply_to_id=rid)
        else:
            if ch not in ALLOWED:
                return
            send_raw = lambda c, rid=None: _send_and_log(
                lambda: interface.sendText(c, channelIndex=ch, wantAck=True, replyId=rid),
                sender, node_name, ch, False, True, c, reply_to_id=rid)
        send = make_quoted_send(send_raw, mesh_id)
```

(Keep the branch comments that are there today. `send` stays one-arg, so `handle_query`, `_send_chunks`, the "more"/remember/forget paths, the queue tuple, and `_worker` are all untouched — a command confirmation simply quotes the command it answers, which is correct.)

- [ ] **Step 4: Run everything**: `python -m pytest test_bridge_replies.py test_bridge_acks.py test_bridge_v6.py test_bridge_v9.py test_bridge_v10.py -q` → ALL PASS. Then the parse check: `python -c "import ast,io; ast.parse(io.open('bridge.py',encoding='utf-8').read())"`.

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(bridge/6a): inbound mesh_id/reply capture, tapback guard, @ai quoted first chunk"`

---

### Task 6: Send API — `reply_id` + `react`

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (`SendHandler.do_POST`, ~lines 938-983; one pure helper above the class)
- Test: `projects/project-nomad/mesh-ai-bridge/test_bridge_replies.py`

**Interfaces:**
- Consumes: `_send_tapback` (Task 4), `_send_and_log` (Task 3).
- Produces: `POST /api/send` accepting optional `reply_id: int`, `react: bool`. Pure `_validate_reply_fields(data, text)` → `(error_string_or_None, reply_id_or_None, react_bool)`. Phase 6b's dashboard forwards these fields.

- [ ] **Step 1: Write the failing tests**

```python
# ---------- Task 6: send API validation ----------

def _vrf():
    fn, _ = _extract("_validate_reply_fields")
    return fn

def test_reply_fields_absent_ok():
    assert _vrf()({}, "hi") == (None, None, False)

def test_reply_id_valid():
    assert _vrf()({"reply_id": 1}, "hi") == (None, 1, False)
    assert _vrf()({"reply_id": 0xFFFFFFFF}, "hi") == (None, 0xFFFFFFFF, False)

def test_reply_id_invalid():
    assert _vrf()({"reply_id": 0}, "hi")[0] is not None
    assert _vrf()({"reply_id": -5}, "hi")[0] is not None
    assert _vrf()({"reply_id": 0x100000000}, "hi")[0] is not None
    assert _vrf()({"reply_id": "12"}, "hi")[0] is not None
    assert _vrf()({"reply_id": True}, "hi")[0] is not None    # bool is not an int here

def test_react_requires_reply_id():
    assert _vrf()({"react": True}, "👍")[0] is not None

def test_react_caps_text_bytes():
    ok = _vrf()({"react": True, "reply_id": 5}, "👍")
    assert ok == (None, 5, True)
    assert _vrf()({"react": True, "reply_id": 5}, "way too long")[0] is not None

def test_react_multibyte_emoji_within_cap():
    assert _vrf()({"react": True, "reply_id": 5}, "🙏")[0] is None   # 4 bytes

def test_do_post_source_routes_react_to_tapback():
    assert "_validate_reply_fields(data, text)" in SRC
    assert "_send_tapback(" in SRC
    assert "replyId=reply_id" in SRC
```

- [ ] **Step 2: Run to verify FAIL**: `python -m pytest test_bridge_replies.py -k "reply_fields or react or do_post" -v`

- [ ] **Step 3: Implement.** Pure validator above `SendHandler`:

```python
def _validate_reply_fields(data, text):
    """Validate the optional reply/react send fields. Returns (error, reply_id, react).
    reply_id: mesh packet id being replied/reacted to, 1..0xFFFFFFFF.
    react: emoji tapback — requires reply_id, text capped at 8 bytes (an emoji)."""
    reply_id = data.get("reply_id")
    react = data.get("react", False)
    if reply_id is not None:
        if isinstance(reply_id, bool) or not isinstance(reply_id, int) or not (1 <= reply_id <= 0xFFFFFFFF):
            return "reply_id must be an integer 1..4294967295", None, False
    if react is not False and react is not True:
        return "react must be a boolean", None, False
    if react and reply_id is None:
        return "react requires reply_id", None, False
    if react and len(text.encode()) > 8:
        return "a reaction is a single emoji (max 8 bytes)", None, False
    return None, reply_id, react
```

In `do_POST`, after the existing `channel not allowed` check and before the rate-limit check, add:

```python
        err, reply_id, react = _validate_reply_fields(data, text)
        if err:
            return self._reply(400, {"error": err})
```

Replace the send block:

```python
        try:
            # 5a: wantAck=True is the OWNED TX change — operator sends now request a
            # delivery ACK (destination transmits an ack; firmware retransmits <=3x).
            if react:
                if to:
                    pkt = _send_and_log(lambda: _send_tapback(iface, text, reply_id, destinationId=to),
                                        to, node_display(iface, to), ch, True, False, text,
                                        reply_to_id=reply_id, is_reaction=1)
                else:
                    pkt = _send_and_log(lambda: _send_tapback(iface, text, reply_id, channelIndex=ch),
                                        "dashboard", "Dashboard", ch, False, False, text,
                                        reply_to_id=reply_id, is_reaction=1)
            elif to:
                pkt = _send_and_log(lambda: iface.sendText(text, destinationId=to, wantAck=True, replyId=reply_id),
                                    to, node_display(iface, to), ch, True, False, text, reply_to_id=reply_id)
            else:
                pkt = _send_and_log(lambda: iface.sendText(text, channelIndex=ch, wantAck=True, replyId=reply_id),
                                    "dashboard", "Dashboard", ch, False, False, text, reply_to_id=reply_id)
        except Exception as e:
            log("sendapi radio send failed: {}".format(e))
            return self._reply(502, {"error": "radio send failed"})
```

(The existing TX log line below it stays; `replyId=None` on `sendText` is the library default — a plain send is byte-identical to today's.)

- [ ] **Step 4: Run everything**: `python -m pytest test_bridge_replies.py test_bridge_acks.py test_bridge_v6.py test_bridge_v9.py test_bridge_v10.py -q` → ALL PASS + ast parse check.

- [ ] **Step 5: Commit**: `git add -u && git commit -m "feat(bridge/6a): send API reply_id + react (tapback path)"`

---

### Task 7: Version bump + deploy + soak

**Files:**
- Modify: `projects/project-nomad/mesh-ai-bridge/bridge.py` (startup log line, ~1319; module docstring first line)

- [ ] **Step 1: Bump the version strings** — startup log `"mesh-ai-bridge v11 starting"` → `v12`; add a `v12` paragraph to the module docstring:

```
v12 adds replies & reactions: msg_log stores every message's mesh packet id, reply target
(reply_to_id) and tapback flag (is_reaction); the send API accepts reply_id (quoted reply)
and react (emoji tapback via hand-built packet — no public API sets Data.emoji); @ai answers
quote the question on their first chunk. Additive only.
```

- [ ] **Step 2: Full test suite one last time**: `python -m pytest test_bridge_replies.py test_bridge_acks.py test_bridge_v6.py test_bridge_v9.py test_bridge_v10.py -q` → ALL PASS. Commit: `git commit -am "feat(bridge/6a): v12 version bump"`.

- [ ] **Step 3: Build on aibox** (bridge build dir is `/opt/mesh-ai-bridge` which is Aaron-write-only for code — so stage via scp to a HOME build dir instead):

```bash
scp bridge.py Dockerfile aibox:/tmp/bridge-v12/     # mkdir -p /tmp/bridge-v12 first
ssh aibox 'docker build -q -t ghcr.io/aebconsulting/mesh-ai-bridge:v6 /tmp/bridge-v12'
```

- [ ] **Step 4: AARON pushes** `ghcr.io/aebconsulting/mesh-ai-bridge:v6` (classifier-gated; also mirror bridge.py to `/opt/mesh-ai-bridge` at his discretion).

- [ ] **Step 5: PUT the bridge custom app** to image `:v6` — GET `/api/system/services/custom/nomad_custom_mesh_ai_bridge` → `.app`, PUT back with ONLY the image tag changed (FULL env list verbatim — omitting env deletes it), `force:true`. Poll `docker inspect nomad_custom_mesh_ai_bridge --format '{{.Config.Image}}'` until `:v6`, then `docker logs --tail 5` shows `mesh-ai-bridge v12 starting`.

- [ ] **Step 6: Soak verification** (same clock discipline as 5a — a few hours minimum):

```bash
ssh aibox "sqlite3 'file:/opt/mesh-ai-bridge/memory.db?mode=ro' \
  'SELECT direction, mesh_id, reply_to_id, is_reaction, substr(text,1,20) FROM msg_log ORDER BY id DESC LIMIT 20'"
```

Expected: inbound rows now carry `mesh_id`; any live tapback shows `is_reaction=1` with its target in `reply_to_id`. Rollback = PUT `:v5` (columns stay, simply unwritten — dashboard feature-detect degrades per the spec matrix).

## Self-review notes

- Spec coverage: schema ✓ (T1), inbound capture ✓ (T5), tapback guard ✓ (T5), send API ✓ (T6), tapback helper ✓ (T4), @ai quoting ✓ (T5), delivery tracking on replies/reactions ✓ (T3), deploy/soak ✓ (T7).
- Queue/worker/`handle_query` untouched — quoting handled entirely by the `make_quoted_send` closure.
- `is_reaction` uses 1/None (never 0) so NULL semantics match old rows.
