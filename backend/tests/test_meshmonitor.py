"""MeshMonitor enrichment (Phase 3, read-only): /api/nodes overlays MeshMonitor's
fresher lastHeard/snr/hops and appends MeshMonitor-only nodes; everything degrades
to bridge-only rows when MeshMonitor is unset, down, or returns garbage."""
import sqlite3, time
import pytest
from fastapi.testclient import TestClient

from test_api import make_db


def mm_node(nid, short, last_heard, snr=4.5, hops=2, lat=None, lon=None):
    n = {
        "nodeNum": 1,
        "user": {"id": nid, "longName": short + "-long", "shortName": short, "hwModel": 9, "role": "0"},
        "deviceMetrics": {"batteryLevel": 77, "voltage": 3.9, "channelUtilization": 1.2,
                          "airUtilTx": 0.5, "uptimeSeconds": 1000},
        "lastHeard": last_heard, "snr": snr, "rssi": -90, "lastMessageHops": hops,
        "viaMqtt": False, "channel": 0,
    }
    if lat is not None:
        n["position"] = {"latitude": lat, "longitude": lon, "altitude": 12}
    return n


class FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db = tmp_path / "memory.db"
    make_db(str(db))
    monkeypatch.setenv("MEM_DB", str(db))
    monkeypatch.setenv("SEND_TOKEN", "tok")
    monkeypatch.setenv("BRIDGE_URL", "http://bridge.test:8700")
    monkeypatch.delenv("MESHMONITOR_API_URL", raising=False)
    import importlib, app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app), app_module


def wire_mm(monkeypatch, m, payload, calls=None):
    """Route httpx.get: MeshMonitor URL -> payload; anything else raises (bridge down)."""
    def fake_get(url, timeout=None):
        if calls is not None:
            calls.append(url)
        if url.startswith("http://mm.test:3001"):
            if isinstance(payload, Exception):
                raise payload
            return FakeResp(payload)
        raise RuntimeError("unexpected URL " + url)
    monkeypatch.setattr(m, "httpx", type("H", (), {"get": staticmethod(fake_get)}))
    monkeypatch.setenv("MESHMONITOR_API_URL", "http://mm.test:3001")
    m._mm_cache = None


def test_unset_env_means_no_enrichment(client):
    c, _ = client
    body = c.get("/api/nodes").json()
    assert body["meshmonitor"] is False
    assert {i["node_id"] for i in body["items"]} == {"!aa11bb22", "!bb22cc33"}


def test_fresher_lastheard_overlaid_and_mm_only_node_appended(client, monkeypatch):
    c, m = client
    now = time.time()
    payload = [
        mm_node("!aa11bb22", "K4XR", now - 5, snr=-11.5, hops=3),      # fresher than db's now-120
        mm_node("!deadbeef", "NEWN", now - 10, lat=26.1, lon=-80.2),   # unknown to the bridge
    ]
    wire_mm(monkeypatch, m, payload)
    body = c.get("/api/nodes").json()
    assert body["meshmonitor"] is True
    by_id = {i["node_id"]: i for i in body["items"]}
    assert by_id["!aa11bb22"]["last_heard"] == pytest.approx(now - 5)
    assert by_id["!aa11bb22"]["snr"] == -11.5
    assert by_id["!aa11bb22"]["hops"] == 3
    # bridge-only fields survive the overlay
    assert by_id["!aa11bb22"]["temperature"] == 21.5
    new = by_id["!deadbeef"]
    assert new["short_name"] == "NEWN" and new["lat"] == 26.1 and new["battery"] == 77
    # appended rows carry the same key set as bridge rows (frontend renders uniformly)
    assert set(new.keys()) >= set(by_id["!aa11bb22"].keys())
    # list stays sorted newest-first after the merge
    heard = [i["last_heard"] or 0 for i in body["items"]]
    assert heard == sorted(heard, reverse=True)


def test_stale_mm_lastheard_never_regresses_bridge_row(client, monkeypatch):
    c, m = client
    payload = [mm_node("!aa11bb22", "K4XR", 1000.0, snr=99, hops=7)]  # ancient
    wire_mm(monkeypatch, m, payload)
    body = c.get("/api/nodes").json()
    row = next(i for i in body["items"] if i["node_id"] == "!aa11bb22")
    assert row["last_heard"] > 1000.0
    assert row["snr"] == 7.5 and row["hops"] == 0  # db values kept


def test_mm_down_degrades_to_bridge_rows(client, monkeypatch):
    c, m = client
    wire_mm(monkeypatch, m, RuntimeError("connect timeout"))
    body = c.get("/api/nodes").json()
    assert body["meshmonitor"] is False
    assert {i["node_id"] for i in body["items"]} == {"!aa11bb22", "!bb22cc33"}


def test_malformed_payloads_degrade(client, monkeypatch):
    c, m = client
    for payload in ("not json shape", {"nodes": "nope"}, [42, "x", {"user": None}],
                    [{"user": {"id": "not-a-node-id"}, "lastHeard": time.time()}],
                    [mm_node("!aa11bb22", "K4XR", True)]):  # bool lastHeard must not win
        wire_mm(monkeypatch, m, payload)
        r = c.get("/api/nodes")
        assert r.status_code == 200
        row = next(i for i in r.json()["items"] if i["node_id"] == "!aa11bb22")
        assert row["hops"] == 0  # never overlaid from garbage


def test_fetch_is_cached_within_ttl(client, monkeypatch):
    c, m = client
    calls = []
    wire_mm(monkeypatch, m, [mm_node("!deadbeef", "NEWN", time.time())], calls=calls)
    c.get("/api/nodes"); c.get("/api/nodes")
    assert len(calls) == 1


def test_detail_synthesized_for_mm_only_node(client, monkeypatch):
    c, m = client
    wire_mm(monkeypatch, m, [mm_node("!deadbeef", "NEWN", time.time(), lat=26.1, lon=-80.2)])
    r = c.get("/api/nodes/!deadbeef/detail")
    assert r.status_code == 200
    body = r.json()
    assert body["node"]["short_name"] == "NEWN"
    assert body["telemetry"] == {} and body["weather"] == []
    assert body.get("meshmonitor_only") is True
    # a node unknown everywhere still 404s
    assert c.get("/api/nodes/!00000000/detail").status_code == 404


def test_derived_links_windowed_and_mm_fresh(client, monkeypatch):
    """The base star only links nodes heard within the online window, and the
    MeshMonitor overlay both revives stale bridge rows and adds MM-only nodes."""
    c, m = client
    now = time.time()
    con = sqlite3.connect(m.DB_PATH)
    con.execute("INSERT INTO nodes(node_id,short_name,lat,lon,snr,hops,last_heard,updated) "
                "VALUES('!57a1e000','STAL',34.2,-84.1,5.0,0,?,?)", (now - 90000, now - 90000))
    con.commit(); con.close()
    monkeypatch.setattr(m, "BASE_NODE_ID", "!bb22cc33")
    # MeshMonitor unset: fresh direct node keeps its edge, day-old one loses it.
    items = c.get("/api/neighbors").json()["items"]
    pairs = {(e["from_id"], e["to_id"]) for e in items}
    assert ("!bb22cc33", "!aa11bb22") in pairs
    assert ("!bb22cc33", "!57a1e000") not in pairs
    # A fresh MeshMonitor sighting revives the stale row (db position reused),
    # and an MM-only positioned direct node gets a star edge of its own.
    payload = [mm_node("!57a1e000", "STAL", now - 30, hops=0),
               mm_node("!0000beef", "MMFR", now - 10, hops=0, lat=34.3, lon=-84.0)]
    wire_mm(monkeypatch, m, payload)
    items = c.get("/api/neighbors").json()["items"]
    pairs = {(e["from_id"], e["to_id"]) for e in items}
    assert ("!bb22cc33", "!57a1e000") in pairs
    assert ("!bb22cc33", "!0000beef") in pairs
    beef = next(e for e in items if e["to_id"] == "!0000beef")
    assert beef["to_lat"] == 34.3 and beef["ts"] == pytest.approx(now - 10)


def test_base_row_keeps_null_link_metrics(client, monkeypatch):
    """MeshMonitor's local-node entry has placeholder snr/hops -- the base's own
    row must take the fresher lastHeard but NEVER the bogus link metrics."""
    c, m = client
    monkeypatch.setattr(m, "BASE_NODE_ID", "!bb22cc33")
    now = time.time()
    wire_mm(monkeypatch, m, [mm_node("!bb22cc33", "RZRB", now - 1, snr=0, hops=0)])
    row = next(i for i in c.get("/api/nodes").json()["items"] if i["node_id"] == "!bb22cc33")
    assert row["last_heard"] == pytest.approx(now - 1)
    # db values untouched: fixture has snr NULL / hops 0; without the guard the
    # overlay would have written MM's placeholder snr 0 over the NULL.
    assert row["snr"] is None and row["hops"] == 0


def test_captured_links_age_out(client, monkeypatch):
    """A NEIGHBORINFO link the base stopped reporting must leave the overlay
    after NEIGHBOR_WINDOW_S; an explicit `since` still widens the window."""
    c, m = client
    now = time.time()
    con = sqlite3.connect(m.DB_PATH)
    con.execute("INSERT INTO neighbors(ts,node_id,neighbor_id,snr) VALUES(?,'!bb22cc33','!aa11bb22',3.0)",
                (now - 5 * 3600,))
    con.commit(); con.close()
    pairs = {(e["from_id"], e["to_id"]) for e in c.get("/api/neighbors").json()["items"]}
    assert ("!bb22cc33", "!aa11bb22") not in pairs
    pairs = {(e["from_id"], e["to_id"])
             for e in c.get(f"/api/neighbors?since={now - 6 * 3600}").json()["items"]}
    assert ("!bb22cc33", "!aa11bb22") in pairs


def test_status_reports_meshmonitor_flag(client, monkeypatch):
    c, m = client
    wire_mm(monkeypatch, m, [mm_node("!deadbeef", "NEWN", time.time())])
    assert c.get("/api/status").json()["meshmonitor"] is True
    wire_mm(monkeypatch, m, RuntimeError("down"))
    assert c.get("/api/status").json()["meshmonitor"] is False
