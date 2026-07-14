"""Task 6 — dashboard backend traceroute proxy + result reads.

Mirrors test_api.py's TestClient + tmp-sqlite fixture idiom. The bridge (v17)
owns the `traceroutes` table (fills it in async via a co-subscriber); this
backend only proxies the POST (auth + rate-limit server-side, forwarding the
send token) and reads back rows, behind a feature-detect flag on /api/status
(same degradation contract as _msg_log_has_ack / _msg_log_has_replies: a
bridge older than the feature must yield traceroute:false, never a 500).
"""
import sqlite3, json, time
import httpx
import pytest
from fastapi.testclient import TestClient

CSRF_HEADERS = {"X-Mesh-Dashboard": "1"}


def make_db(path, with_traceroutes=True):
    c = sqlite3.connect(path)
    # Minimal msg_log/nodes -- just enough for /api/status's two MAX() probes.
    c.execute("CREATE TABLE msg_log(id INTEGER PRIMARY KEY, ts REAL, direction TEXT, node_id TEXT, node_name TEXT, channel INTEGER, is_dm INTEGER, is_ai INTEGER, text TEXT)")
    c.execute("CREATE TABLE nodes(node_id TEXT PRIMARY KEY, updated REAL)")
    now = time.time()
    c.execute("INSERT INTO msg_log(ts,direction,node_id,node_name,channel,is_dm,is_ai,text) VALUES(?,?,?,?,?,?,?,?)",
              (now - 60, "in", "!aa11bb22", "K4XR-7", 0, 0, 0, "hello"))
    c.execute("INSERT INTO nodes(node_id, updated) VALUES('!aa11bb22', ?)", (now - 20,))
    if with_traceroutes:
        c.execute(
            "CREATE TABLE traceroutes(id INTEGER PRIMARY KEY, ts REAL, dest TEXT, dest_name TEXT, "
            "hop_limit INTEGER, status TEXT, route TEXT, snr_towards TEXT, route_back TEXT, "
            "snr_back TEXT, resp_ts REAL, request_id INTEGER)")
        # Seeded row (id=1): completed traceroute, route_back present but empty,
        # snr_back NULL -- both must degrade to [] rather than error or null.
        c.execute(
            "INSERT INTO traceroutes(ts, dest, dest_name, hop_limit, status, route, snr_towards, "
            "route_back, snr_back, resp_ts, request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (now - 5, "!22222222", "NodeA", 3, "ok",
             json.dumps(["!33333333", "!44444444"]), json.dumps([8.25, 5.0]),
             json.dumps([]), None, now - 2, 999))
    c.commit(); c.close()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db = tmp_path / "memory.db"
    make_db(str(db))
    monkeypatch.setenv("MEM_DB", str(db))
    monkeypatch.setenv("SEND_TOKEN", "tok")
    monkeypatch.setenv("BRIDGE_URL", "http://bridge.test:8700")
    import importlib, app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app), app_module


def _no_bridge_call(*a, **k):
    raise AssertionError("bridge must not be called when CSRF/validation/rate-limit rejects the request")


class FakeOkResp:
    status_code = 200
    def __init__(self, body=None):
        self._body = body or {"ok": True, "id": 42}
    def json(self):
        return self._body


# ---------- POST /api/traceroute ----------

def test_traceroute_requires_csrf_header(client, monkeypatch):
    c, m = client
    monkeypatch.setattr(m.httpx, "post", _no_bridge_call)
    r = c.post("/api/traceroute", json={"to": "!11111111"})  # no X-Mesh-Dashboard header
    assert r.status_code == 403


def test_traceroute_post_forwards_with_send_token(client, monkeypatch):
    c, m = client
    sent = {}
    def fake_post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, json=json, headers=headers)
        return FakeOkResp({"ok": True, "id": 42})
    monkeypatch.setattr(m.httpx, "post", fake_post)
    r = c.post("/api/traceroute", json={"to": "!11111111"}, headers=CSRF_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "id": 42}
    assert sent["url"] == "http://bridge.test:8700/api/traceroute"
    assert sent["json"] == {"to": "!11111111"}
    assert sent["headers"]["X-Send-Token"] == "tok"


def test_traceroute_bridge_429_passthrough(client, monkeypatch):
    c, m = client
    class FakeResp:
        status_code = 429
        def json(self):
            return {"error": "radio busy, retry in 35s"}
    monkeypatch.setattr(m.httpx, "post", lambda *a, **k: FakeResp())
    r = c.post("/api/traceroute", json={"to": "!11111111"}, headers=CSRF_HEADERS)
    assert r.status_code == 429
    assert r.json() == {"detail": "radio busy, retry in 35s"}


def test_traceroute_rate_limit_third_call_429(client, monkeypatch):
    c, m = client
    calls = []
    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        return FakeOkResp()
    monkeypatch.setattr(m.httpx, "post", fake_post)
    for i in range(2):
        r = c.post("/api/traceroute", json={"to": "!11111111"}, headers=CSRF_HEADERS)
        assert r.status_code == 200, "traceroute #{} should be within the 2/min budget".format(i + 1)
    r3 = c.post("/api/traceroute", json={"to": "!11111111"}, headers=CSRF_HEADERS)
    assert r3.status_code == 429
    assert len(calls) == 2, "3rd call must be rejected before ever reaching the bridge"


def test_traceroute_rejects_bad_dest(client, monkeypatch):
    c, m = client
    monkeypatch.setattr(m.httpx, "post", _no_bridge_call)
    r = c.post("/api/traceroute", json={"to": "not-a-node"}, headers=CSRF_HEADERS)
    assert r.status_code == 422


def test_traceroute_bridge_unreachable_502(client, monkeypatch):
    c, m = client
    def raise_connect_error(*a, **k):
        raise httpx.ConnectError("connection refused")
    monkeypatch.setattr(m.httpx, "post", raise_connect_error)
    r = c.post("/api/traceroute", json={"to": "!11111111"}, headers=CSRF_HEADERS)
    assert r.status_code == 502


# ---------- GET /api/traceroute/{id} ----------

def test_traceroute_get_result_parses_json_fields(client):
    c, _ = client
    r = c.get("/api/traceroute/1")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["dest"] == "!22222222"
    assert body["route"] == ["!33333333", "!44444444"]
    assert body["snr_towards"] == [8.25, 5.0]
    assert body["route_back"] == [], "empty-JSON-array column must parse to []"
    assert body["snr_back"] == [], "NULL column must degrade to [], not null/error"
    assert "age_s" in body and body["age_s"] >= 0


def test_traceroute_get_unknown_id_404(client):
    c, _ = client
    assert c.get("/api/traceroute/999").status_code == 404


# ---------- /api/status traceroute flag ----------

def test_status_traceroute_flag_true_when_table_exists(client):
    c, _ = client
    assert c.get("/api/status").json()["traceroute"] is True


def test_status_traceroute_flag_false_when_table_absent(client, monkeypatch, tmp_path):
    c, m = client
    old = tmp_path / "no_traceroutes.db"
    make_db(str(old), with_traceroutes=False)
    monkeypatch.setattr(m, "DB_PATH", str(old))
    m._tr_flag_cache = None  # bust the 30s feature-detect cache
    r = TestClient(m.app).get("/api/status")
    assert r.status_code == 200
    assert r.json()["traceroute"] is False
