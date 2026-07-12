# Phase 5a — Bridge Delivery Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mesh AI bridge records each outbound packet's id and its ACK/NAK state into `memory.db` so Meridian can show honest per-message delivery status — additive, no change to what/whether text is sent except an explicit `wantAck=True` on operator sends.

**Architecture:** Additive `msg_log` columns (`mesh_id`, `ack_state`) via the existing duplicate-column-safe migration. A single `_send_and_log` helper replaces the 4 send sites so a send's radio phase, id-extraction phase, and log phase can't cross-contaminate. A new isolated `on_routing` pubsub co-subscriber (the `on_neighbor` pattern) correlates ROUTING_APP ACK/NAK packets to outstanding sends by exact `requestId`. Health counters make every failure path visible in `/api/health`.

**Tech Stack:** Python 3, meshtastic-python 2.7.10 (TCPInterface via MeshMonitor VNS :4404), sqlite3 (WAL), pypubsub. Bridge deploys as a NOMAD custom app image `ghcr.io/aebconsulting/mesh-ai-bridge:v5`.

## Global Constraints (from spec §2–§4)

- **THE GATE (§3): the live radio probe MUST pass before any code in this plan runs.** If the probe fails, this plan stops. See Task 0.
- Bridge source: `C:\Users\AB Digial\projects\project-nomad\mesh-ai-bridge\bridge.py` (aibox `/opt/mesh-ai-bridge/bridge.py`, baked into the image at `/app/bridge.py`). memory.db is the `/data` volume — NOT shadowed by the image.
- **`onResponse`/`onAckNak` is forbidden** — one-shot handler latches the transmit-ACK as delivered. Use a `meshtastic.receive` ROUTING_APP co-subscriber.
- ACK correlation: exact `requestId` match, recency-fenced to 300s, `ORDER BY ts DESC LIMIT 1`, `ack_state IS NULL` — never "most recent unacked" without the id.
- ACKs are unauthenticated RF: state is display-only, drives NO automation.
- `ack_state` vocabulary: NULL · `radio-accepted` · `ack` (DM end-to-end) · `relayed` (broadcast) · `failed:<REASON>`.
- Migration is duplicate-column-safe (the `_add_cols` helper, bridge.py:140-151).
- All new handlers fully `try/except`-wrapped; a failure increments a counter BEFORE logging.
- **Aaron-only steps** (auto-mode classifier blocks the agent): the Task 0 probe, every ghcr push, every direct write to the live radio host `/opt/mesh-ai-bridge`. The agent builds the image on aibox, prepares code, and does NOMAD PUTs. Each Aaron step gives the exact command.
- Deploy: PUT `/api/system/services/custom` with FULL config (never POST `/update`). Rollback = bridge `:v4`.
- After deploy: **soak 24–48h and verify with a live query** that ACK rows land — never report success from inference (CLAUDE.md).

## File Structure

- Modify: `bridge.py` migration block (`db()`, ~line 128-165) — add `mesh_id`/`ack_state` cols + index
- Modify: `bridge.py` `log_traffic` (line 168) — accept `mesh_id`/`ack_state` kwargs
- Create in `bridge.py`: `_send_and_log(...)` helper (near the send sites)
- Modify: `bridge.py` 4 send sites (903, 906 in SendHandler; 1068, 1075 in on_receive) — route through the helper; add `wantAck=True` to 903/906
- Create in `bridge.py`: `on_routing(packet, interface)` co-subscriber + its `pub.subscribe` registration (~line 1199)
- Modify: `bridge.py` health counters (module globals + `do_GET` `/api/health` dict, line 866)
- Modify: `bridge.py` startup smoke check (in `main`, near the pub.subscribe block)
- Test: `C:\Users\AB Digial\projects\project-nomad\mesh-ai-bridge\test_bridge_acks.py` (new — pure-function tests; the bridge has no existing test file, so this establishes one runnable without a radio)

Note the bridge is not import-clean without a radio (it connects at import). Tests target the pure logic by importing the module with env guards OR by testing extracted pure functions. The plan extracts the ACK state decision into a pure function `ack_state_for(errorReason, from_num, dest_num, my_num, is_dm)` precisely so it's unit-testable without a live interface.

---

### Task 0: THE GATE — live radio probe (AARON ONLY)

**No code ships until this passes.** This is the spec §3 blocker.

- [ ] **Step 1 [AARON]: Run the probe.** On aibox, in a python env with meshtastic + a 2nd device reachable on the mesh:

```python
# probe_acks.py — run on aibox: python3 probe_acks.py
import time
from pubsub import pub
import meshtastic.tcp_interface as tcp

SEEN = []
def on_routing(packet=None, interface=None):
    d = (packet or {}).get("decoded", {}) or {}
    if d.get("portnum") != "ROUTING_APP":
        return
    SEEN.append({
        "requestId": d.get("requestId"),
        "errorReason": (d.get("routing") or {}).get("errorReason"),
        "from": packet.get("from"), "fromId": packet.get("fromId"),
    })
    print("ROUTING:", SEEN[-1])

pub.subscribe(on_routing, "meshtastic.receive")
iface = tcp.TCPInterface("127.0.0.1", portNumber=4404)   # the VNS
my = iface.getMyNodeInfo()["num"]; print("my_num:", my)

DEST = "!XXXXXXXX"   # <-- AARON: the 2nd device's node id
pkt = iface.sendText("ack probe DM", destinationId=DEST, wantAck=True)
print("SENT DM id:", pkt.id)
time.sleep(20)   # wait for both routing packets

pktb = iface.sendText("ack probe BCAST", channelIndex=0, wantAck=True)
print("SENT BCAST id:", pktb.id)
time.sleep(20)
iface.close()
print("\nSUMMARY: sent DM id", pkt.id, "bcast id", pktb.id)
print("routing packets seen:", SEEN)
```

- [ ] **Step 2 [AARON]: Report the result** (paste to the agent). PASS requires ALL of:
  - `pkt.id` is a nonzero int (Claim 1).
  - A ROUTING packet arrives with `requestId == pkt.id` (Claim 2 — the correlation key survives the VNS).
  - The DM's end-to-end ACK has `from == <2nd device num>` and no `errorReason` (success); the broadcast's implicit ACK has `from == my_num` (distinguishable — Claim 3).
- [ ] **Step 3 [AGENT]: GO/NO-GO.** PASS → proceed to Task 1. If `pkt.id` is 0/None, or no routing packet matches `requestId`, or the VNS doesn't forward ROUTING_APP → **STOP**, report to Aaron, do not write 5a. (5b/analyst can still ship on today's data.)

---

### Task 1: Schema migration — `mesh_id` + `ack_state`

**Files:**
- Modify: `bridge.py` `db()` migration block (after the v9 `_add_cols(c, "nodes", ...)` call, ~line 159)
- Test: `test_bridge_acks.py`

**Interfaces:**
- Produces: `msg_log` columns `mesh_id INTEGER`, `ack_state TEXT`; index `idx_msg_log_mesh_id`.

- [ ] **Step 1: Write the failing test** (`test_bridge_acks.py`)

```python
import sqlite3, os, tempfile

def _apply_migration(dbpath):
    # Mirrors bridge.py db() column-add for msg_log; the test proves it's idempotent.
    c = sqlite3.connect(dbpath)
    c.execute("CREATE TABLE IF NOT EXISTS msg_log(id INTEGER PRIMARY KEY, ts REAL, direction TEXT, "
              "node_id TEXT, node_name TEXT, channel INTEGER, is_dm INTEGER, is_ai INTEGER, text TEXT)")
    have = {r[1] for r in c.execute("PRAGMA table_info(msg_log)")}
    for name, decl in [("mesh_id", "INTEGER"), ("ack_state", "TEXT")]:
        if name not in have:
            try:
                c.execute("ALTER TABLE msg_log ADD COLUMN {} {}".format(name, decl))
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_log_mesh_id ON msg_log(mesh_id)")
    c.commit()
    return c

def test_migration_adds_columns_idempotently():
    d = tempfile.mkdtemp(); p = os.path.join(d, "m.db")
    _apply_migration(p).close()
    _apply_migration(p).close()  # second run must not raise
    c = sqlite3.connect(p)
    cols = {r[1] for r in c.execute("PRAGMA table_info(msg_log)")}
    assert "mesh_id" in cols and "ack_state" in cols
    idx = {r[1] for r in c.execute("PRAGMA index_list(msg_log)")}
    assert "idx_msg_log_mesh_id" in idx
```

- [ ] **Step 2: Run it — expect PASS** (the test embeds its own migration copy; this is the reference the bridge edit must match). Run: `cd "C:\Users\AB Digial\projects\project-nomad\mesh-ai-bridge" && python -m pytest test_bridge_acks.py::test_migration_adds_columns_idempotently -v`

- [ ] **Step 3: Apply the same migration in `bridge.py`** — after line 159 (`("rssi", ...)]` block for nodes), add:

```python
    # 5a: per-message delivery tracking — the outbound packet id + its ACK/NAK state.
    _add_cols(c, "msg_log", [("mesh_id", "INTEGER"), ("ack_state", "TEXT")])
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_log_mesh_id ON msg_log(mesh_id)")
```

- [ ] **Step 4: Verify the bridge migration matches the test** — read back the edited block; confirm the column names/types/index name are byte-identical to the test's `_apply_migration`.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\AB Digial\projects\project-nomad\mesh-ai-bridge"
git add bridge.py test_bridge_acks.py
git commit -m "feat(bridge/5a): msg_log gains mesh_id + ack_state (duplicate-column-safe)"
```

---

### Task 2: `log_traffic` accepts `mesh_id`/`ack_state`

**Files:**
- Modify: `bridge.py` `log_traffic` (line 168-175)

**Interfaces:**
- Consumes: the Task 1 columns.
- Produces: `log_traffic(direction, node_id, node_name, channel, is_dm, is_ai, text, mesh_id=None, ack_state=None)` — trailing kwargs, backward-compatible with every existing call.

- [ ] **Step 1: Replace `log_traffic`** (keep the never-raise contract):

```python
def log_traffic(direction, node_id, node_name, channel, is_dm, is_ai, text, mesh_id=None, ack_state=None):
    try:
        with db() as c:
            c.execute("INSERT INTO msg_log(ts, direction, node_id, node_name, channel, is_dm, is_ai, text, mesh_id, ack_state) "
                      "VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (time.time(), direction, node_id, node_name, channel, int(is_dm), int(is_ai), text, mesh_id, ack_state))
    except Exception as e:
        log("msg_log write failed: {}".format(e))
```

- [ ] **Step 2: Verify existing callers still type-check** — grep every `log_traffic(` call and confirm each still passes (the new params default to None). Run: `grep -n "log_traffic(" bridge.py`
Expected: the inbound-logging calls in `on_receive` (unchanged) plus the send-site calls Task 4 will rewrite — all still valid positionally.

- [ ] **Step 3: Commit** — `git add bridge.py && git commit -m "feat(bridge/5a): log_traffic accepts mesh_id/ack_state kwargs"`

---

### Task 3: Pure ACK-state decision function

**Files:**
- Create in `bridge.py`: `ack_state_for(...)` (above `on_receive`)
- Test: `test_bridge_acks.py`

**Interfaces:**
- Produces: `ack_state_for(error_reason: str | None, from_num: int | None, dest_num: int | None, my_num: int | None, is_dm: bool) -> str` returning one of `radio-accepted` / `ack` / `relayed` / `failed:<REASON>`.

- [ ] **Step 1: Write the failing tests**

```python
# in test_bridge_acks.py — import the pure function without starting a radio
import importlib.util, sys, types

def _load_ack_state_for():
    # The function is pure; extract it via exec of its source to avoid importing
    # the whole radio-connecting module. In the real repo, import from bridge once
    # the module is import-safe; here we test the contract.
    ns = {}
    exec(ACK_STATE_FOR_SRC, ns)  # ACK_STATE_FOR_SRC pasted from bridge.py in Step 3
    return ns["ack_state_for"]

def test_dm_end_to_end_ack():
    f = _load_ack_state_for()
    assert f(None, 42, 42, 7, True) == "ack"          # from == dest, success
def test_dm_local_transmit_ack_is_radio_accepted():
    f = _load_ack_state_for()
    assert f(None, 7, 42, 7, True) == "radio-accepted" # from == my_num, not dest
def test_broadcast_success_is_relayed():
    f = _load_ack_state_for()
    assert f(None, 7, None, 7, False) == "relayed"     # broadcast has no dest
def test_nak_carries_reason():
    f = _load_ack_state_for()
    assert f("NO_ROUTE", 42, 42, 7, True) == "failed:NO_ROUTE"
def test_nak_none_string_is_success():
    f = _load_ack_state_for()
    assert f("NONE", 42, 42, 7, True) == "ack"         # "NONE"/"" == success sentinel
```

- [ ] **Step 2: Run — expect FAIL** (`ACK_STATE_FOR_SRC` undefined). Run: `python -m pytest test_bridge_acks.py -k ack -v`

- [ ] **Step 3: Add the function to `bridge.py`** (above `on_receive`, ~line 1044) AND paste its exact source into the test as `ACK_STATE_FOR_SRC`:

```python
def ack_state_for(error_reason, from_num, dest_num, my_num, is_dm):
    """Map a ROUTING_APP packet's fields to an ack_state token. Pure — no I/O.
    error_reason: routing.errorReason string; None/""/"NONE" == success.
    Success semantics: DM ack from the destination = 'ack'; a success ACK from
    our own node (implicit transmit ack) = 'radio-accepted'; any success on a
    broadcast (no destination) = 'relayed' (a neighbor rebroadcast, NOT delivery)."""
    if error_reason and str(error_reason).upper() not in ("NONE", ""):
        return "failed:{}".format(error_reason)
    if is_dm and dest_num is not None and from_num == dest_num:
        return "ack"
    if not is_dm:
        return "relayed"
    return "radio-accepted"
```

- [ ] **Step 4: Run — expect PASS.** Run: `python -m pytest test_bridge_acks.py -k ack -v` → 5 passed.

- [ ] **Step 5: Commit** — `git add bridge.py test_bridge_acks.py && git commit -m "feat(bridge/5a): pure ack_state_for decision function + tests"`

---

### Task 4: `_send_and_log` helper + rewire the 4 send sites (adds wantAck to operator sends)

**Files:**
- Create in `bridge.py`: `_send_and_log(...)` (above `SendHandler`, ~line 842)
- Modify: `bridge.py` SendHandler send block (901-911), on_receive AI-reply lambdas (1068, 1075)
- Modify: module globals — add `sends_without_id = 0`

**Interfaces:**
- Consumes: `log_traffic` (Task 2).
- Produces: `_send_and_log(send_fn, node_id, node_name, ch, is_dm, is_ai, text) -> packet` — calls `send_fn()`, logs an outbound row with the returned packet's `.id` (or None + counter), returns the packet. On send failure logs a `failed` row and re-raises.

- [ ] **Step 1: Write the failing test** (helper logic, radio + db mocked)

```python
def test_send_and_log_records_id_on_success():
    calls = {}
    class Pkt: id = 12345
    logged = []
    def fake_log(*a, **k): logged.append(k)
    pkt = _run_send_and_log(lambda: Pkt(), fake_log)   # harness wires the helper w/ injected log
    assert pkt.id == 12345
    assert logged[-1]["mesh_id"] == 12345 and logged[-1]["ack_state"] is None

def test_send_and_log_failed_row_on_raise():
    logged = []
    def fake_log(*a, **k): logged.append(k)
    raised = False
    try:
        _run_send_and_log(_raise, fake_log)
    except RuntimeError:
        raised = True
    assert raised and logged[-1]["ack_state"] == "failed" and logged[-1]["mesh_id"] is None

def test_send_and_log_idless_pkt_counts():
    class Pkt: pass   # no .id
    logged = []
    n0 = _sends_without_id_count()
    _run_send_and_log(lambda: Pkt(), lambda *a, **k: logged.append(k))
    assert logged[-1]["mesh_id"] is None
    assert _sends_without_id_count() == n0 + 1
```
(The harness `_run_send_and_log` / `_raise` / `_sends_without_id_count` wrap the real helper with an injected log fn and read the module counter — paste the helper source per Step 3, same pattern as Task 3.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the helper + counter to `bridge.py`.** Near the other module counters add `sends_without_id = 0`. Above `SendHandler`:

```python
def _send_and_log(send_fn, node_id, node_name, ch, is_dm, is_ai, text):
    """Three phases that must not cross-contaminate: (1) radio send — a raise here
    is a REAL send failure, recorded as a 'failed' row and re-raised; (2) id
    extraction — can NEVER turn a successful send into a failure; a missing id
    means a permanently glyphless row, counted; (3) log — log_traffic never raises."""
    global sends_without_id
    try:
        pkt = send_fn()
    except Exception:
        log_traffic("out", node_id, node_name, ch, is_dm, is_ai, text, mesh_id=None, ack_state="failed")
        raise
    mesh_id = getattr(pkt, "id", None)
    if mesh_id is None:
        sends_without_id += 1
        log("send returned no packet id — row will stay glyphless")
    log_traffic("out", node_id, node_name, ch, is_dm, is_ai, text, mesh_id=mesh_id, ack_state=None)
    return pkt
```

- [ ] **Step 4: Rewire SendHandler (901-911)** — replace the try/except send block:

```python
        try:
            if to:
                pkt = _send_and_log(lambda: iface.sendText(text, destinationId=to, wantAck=True),
                                    to, node_display(iface, to), ch, True, False, text)
            else:
                pkt = _send_and_log(lambda: iface.sendText(text, channelIndex=ch, wantAck=True),
                                    "dashboard", "Dashboard", ch, False, False, text)
        except Exception as e:
            log("sendapi radio send failed: {}".format(e))
            return self._reply(502, {"error": "radio send failed"})
        log("sendapi TX {} {}B id={}: {}".format("dm " + to if to else "ch{}".format(ch),
            len(text.encode()), getattr(pkt, "id", None), repr(text)))
        self._reply(200, {"ok": True})
```
(This adds `wantAck=True` to both operator sends per spec §2 — the owned TX change.)

- [ ] **Step 5: Rewire the two on_receive AI-reply lambdas (1067-1075)** — they already send-then-index via `(log_traffic(...), sendText(...))[1]`; replace each with the helper so the id is captured:

```python
                # DM reply — was: (log_traffic(...), sendText(..., wantAck=True))[1]
                _send_and_log(lambda: interface.sendText(c, destinationId=sender, wantAck=True),
                              sender, node_display(interface, sender), ch, True, True, c)
```
and the broadcast branch:
```python
                _send_and_log(lambda: interface.sendText(c, channelIndex=ch, wantAck=True),
                              "dashboard", "Dashboard", ch, False, True, c)
```
Read the exact current lines 1064-1076 first and preserve the surrounding chunk loop / variable names (`c`, `sender`, `ch`).

- [ ] **Step 6: Run helper tests — expect PASS.** Run: `python -m pytest test_bridge_acks.py -k send_and_log -v`

- [ ] **Step 7: Read back all 4 sites** — confirm no lambda still uses the old `(log_traffic(...), sendText(...))[1]` tuple form and every send now has `wantAck=True`.

- [ ] **Step 8: Commit** — `git add bridge.py test_bridge_acks.py && git commit -m "feat(bridge/5a): _send_and_log helper; 4 send sites capture packet id; wantAck on operator sends"`

---

### Task 5: `on_routing` ACK co-subscriber + health counters

**Files:**
- Create in `bridge.py`: `on_routing(packet, interface)` (after `on_direct_neighbor`, ~line 1160)
- Modify: `bridge.py` module globals — `acks_seen = acks_matched = ack_orphans = ack_db_errors = 0`, `last_ack_ts = 0.0`, `_ack_confirmed = False`
- Modify: `bridge.py` `do_GET` /api/health dict (866-868)
- Modify: `bridge.py` `pub.subscribe` block (~1199) + startup smoke check

**Interfaces:**
- Consumes: `ack_state_for` (Task 3), the Task 1 columns, `my_num` (module global, already set on connect).
- Produces: ACK rows written into `msg_log.ack_state`; counters surfaced in `/api/health`.

- [ ] **Step 1: Add the counters** (module globals near `send_api_alive`):

```python
acks_seen = acks_matched = ack_orphans = ack_db_errors = 0
last_ack_ts = 0.0
_ack_confirmed = False   # one-shot loud confirmation ACK tracking works on this mesh
```

- [ ] **Step 2: Write `on_routing`** (co-subscriber, fully isolated — the on_neighbor pattern):

```python
def on_routing(packet=None, interface=None):
    """5a: correlate ROUTING_APP ACK/NAK packets to an outstanding outbound send by
    exact requestId, recency-fenced. Fully isolated co-subscriber to meshtastic.receive —
    a failure here must never touch text handling. ACKs are unauthenticated: state is
    display-only, drives no automation."""
    global acks_seen, acks_matched, ack_orphans, ack_db_errors, last_ack_ts, _ack_confirmed
    try:
        dec = (packet or {}).get("decoded", {}) or {}
        if dec.get("portnum") != "ROUTING_APP":
            return
        req = dec.get("requestId")
        if req is None:
            return
        acks_seen += 1
        last_ack_ts = time.time()
        err = (dec.get("routing") or {}).get("errorReason")
        from_num = packet.get("from")
        # Look up the outstanding row to learn dest + is_dm, then set state.
        with db() as c:
            row = c.execute(
                "SELECT id, node_id, is_dm FROM msg_log WHERE mesh_id=? AND direction='out' "
                "AND ack_state IS NULL AND ts > ? ORDER BY ts DESC LIMIT 1",
                (req, time.time() - 300)).fetchone()
            if row is None:
                ack_orphans += 1
                return
            row_id, dest_id, is_dm = row[0], row[1], bool(row[2])
            dest_num = None
            if dest_id and dest_id.startswith("!"):
                try:
                    dest_num = int(dest_id[1:], 16)
                except ValueError:
                    dest_num = None
            state = ack_state_for(err, from_num, dest_num, my_num, is_dm)
            c.execute("UPDATE msg_log SET ack_state=? WHERE id=?", (state, row_id))
            acks_matched += 1
            if not _ack_confirmed:
                _ack_confirmed = True
                log("ACK TRACKING CONFIRMED — first ROUTING ack matched msg_log row {} -> {}".format(row_id, state))
    except Exception as e:
        ack_db_errors += 1   # increment BEFORE logging so a log-format throw still counts
        log("routing handler error: {}".format(e))
```

- [ ] **Step 3: Register the subscriber** — in the `pub.subscribe` block (~1199), add:

```python
    pub.subscribe(on_routing, "meshtastic.receive")   # 5a: capture ACK/NAK for delivery tracking
```

- [ ] **Step 4: Startup smoke check** — after the subscribe block, add:

```python
    if not hasattr(iface, "sendText"):
        log("CRITICAL: meshtastic interface has no sendText — ACK tracking + sends will fail")
```

- [ ] **Step 5: Surface counters in `/api/health`** — extend the `do_GET` dict (866-868):

```python
        self._reply(200, {"ok": iface is not None and node_info_ok, "node": node,
                          "api": send_api_alive, "queue_depth": work_q.qsize(), "worker": worker_alive,
                          "worker_idle_s": round(time.time() - last_progress_ts, 1),
                          "acks_seen": acks_seen, "acks_matched": acks_matched,
                          "ack_orphans": ack_orphans, "ack_db_errors": ack_db_errors,
                          "sends_without_id": sends_without_id,
                          "last_ack_ts": last_ack_ts or None})
```

- [ ] **Step 6: Write the correlation test** (`test_bridge_acks.py`, sqlite-backed, on_routing logic mirrored)

```python
def test_orphan_ack_increments_counter_no_crash():
    # An ACK whose requestId matches no outstanding row is counted, not applied.
    d = tempfile.mkdtemp(); p = os.path.join(d, "m.db"); _apply_migration(p).close()
    c = sqlite3.connect(p)
    # no outbound row with mesh_id=999
    row = c.execute("SELECT id FROM msg_log WHERE mesh_id=999 AND direction='out' "
                    "AND ack_state IS NULL AND ts > ? ORDER BY ts DESC LIMIT 1",
                    (time.time()-300,)).fetchone()
    assert row is None   # -> on_routing would take the ack_orphans path

def test_ack_matches_recent_out_row_by_id():
    d = tempfile.mkdtemp(); p = os.path.join(d, "m.db"); _apply_migration(p).close()
    c = sqlite3.connect(p)
    c.execute("INSERT INTO msg_log(ts,direction,node_id,is_dm,text,mesh_id,ack_state) "
              "VALUES(?,?,?,?,?,?,NULL)", (time.time(), "out", "!0000002a", 1, "hi", 777))
    c.commit()
    row = c.execute("SELECT id, node_id, is_dm FROM msg_log WHERE mesh_id=777 AND direction='out' "
                    "AND ack_state IS NULL AND ts > ? ORDER BY ts DESC LIMIT 1",
                    (time.time()-300,)).fetchone()
    assert row is not None and bool(row[2]) is True
    # dest !0000002a -> 42; a success ack from 42 == 'ack'
    from_num, dest_num, my_num = 42, int("0000002a", 16), 7
    # ack_state_for is the pure fn under test in Task 3
```

- [ ] **Step 7: Run — expect PASS.** Run: `python -m pytest test_bridge_acks.py -v` → all green.

- [ ] **Step 8: Commit** — `git add bridge.py test_bridge_acks.py && git commit -m "feat(bridge/5a): on_routing ACK co-subscriber + health counters + startup smoke check"`

---

### Task 6: Build, deploy, soak, verify live

- [ ] **Step 1 [AGENT]: Sync code to aibox build dir + build the image.** The bridge lives in the monorepo `projects/project-nomad/mesh-ai-bridge/`. Aaron writes the live radio host, but the agent builds:

```bash
scp "C:/Users/AB Digial/projects/project-nomad/mesh-ai-bridge/bridge.py" aibox:/tmp/bridge-v5.py
# AARON confirms placing it: the build dir /opt/mesh-ai-bridge is the radio host (classifier-blocked for the agent)
```
**[AARON] places the file + builds:**
```bash
ssh aibox "cp /tmp/bridge-v5.py /opt/mesh-ai-bridge/bridge.py && docker build -t ghcr.io/aebconsulting/mesh-ai-bridge:v5 /opt/mesh-ai-bridge"
```

- [ ] **Step 2 [AARON]: ghcr push** (package MUST stay public):

```bash
ssh aibox "docker push ghcr.io/aebconsulting/mesh-ai-bridge:v5"
```

- [ ] **Step 3 [AGENT]: NOMAD PUT to `:v5`** — GET `/api/system/services/custom/nomad_custom_mesh_ai_bridge` → `.app`, set `image: ...:v5`, keep FULL env (omitting deletes it), `force:true`, PUT `/api/system/services/custom`; poll `docker inspect nomad_custom_mesh_ai_bridge --format '{{.Config.Image}}'` until `:v5`. Rollback = PUT back to `:v4`.

- [ ] **Step 4 [AGENT]: Immediate smoke** — `docker logs nomad_custom_mesh_ai_bridge` shows the migration ran + no CRITICAL smoke-check line; `curl` the bridge `/api/health` (via its container/gateway) → the new counter keys present, `ok:true`.

- [ ] **Step 5 [AARON/AGENT]: Live send + confirm the loop.** From Meridian, send a DM to a reachable device; within ~30s:
```bash
ssh aibox "python3 -c \"import sqlite3,time; c=sqlite3.connect('file:/opt/mesh-ai-bridge/memory.db?mode=ro',uri=True); print(c.execute('SELECT ts,ack_state,mesh_id,text FROM msg_log WHERE direction=\\\"out\\\" ORDER BY ts DESC LIMIT 3').fetchall())\""
```
Expect the newest row to have a non-null `mesh_id` and an `ack_state` progressing to `ack`/`radio-accepted` (DM) — and the bridge log to show the one-shot "ACK TRACKING CONFIRMED" line.

- [ ] **Step 6: SOAK 24–48h, then verify with a live query** (never report success from inference):
```bash
ssh aibox "python3 -c \"import sqlite3; c=sqlite3.connect('file:/opt/mesh-ai-bridge/memory.db?mode=ro',uri=True); print(c.execute('SELECT ack_state, COUNT(*) FROM msg_log WHERE direction=\\\"out\\\" AND ts > strftime(\\\"%s\\\",\\\"now\\\")-172800 GROUP BY 1').fetchall())\""
```
Expect a distribution of `ack`/`relayed`/`radio-accepted`/`failed:*`/NULL — NOT all-NULL (all-NULL after a busy 48h = the correlation is silently broken; investigate before 5b renders glyphs).

- [ ] **Step 7: Commit deploy notes** — record the `:v5` tag + soak result in the monorepo; update the CLAUDE.md bridge bullet to `:v5` once the soak passes.

---

## Self-review notes
- Spec §3 (probe) → Task 0. §4.1 (schema) → Task 1. §4.2 (send-then-log + wantAck) → Task 4. §4.3 (pubsub correlation, exact requestId, recency fence) → Tasks 3+5. §4.4 (counters, one-shot log, increment-before-log) → Task 5. §4.5 (deploy/soak/live-verify) → Task 6.
- Types consistent: `ack_state_for` signature identical in Task 3 def and Task 5 call; `_send_and_log` signature identical in Task 4 def and both call sites.
- The bridge has no pre-existing test file; Task 1 establishes `test_bridge_acks.py` with radio-free pure-logic tests (the module connects a radio at import, so tests target extracted pure functions + sqlite mirrors, never import-and-run the whole bridge).
