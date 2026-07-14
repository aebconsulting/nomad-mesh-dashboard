# Mesh Traceroute (bridge v17 + Meridian v30) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator-triggered mesh traceroutes from the Meridian dashboard — hop chain with per-hop SNR both directions, drawn on the map.

**Architecture:** Bridge v17 adds `POST /api/traceroute` to the existing send API (:8700): it fires a non-blocking `sendData(RouteDiscovery, wantResponse=True)` and records a `pending` row in a new `traceroutes` table in memory.db; an isolated pubsub co-subscriber (same pattern as v11's `on_routing` ACK tracker) correlates the `TRACEROUTE_APP` response by `requestId` and fills in the route. The dashboard (v30) proxies the POST (CSRF + rate bucket, token server-side) and reads results straight from memory.db read-only; NodeDetail gets a "Trace route" button + hop-chain panel, MeshMap draws the route as a polyline.

**Tech Stack:** Python 3.12 (bridge: stdlib http.server + meshtastic 2.7.10 + sqlite; dashboard backend: FastAPI + httpx), React+TS (frontend), MapLibre GL.

## Global Constraints

- **NEVER call `interface.sendTraceRoute()`** — verified in the deployed lib source: it BLOCKS (internal `waitForTraceRoute`), prints to stdout, and RAISES `MeshInterfaceError` on timeout. Use `sendData(..., wantResponse=True)` with no `onResponse` and correlate via co-subscriber.
- Firmware rate-limits traceroutes (~30s). Bridge enforces a GLOBAL 35s cooldown (`TRACEROUTE_COOLDOWN_S`); surface 429 honestly, never queue.
- Honest results only: `pending` → `ok` / `failed:<REASON>` / `timeout`. Never render a route that wasn't received (same honesty rule as 5a delivery glyphs).
- SNR wire format is **dB×4**, `-128` = unknown. Protobuf→dict via json_format **omits empty/default fields** — absent `route`/`snrBack` keys mean empty lists, and camelCase keys (`snrTowards`, `routeBack`, `snrBack`).
- `route`/`routeBack` contain **intermediate hops only**: full chain towards = base → route[…] → destination; `snrTowards` has `len(route)+1` entries (last = destination's own reading).
- Bridge code is edited in `C:\Users\AB Digial\projects\project-nomad\mesh-ai-bridge\` (monorepo build dir), tests run there (`python -m pytest -q`, currently 115 passing), then synced to the public clone `projects\mesh-ai-bridge` with `tr -d '\r'`. Dashboard canonical repo = `projects\nomad-mesh-dashboard` (own git, backend tests: `cd backend && python -m pytest -q`, currently 68 passing).
- Radio-free tests only (ast-extraction harness — see `test_bridge_v14.py::_extract`). Never import bridge.py in tests.
- Deploys: bridge image tag `:v10`, dashboard `:v29`→`:v30`, via scp→`docker build` on aibox→NOMAD PUT with FULL env + `force:true` (GET `.app` first; omitting an env entry DELETES it). Aaron runs ghcr pushes. Bash-tool gotcha: heredocs mangle `\n`/`\u` escapes — write scripts with the Write tool and scp them.
- monorepo commits from `C:\Users\AB Digial` need `git add -f` (a `.gitignore` covers `projects/` but these files are tracked).

---

### Task 1: Live gate probe — response shape through the VNS

Everything downstream assumes the pubsub packet shape. Verify it live BEFORE building (5a precedent: the gate probe changed the design).

**Files:**
- Create: scratchpad `probe_traceroute.py` (scp to aibox `/tmp/`, run via `docker exec -i nomad_custom_mesh_ai_bridge python - < /tmp/probe_traceroute.py`). Not committed.

**Interfaces:**
- Produces: a captured real `TRACEROUTE_APP` packet dict pasted into Task 2's fixture (`_RESP_FIXTURE`).

- [ ] **Step 1: Write and run the probe.** It opens a SECOND TCPInterface client on the VNS (`172.17.0.1:4404` — verified safe read pattern; the live bridge is untouched), subscribes to `meshtastic.receive`, sends a traceroute to a currently-direct node (pick a hops=0 node from `/api/nodes`, e.g. one of the TRON routers), and prints any `TRACEROUTE_APP`/`ROUTING_APP` packet it hears for 90s:

```python
import sys, time, json
from pubsub import pub
import meshtastic.tcp_interface
from meshtastic.protobuf import mesh_pb2, portnums_pb2

DEST = "!SET_ME"   # a hops=0 node id from /api/nodes before running

def on_rx(packet=None, interface=None):
    dec = (packet or {}).get("decoded", {}) or {}
    if dec.get("portnum") in ("TRACEROUTE_APP", "ROUTING_APP"):
        print("PORTNUM", dec.get("portnum"), "requestId", dec.get("requestId"))
        print(json.dumps({k: v for k, v in packet.items() if k != "raw"}, default=str, indent=1), flush=True)

pub.subscribe(on_rx, "meshtastic.receive")
i = meshtastic.tcp_interface.TCPInterface("172.17.0.1", portNumber=4404)
try:
    pkt = i.sendData(mesh_pb2.RouteDiscovery(), destinationId=DEST,
                     portNum=portnums_pb2.PortNum.TRACEROUTE_APP,
                     wantResponse=True, channelIndex=0, hopLimit=4)
    print("sent request_id", getattr(pkt, "id", None), flush=True)
    time.sleep(90)
finally:
    i.close()
```

- [ ] **Step 2: Record findings.** Confirm: (a) the response arrives with `decoded.portnum == "TRACEROUTE_APP"` and `decoded["requestId"] ==` the sent packet id; (b) whether the parsed route lives at `decoded["traceroute"]` (expected: dict with camelCase keys) — if it is ONLY in `decoded["payload"]` raw bytes, Task 2's parser must `mesh_pb2.RouteDiscovery.FromString` the payload instead; (c) note `hopStart`, `from`, `to` fields. Paste the real packet (trimmed) as Task 2's fixture and adjust the parser accordingly. **If no response after 2 attempts on 2 different direct nodes, STOP and report** — do not build on an unverified mechanism.

---

### Task 2: `parse_traceroute()` pure function (TDD)

**Files:**
- Modify: `projects\project-nomad\mesh-ai-bridge\bridge.py` (new function near `_inbound_meta`)
- Test: `projects\project-nomad\mesh-ai-bridge\test_bridge_v17.py` (new file, copy `_extract` harness verbatim from `test_bridge_v14.py`)

**Interfaces:**
- Produces: `parse_traceroute(packet) -> (request_id | None, result_dict | None)` where `result_dict = {"route": ["!hex8"...], "snr_towards": [float|None...], "route_back": [...], "snr_back": [...], "responder": "!hex8"|None, "hop_start": int|None}`.

- [ ] **Step 1: Write failing tests** (fixture = Task 1's real packet; plus synthetic edge cases):

```python
"""v17 traceroute tests — radio-free (ast-extraction harness, same pattern as
test_bridge_v14.py: bridge.py is never imported)."""
import ast, io, os, time

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

def _pt():
    fn, _ = _extract("parse_traceroute")
    return fn

# REAL packet captured by the Task 1 gate probe (2026-07-14, RZRM direct, trimmed).
# NOTE the live shape: the traceroute dict carries an extra "raw" key (protobuf text
# repr) — the parser must ignore unknown keys. A DIRECT hit omits route/routeBack.
_RESP_FIXTURE = {
    "from": 488548270,          # !1d1ea7ae RZRM
    "to": 932925094,            # !379b4ea6 RZRB (base)
    "hopStart": 2,
    "rxSnr": 10.5,
    "decoded": {"portnum": "TRACEROUTE_APP", "requestId": 2744067508, "bitfield": 0,
                "traceroute": {"snrTowards": [41], "snrBack": [42],
                               "raw": "snr_towards: 41\nsnr_back: 42\n"}},
}

def test_parses_real_direct_response_fixture():
    fn = _pt()
    req, r = fn(_RESP_FIXTURE)
    assert req == 2744067508
    assert r["route"] == [] and r["route_back"] == []   # direct: keys omitted entirely
    assert r["snr_towards"] == [10.25]                  # dB*4 wire format (41/4)
    assert r["snr_back"] == [10.5]                      # 42/4
    assert r["responder"] == "!1d1ea7ae"
    assert r["hop_start"] == 2

def test_multihop_route_and_unknown_snr():
    # synthetic: 1 intermediate hop each way; -128 = unknown SNR -> None
    fn = _pt()
    req, r = fn({"from": 0x0e57e001, "to": 0x379b4ea6, "hopStart": 4,
                 "decoded": {"portnum": "TRACEROUTE_APP", "requestId": 99,
                             "traceroute": {"route": [305419896], "snrTowards": [22, 34],
                                            "routeBack": [305419896], "snrBack": [-128, 30]}}})
    assert req == 99
    assert r["route"] == ["!12345678"]
    assert r["snr_towards"] == [5.5, 8.5]
    assert r["snr_back"] == [None, 7.5]

def test_direct_hit_has_empty_route():
    # protobuf-dict OMITS empty fields: a direct (0-hop) trace has no "route" key
    fn = _pt()
    req, r = fn({"from": 1, "to": 2, "decoded": {"portnum": "TRACEROUTE_APP",
                "requestId": 7, "traceroute": {"snrTowards": [41]}}})
    assert req == 7 and r["route"] == [] and r["snr_towards"] == [10.25]
    assert r["route_back"] == [] and r["snr_back"] == []

def test_rejects_non_traceroute_and_missing_request_id():
    fn = _pt()
    assert fn({"decoded": {"portnum": "TEXT_MESSAGE_APP"}}) == (None, None)
    assert fn({"decoded": {"portnum": "TRACEROUTE_APP", "traceroute": {}}}) == (None, None)
    assert fn({}) == (None, None)
    assert fn(None) == (None, None)
```

- [ ] **Step 2: Run to verify FAIL** — `python -m pytest test_bridge_v17.py -q` → all fail with "function parse_traceroute not found".
- [ ] **Step 3: Implement** in bridge.py (adjust to Task 1's verified shape):

```python
def parse_traceroute(packet):
    """Normalize a TRACEROUTE_APP response into route lists. Returns
    (request_id, result) or (None, None). SNR wire format is dB*4, -128 =
    unknown -> None. Protobuf-dict omits empty fields: absent route keys = [].
    route/routeBack are INTERMEDIATE hops only (endpoints implied)."""
    dec = (packet or {}).get("decoded", {}) or {}
    if dec.get("portnum") != "TRACEROUTE_APP":
        return None, None
    req = dec.get("requestId")
    if not isinstance(req, int) or isinstance(req, bool):
        return None, None
    tr = dec.get("traceroute") or {}
    def _snrs(key):
        return [None if v == -128 else v / 4.0
                for v in (tr.get(key) or []) if isinstance(v, int) and not isinstance(v, bool)]
    def _ids(key):
        return ["!{:08x}".format(n) for n in (tr.get(key) or [])
                if isinstance(n, int) and not isinstance(n, bool)]
    frm = packet.get("from")
    return req, {
        "route": _ids("route"), "snr_towards": _snrs("snrTowards"),
        "route_back": _ids("routeBack"), "snr_back": _snrs("snrBack"),
        "responder": "!{:08x}".format(frm) if isinstance(frm, int) and not isinstance(frm, bool) else None,
        "hop_start": packet.get("hopStart"),
    }
```

- [ ] **Step 4: Run to verify PASS**, full suite still green: `python -m pytest -q` → 115 + new all pass.
- [ ] **Step 5: Commit** (monorepo, `git add -f` both files): `feat(bridge/v17): parse_traceroute — normalize TRACEROUTE_APP responses`

---

### Task 3: `traceroutes` table + `POST /api/traceroute` endpoint (TDD)

**Files:**
- Modify: `bridge.py` — `db()` table block (~line 209, after `neighbors`), `SendHandler.do_POST` (~line 1098), new constants near `RADIO_CHECK_COOLDOWN_S` (~line 1216)
- Test: `test_bridge_v17.py` (append)

**Interfaces:**
- Consumes: `radio_check_allowed(sender, now, last_map, cooldown_s)` (existing — reused as the global cooldown gate), `parse_traceroute` (Task 2).
- Produces: table `traceroutes(id INTEGER PRIMARY KEY, ts REAL, dest TEXT, dest_name TEXT, request_id INTEGER, hop_limit INTEGER, status TEXT, route TEXT, snr_towards TEXT, route_back TEXT, snr_back TEXT, resp_ts REAL)`; `POST /api/traceroute {to, hop_limit?}` → `200 {ok, id, request_id}` | `400/401/429/502/503`. Constants `TRACEROUTE_COOLDOWN_S=35`, `TRACEROUTE_TTL_S=120`, `_tr_last={}`.

- [ ] **Step 1: Write failing SRC-wiring tests** (this endpoint is thin I/O glue around already-tested pieces; wiring assertions are the v14 precedent):

```python
def test_traceroute_endpoint_wired():
    # table migration
    assert "CREATE TABLE IF NOT EXISTS traceroutes(" in SRC
    # endpoint exists, token-gated, cooldown-gated, non-blocking sendData (never sendTraceRoute)
    assert '"/api/traceroute"' in SRC
    i_ep = SRC.index('"/api/traceroute"')
    assert "radio_check_allowed(\"global\", time.time(), _tr_last, TRACEROUTE_COOLDOWN_S)" in SRC
    assert "portnums_pb2.PortNum.TRACEROUTE_APP" in SRC
    assert "wantResponse=True" in SRC
    assert "sendTraceRoute" not in SRC.replace("NEVER call `interface.sendTraceRoute", "")  # guard: blocking API banned
    # stale pendings swept to timeout on each new request
    assert "SET status='timeout' WHERE status='pending'" in SRC

def test_traceroute_cooldown_is_global_and_reuses_allowed_gate():
    fn, _ = _extract("radio_check_allowed")
    last = {}
    assert fn("global", 1000.0, last, 35) is True
    assert fn("global", 1030.0, last, 35) is False
    assert fn("global", 1036.0, last, 35) is True
```

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement.** (a) constants next to the radio-check ones:

```python
# v17: mesh traceroute. Firmware rate-limits route discovery (~30s); one GLOBAL
# 35s gate — a second concurrent trace would be refused by the radio anyway.
TRACEROUTE_COOLDOWN_S = int(os.environ.get("TRACEROUTE_COOLDOWN_S", "35"))
TRACEROUTE_TTL_S = int(os.environ.get("TRACEROUTE_TTL_S", "120"))   # pending older than this = timeout
_tr_last = {}
```

(b) table in `db()` after the `neighbors` CREATE:

```python
    c.execute("CREATE TABLE IF NOT EXISTS traceroutes(id INTEGER PRIMARY KEY, ts REAL, dest TEXT, "
              "dest_name TEXT, request_id INTEGER, hop_limit INTEGER, status TEXT, route TEXT, "
              "snr_towards TEXT, route_back TEXT, snr_back TEXT, resp_ts REAL)")
```

(c) in `SendHandler.do_POST`, change the guard at the top to route both paths, and add the handler method:

```python
    def do_POST(self):
        if self.path == "/api/traceroute":
            return self._traceroute()
        if self.path != "/api/send":
            return self._reply(404, {"error": "not found"})
        ...  # existing /api/send body unchanged

    def _traceroute(self):
        """v17: fire a route-discovery probe. NON-BLOCKING by design — the lib's
        sendTraceRoute blocks+prints+raises; we sendData(wantResponse) and let
        on_traceroute fill the row in when (if) the mesh answers."""
        if not SEND_TOKEN or not hmac.compare_digest(self.headers.get("X-Send-Token") or "", SEND_TOKEN):
            return self._reply(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n < 0 or n > 1024:
                return self._reply(400, {"error": "bad content-length"})
            data = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(data, dict):
                return self._reply(400, {"error": "body must be a JSON object"})
        except Exception as e:
            log("traceroute api bad request: {}".format(e))
            return self._reply(400, {"error": "invalid JSON"})
        to = data.get("to")
        if not isinstance(to, str) or not re.fullmatch(r"![0-9a-fA-F]{8}", to):
            return self._reply(400, {"error": "bad destination"})
        hop_limit = data.get("hop_limit", 4)
        if not isinstance(hop_limit, int) or isinstance(hop_limit, bool) or not 1 <= hop_limit <= 7:
            return self._reply(400, {"error": "hop_limit must be 1..7"})
        if not radio_check_allowed("global", time.time(), _tr_last, TRACEROUTE_COOLDOWN_S):
            return self._reply(429, {"error": "traceroute cooling down (radio rate limit)",
                                     "retry_after": TRACEROUTE_COOLDOWN_S})
        if iface is None:
            return self._reply(503, {"error": "radio not connected"})
        try:
            pkt = iface.sendData(mesh_pb2.RouteDiscovery(), destinationId=to,
                                 portNum=portnums_pb2.PortNum.TRACEROUTE_APP,
                                 wantResponse=True, channelIndex=0, hopLimit=hop_limit)
        except Exception as e:
            log("traceroute radio send failed: {}".format(e))
            return self._reply(502, {"error": "radio send failed"})
        req_id = getattr(pkt, "id", None)
        with db() as c:
            c.execute("UPDATE traceroutes SET status='timeout' WHERE status='pending' AND ts < ?",
                      (time.time() - TRACEROUTE_TTL_S,))
            cur = c.execute("INSERT INTO traceroutes(ts, dest, dest_name, request_id, hop_limit, status) "
                            "VALUES(?,?,?,?,?,'pending')",
                            (time.time(), to, node_display(iface, to), req_id, hop_limit))
            row_id = cur.lastrowid
        log("traceroute api TX to {} hop_limit={} request_id={}".format(to, hop_limit, req_id))
        return self._reply(200, {"ok": True, "id": row_id, "request_id": req_id})
```

Check imports first: `grep -n "mesh_pb2\|portnums_pb2" bridge.py` — v12's `_send_tapback` already uses them; if only imported locally there, add module-level `from meshtastic.protobuf import mesh_pb2, portnums_pb2` matching the existing import style.

- [ ] **Step 4: Run** `python -m pytest -q` → all pass.
- [ ] **Step 5: Commit**: `feat(bridge/v17): POST /api/traceroute — non-blocking route discovery + traceroutes table`

---

### Task 4: `on_traceroute` co-subscriber + version bump (TDD)

**Files:**
- Modify: `bridge.py` — new handler next to `on_routing` (~line 1536), `pub.subscribe` in `main()`, docstring header + banner v16→v17
- Test: `test_bridge_v17.py` (append)

**Interfaces:**
- Consumes: `parse_traceroute` (Task 2), `traceroutes` table (Task 3).
- Produces: rows transition `pending` → `ok` (route filled) or `failed:<REASON>`; `pub.subscribe(on_traceroute, "meshtastic.receive")`.

- [ ] **Step 1: Write failing tests** — extraction with a stubbed `db` (in-memory sqlite via injected contextmanager) exercises real correlation logic:

```python
import contextlib, json as _json, sqlite3

def _mem_db():
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE traceroutes(id INTEGER PRIMARY KEY, ts REAL, dest TEXT, dest_name TEXT, "
                "request_id INTEGER, hop_limit INTEGER, status TEXT, route TEXT, snr_towards TEXT, "
                "route_back TEXT, snr_back TEXT, resp_ts REAL)")
    @contextlib.contextmanager
    def db():
        yield con
        con.commit()
    return con, db

def _ot(con, db):
    parse, _ = _extract("parse_traceroute")
    fn, _ = _extract("on_traceroute", {
        "db": db, "log": lambda *a: None, "time": time, "json": _json,
        "my_num": 0x379b4ea6, "parse_traceroute": parse,
    })
    return fn

def test_response_upgrades_pending_row_to_ok():
    con, db = _mem_db()
    con.execute("INSERT INTO traceroutes(ts, dest, request_id, status) VALUES(?, '!0e57e001', 42, 'pending')",
                (time.time(),))
    fn = _ot(con, db)
    fn(packet={"from": 0x0e57e001, "to": 0x379b4ea6,
               "decoded": {"portnum": "TRACEROUTE_APP", "requestId": 42,
                           "traceroute": {"snrTowards": [40]}}}, interface=None)
    row = con.execute("SELECT status, route, snr_towards FROM traceroutes").fetchone()
    assert row[0] == "ok" and _json.loads(row[1]) == [] and _json.loads(row[2]) == [10.0]

def test_third_party_and_unmatched_ignored():
    con, db = _mem_db()
    fn = _ot(con, db)
    # addressed to someone else
    fn(packet={"from": 1, "to": 999, "decoded": {"portnum": "TRACEROUTE_APP", "requestId": 42,
               "traceroute": {}}}, interface=None)
    # matches nothing pending
    fn(packet={"from": 1, "to": 0x379b4ea6, "decoded": {"portnum": "TRACEROUTE_APP", "requestId": 42,
               "traceroute": {}}}, interface=None)
    assert con.execute("SELECT COUNT(*) FROM traceroutes").fetchone()[0] == 0

def test_routing_error_marks_failed():
    con, db = _mem_db()
    con.execute("INSERT INTO traceroutes(ts, dest, request_id, status) VALUES(?, '!0e57e001', 42, 'pending')",
                (time.time(),))
    fn = _ot(con, db)
    fn(packet={"from": 0x0e57e001, "to": 0x379b4ea6,
               "decoded": {"portnum": "ROUTING_APP", "requestId": 42,
                           "routing": {"errorReason": "MAX_RETRANSMIT"}}}, interface=None)
    assert con.execute("SELECT status FROM traceroutes").fetchone()[0] == "failed:MAX_RETRANSMIT"

def test_routing_success_ack_is_not_terminal():
    # errorReason "NONE" (5a lesson: it's the STRING) = transit ack, row stays pending
    con, db = _mem_db()
    con.execute("INSERT INTO traceroutes(ts, dest, request_id, status) VALUES(?, '!0e57e001', 42, 'pending')",
                (time.time(),))
    fn = _ot(con, db)
    fn(packet={"from": 0x0e57e001, "to": 0x379b4ea6,
               "decoded": {"portnum": "ROUTING_APP", "requestId": 42,
                           "routing": {"errorReason": "NONE"}}}, interface=None)
    assert con.execute("SELECT status FROM traceroutes").fetchone()[0] == "pending"

def test_never_raises_and_subscribed():
    con, db = _mem_db()
    fn = _ot(con, db)
    fn(packet=None, interface=None)          # must swallow
    fn(packet={"decoded": "garbage"}, interface=None)
    assert 'pub.subscribe(on_traceroute, "meshtastic.receive")' in SRC
    assert "mesh-ai-bridge v17 starting" in SRC
```

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement:**

```python
def on_traceroute(packet=None, interface=None):
    """v17: correlate TRACEROUTE_APP responses (and ROUTING_APP failures) to a
    pending traceroutes row by exact requestId. Fully isolated co-subscriber to
    meshtastic.receive — a failure here must never touch text handling. RF is
    unauthenticated: results are display-only and drive NO automation."""
    try:
        dec = (packet or {}).get("decoded", {}) or {}
        pn = dec.get("portnum")
        if pn not in ("TRACEROUTE_APP", "ROUTING_APP"):
            return
        to_num = packet.get("to")
        if to_num is not None and my_num is not None and to_num != my_num:
            return
        if pn == "TRACEROUTE_APP":
            req, result = parse_traceroute(packet)
            if req is None:
                return
            with db() as c:
                row = c.execute("SELECT id FROM traceroutes WHERE request_id=? AND status='pending' "
                                "AND ts > ? ORDER BY ts DESC LIMIT 1",
                                (req, time.time() - 600)).fetchone()
                if row is None:
                    return
                c.execute("UPDATE traceroutes SET status='ok', route=?, snr_towards=?, route_back=?, "
                          "snr_back=?, resp_ts=? WHERE id=?",
                          (json.dumps(result["route"]), json.dumps(result["snr_towards"]),
                           json.dumps(result["route_back"]), json.dumps(result["snr_back"]),
                           time.time(), row[0]))
            log("traceroute answered: request_id={} {} hop(s) towards".format(req, len(result["route"])))
        else:
            req = dec.get("requestId")
            if req is None:
                return
            err = (dec.get("routing") or {}).get("errorReason")
            if not err or err == "NONE":
                return   # transit ack, not a verdict — the route may still arrive
            with db() as c:
                row = c.execute("SELECT id FROM traceroutes WHERE request_id=? AND status='pending' "
                                "AND ts > ? ORDER BY ts DESC LIMIT 1",
                                (req, time.time() - 600)).fetchone()
                if row is None:
                    return
                c.execute("UPDATE traceroutes SET status=?, resp_ts=? WHERE id=?",
                          ("failed:{}".format(err), time.time(), row[0]))
            log("traceroute failed: request_id={} {}".format(req, err))
    except Exception as e:
        log("traceroute handler error: {}".format(e))
```

In `main()`, after the `on_routing` subscribe line: `pub.subscribe(on_traceroute, "meshtastic.receive")   # v17: traceroute responses`. Bump docstring header to v17 (add a v17 paragraph) and banner string to `mesh-ai-bridge v17 starting`.

- [ ] **Step 4: Run** full suite → green.
- [ ] **Step 5: Commit**: `feat(bridge/v17): on_traceroute co-subscriber — correlate responses, honest failures`

---

### Task 5: Deploy bridge `:v10` + LIVE end-to-end trace + repo sync

**Files:** none new (deploy + verification)

- [ ] **Step 1:** Sync public clone: `cd projects/mesh-ai-bridge && tr -d '\r' < ../project-nomad/mesh-ai-bridge/bridge.py > bridge.py` (same for `test_bridge_v17.py`), run pytest there, commit + push.
- [ ] **Step 2:** scp LF `bridge.py` + Dockerfile to aibox `/tmp/bridge-v17/`, `docker build -t ghcr.io/aebconsulting/mesh-ai-bridge:v10 /tmp/bridge-v17` (overwrites the stale pre-5a local v10 tag — intentional, same as v9).
- [ ] **Step 3:** Deploy via NOMAD PUT (adapt the session's `deploy_v9.py`: GET `.app`, assert current `:v9`, set image `:v10`, `force:true`, poll docker inspect, print logs). Verify banner `mesh-ai-bridge v17 starting` + `connected to node`.
- [ ] **Step 4: LIVE VERIFY** — pick a hops=0 node from `/api/nodes`, then:

```bash
ssh aibox "curl -s -X POST http://172.18.0.1:8700/api/traceroute -H 'X-Send-Token: <token from bridge env>' -H 'Content-Type: application/json' -d '{\"to\":\"!<direct-node>\"}'"
# wait ~15s, then:
ssh aibox "sqlite3 -header /opt/mesh-ai-bridge/memory.db 'SELECT id,dest,status,route,snr_towards,route_back,snr_back FROM traceroutes ORDER BY id DESC LIMIT 3'"
```

NOTE: the send API is reachable from the HOST at the container's published port — check `docker port nomad_custom_mesh_ai_bridge`; if :8700 is not host-published, run the curl inside the dashboard container (`docker exec nomad_custom_mesh_dashboard curl -s -X POST http://nomad_custom_mesh_ai_bridge:8700/api/traceroute ...`). Expect `status=ok` with real SNR values, and a second POST within 35s to 429. Also verify a trace to a bogus-but-valid id (e.g. `!deadbeef`) ends `timeout` after 120s + next POST.
- [ ] **Step 5:** Commit monorepo (`git add -f`), note image `:v10` for Aaron's ghcr push (digest-verify after).

---

### Task 6: Dashboard backend — proxy + reads + capability flag (TDD)

**Files:**
- Modify: `projects\nomad-mesh-dashboard\backend\app.py`
- Test: `projects\nomad-mesh-dashboard\backend\tests\test_traceroute.py` (new; follow existing test files' TestClient + tmp sqlite fixture pattern — read `tests/` first and reuse their fixture helpers)

**Interfaces:**
- Consumes: bridge `POST /api/traceroute` (Task 3), `traceroutes` table, existing helpers `q()`, `client_ip()`, `_msg_log_has_ack` cache pattern, `BRIDGE_URL`, `SEND_TOKEN`.
- Produces: `POST /api/traceroute {to}` → `{ok, id}`; `GET /api/traceroute/{id}` → row with parsed lists + `age_s`; `/api/status` gains `"traceroute": bool`.

- [ ] **Step 1: Write failing tests** (shape them on the existing backend test conventions — key cases):

```python
# POST without X-Mesh-Dashboard header -> 403
# POST with header, bridge mocked 200 {ok,id} -> 200, bridge called with X-Send-Token
# POST bridge mocked 429 -> 429 passthrough with bridge's error text
# POST 3rd call within a minute from same client -> 429 (own bucket: 2/min)
# GET /api/traceroute/{id} on a seeded row (status ok, json fields) -> parsed lists
# GET unknown id -> 404
# /api/status traceroute flag: True when table exists in fixture db, False when absent
```

(Write them as real code against the repo's fixture helpers — the executor copies the idioms from `tests/test_send_api.py` / `tests/test_status.py`.)

- [ ] **Step 2: Run to verify FAIL** (`cd backend && python -m pytest tests/test_traceroute.py -q`).
- [ ] **Step 3: Implement** in app.py:

```python
_tr_flag_cache = None   # (value, ts) — bridge v17 traceroutes table, 30s TTL

def _has_traceroutes():
    """Feature-detect bridge v17 (same degradation contract as _msg_log_has_ack)."""
    global _tr_flag_cache
    now = time.time()
    if _tr_flag_cache and now - _tr_flag_cache[1] < 30:
        return _tr_flag_cache[0]
    try:
        rows = q("SELECT name FROM sqlite_master WHERE type='table' AND name='traceroutes'")
        val = bool(rows)
    except HTTPException:
        val = False
    _tr_flag_cache = (val, now)
    return val

class TraceReq(BaseModel):
    to: str
    model_config = ConfigDict(extra="forbid")
    @field_validator("to")
    @classmethod
    def _to_ok(cls, v):
        if not re.fullmatch(r"![0-9a-fA-F]{8}", v or ""):
            raise ValueError("bad node id")
        return v

_trace_times: dict[str, list[float]] = {}
_trace_times_lock = threading.Lock()

@app.post("/api/traceroute")
def traceroute(body: TraceReq, request: Request):
    if request.headers.get("x-mesh-dashboard") != "1":
        raise HTTPException(403, "missing X-Mesh-Dashboard header")
    ip = client_ip(request)
    now = time.time()
    with _trace_times_lock:
        for key in list(_trace_times.keys()):
            trimmed = [t for t in _trace_times[key] if now - t < 60]
            if trimmed: _trace_times[key] = trimmed
            else: del _trace_times[key]
        times = _trace_times.get(ip, [])
        if len(times) >= 2:   # the radio only allows ~1/35s anyway
            raise HTTPException(429, "rate limited: max 2 traceroutes/minute")
        times.append(now); _trace_times[ip] = times
    try:
        r = httpx.post(BRIDGE_URL + "/api/traceroute", json={"to": body.to},
                       headers={"X-Send-Token": SEND_TOKEN}, timeout=10)
    except Exception:
        raise HTTPException(502, "bridge unreachable")
    if r.status_code != 200:
        detail = "bridge refused the traceroute"
        try: detail = r.json().get("error", detail)
        except Exception: pass
        raise HTTPException(r.status_code if r.status_code in (400, 429, 503) else 502, detail)
    return {"ok": True, "id": r.json().get("id")}

@app.get("/api/traceroute/{row_id}")
def traceroute_result(row_id: int):
    rows = q("SELECT id, ts, dest, dest_name, hop_limit, status, route, snr_towards, "
             "route_back, snr_back, resp_ts FROM traceroutes WHERE id=?", (row_id,))
    if not rows:
        raise HTTPException(404, "no such traceroute")
    r = rows[0]
    for k in ("route", "snr_towards", "route_back", "snr_back"):
        r[k] = json.loads(r[k]) if r[k] else []
    r["age_s"] = round(time.time() - r["ts"], 1)
    return r
```

Add `"traceroute": _has_traceroutes(),` to the `/api/status` response dict (next to `own_nodes`). Match existing imports (BaseModel/field_validator/ConfigDict already imported for SendReq).

- [ ] **Step 4: Run** backend suite → 68 + new all green.
- [ ] **Step 5: Commit** (canonical repo): `feat(backend): traceroute proxy + result reads behind bridge-v17 feature detect`

---

### Task 7: Frontend — NodeDetail "Trace route" + hop chain, App wiring

**Files:**
- Modify: `frontend/src/api.ts`, `frontend/src/components/NodeDetail.tsx`, `frontend/src/App.tsx`

**Interfaces:**
- Consumes: Task 6 endpoints; `/api/status.traceroute` flag (via existing status poll in App).
- Produces: `postTraceroute(to): Promise<{ok, id}>`, `getTraceroute(id): Promise<TraceResult>`; `NodeDetail` gains props `canTrace: boolean; onTraceDone: (r: TraceResult | null) => void`; App state `traceResult` passed to MeshMap (Task 8).

- [ ] **Step 1: api.ts** — add types + calls (follow the existing `sendMessage` error-shape idiom at api.ts:103-140):

```ts
export interface TraceResult {
  id: number; ts: number; dest: string; dest_name: string | null;
  status: string;   // pending | ok | failed:<REASON> | timeout
  route: string[]; snr_towards: (number | null)[];
  route_back: string[]; snr_back: (number | null)[];
  resp_ts: number | null; age_s: number;
}
export const postTraceroute = (to: string) =>
  post<{ ok: boolean; id: number }>("/api/traceroute", { to });
export const getTraceroute = (id: number) => get<TraceResult>(`/api/traceroute/${id}`);
```

(Adapt `post`/`get` helper names to what api.ts actually exports — read the file first; sendMessage's fetch wrapper is the model if there's no generic `post`.)

- [ ] **Step 2: NodeDetail.tsx** — read the component first; add below the header, hidden when `!canTrace`:
  - "Trace route" button; on click: `postTraceroute(nodeId)` → store id → poll `getTraceroute(id)` every 3s until status ≠ pending or 90s elapsed (then render "no response — node unreachable or asleep"); disable button while pending and for 35s after (cooldown, show countdown); 429 → show the server's message.
  - **Carried from Task 2:** when an SNR list disagrees in length with its route, the parser honestly degrades it to all-`None` ("signal unknown") rather than misaligning. So a direction whose SNR values are ALL `null` carries no real signal data — render its hops with `?` for SNR, and do NOT render a back-leg section at all when `route_back` is empty AND every `snr_back` entry is `null` (that's a response that reported no back data; showing an empty "route back" line would overstate it).
  - Result render (plain text rows, no new deps): towards chain `RZRB → <name> (snr dB) → … → <dest> (snr dB)` using `route` + `snr_towards` (remember: endpoints implied — start at base, end at dest; `snr_towards[i]` belongs to `route[i]`, last entry to dest). Same for back chain when `route_back`/`snr_back` non-empty. Resolve names via the nodes list NodeDetail already has access to (or accept a `nodes: Node[]` prop from App — match existing prop flow). Unknown ids render as the raw `!hex`. `failed:<REASON>` renders the reason verbatim.
  - On terminal `ok`, call `onTraceDone(result)` so App can hand the route to the map; on close/unmount call `onTraceDone(null)`.
- [ ] **Step 3: App.tsx** — `const [traceResult, setTraceResult] = useState<TraceResult | null>(null);` pass `canTrace={status.data?.traceroute ?? false}` + `onTraceDone={setTraceResult}` to NodeDetail; clear on detail close (`setDetailNode(null); setTraceResult(null)`); pass `traceRoute={traceResult}` to MeshMap.
- [ ] **Step 4:** `cd frontend && npm run build` → clean tsc + vite.
- [ ] **Step 5: Commit**: `feat(ui): trace route from node detail — hop chain with per-hop SNR`

---

### Task 8: MeshMap polyline overlay

**Files:**
- Modify: `frontend/src/components/MeshMap.tsx`

**Interfaces:**
- Consumes: `traceRoute: TraceResult | null` prop (Task 7); nodes already available in MeshMap for position lookup; base node id via existing `baseNode`/ownNodes props (read the file — v21 focus-ring `FOCUS_LAYER` shows the source/layer idiom to copy).
- Produces: an amber route line on the map while a trace result is displayed.

- [ ] **Step 1:** Add a `trace` GeoJSON source + line layer at map-load next to where `FOCUS_LAYER` is created (empty FeatureCollection initially): line color `#ffb020`, width 2.5, dasharray [2,1.5], opacity 0.9.
- [ ] **Step 2:** Effect on `traceRoute` (via the REFS pattern — v21 lesson: mount-time handlers read refs, never re-create the map): build the towards path `[base, ...route, dest]`, map each id to its node's [lon, lat], SKIP ids with no position (count them), `setData` a LineString when ≥2 points remain, else clear. Clear on `traceRoute === null`. Do NOT move the camera (respect `userMoved` — the operator is likely already looking at the area; the NodeDetail chain is the primary surface).
- [ ] **Step 3:** If hops were skipped for missing GPS, App-side chain already shows every hop; add a small note line in NodeDetail: "N hop(s) not on map (no GPS)". (Pass skipped-count back via a `onTraceMapInfo?: (skipped: number) => void` prop or compute the same in NodeDetail from the shared nodes list — pick whichever matches existing prop flow; compute-in-NodeDetail avoids a new callback.)
- [ ] **Step 4:** `npm run build` clean.
- [ ] **Step 5: Commit**: `feat(map): traceroute polyline overlay (amber dashed, no camera hijack)`

---

### Task 9: Deploy dashboard `:v30` + live QA + docs/mirror

- [ ] **Step 1:** Push canonical repo. tar/scp (exclude node_modules/.git/dist/pycache) → aibox `~/mesh-dashboard` → `docker build -t ghcr.io/aebconsulting/nomad-mesh-dashboard:v30` → NOMAD PUT (assert current `:v29`, FULL env incl. `OWN_NODE_IDS` + `PINNED_NODE_IDS`, `force:true`) → poll running + `/api/status` shows `"traceroute": true`.
- [ ] **Step 2: LIVE QA in the browser** (claude-in-chrome on `https://dashboard.meshnomad.ai`): open a hops=0 node's detail → Trace route → expect pending state → real hop chain within ~15s → amber line on map → button cooldown state → close detail clears the line. Screenshot for Aaron. Then a far node (hops ≥2): verify multi-hop chain with intermediate names, or an honest timeout.
- [ ] **Step 3:** Sync monorepo mirror (`projects/project-nomad/mesh-dashboard`), add CLAUDE.md bullet (bridge v17 = image `:v10` gotchas: sendTraceRoute is blocking/banned, global 35s cooldown, honest timeout; dashboard `:v30` traceroute UI; both need Aaron's ghcr push + digest-verify), commit monorepo (`git add -f`).

---

## Self-Review Notes

- Spec coverage: request path (T3), response path (T2/T4), honesty states incl. firmware rate-limit (T3 429 / T4 failed:REASON / T3 sweep timeout), UI chain + map (T7/T8), feature-detect degradation (T6), live verification gates (T1, T5, T9). ✓
- Type consistency: `parse_traceroute` returns snake_case keys matching the `traceroutes` columns and the API/TS `TraceResult` fields. `radio_check_allowed` reuse matches its (sender, now, last_map, cooldown_s) signature. ✓
- Known unknowns pushed to gates: exact pubsub decode shape (T1 gate, fixture updated), `:8700` host reachability (T5 fallback documented), api.ts helper names / NodeDetail internals / test fixture idioms (executor reads the file first — files named).
