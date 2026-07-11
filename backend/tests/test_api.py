import ipaddress, os, sqlite3, time, tempfile, pathlib
import httpx
import pytest
from fastapi.testclient import TestClient

CSRF_HEADERS = {"X-Mesh-Dashboard": "1"}

def make_db(path):
    # Schema mirrors the live bridge memory.db (v9): full nodes columns plus the
    # env_log / telemetry / neighbors tables the API reads.
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE msg_log(id INTEGER PRIMARY KEY, ts REAL, direction TEXT, node_id TEXT, node_name TEXT, channel INTEGER, is_dm INTEGER, is_ai INTEGER, text TEXT)")
    c.execute("CREATE TABLE nodes(node_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, lat REAL, lon REAL, battery INTEGER, snr REAL, hops INTEGER, last_heard REAL, updated REAL, "
              "hw_model TEXT, role TEXT, altitude REAL, voltage REAL, chan_util REAL, air_util_tx REAL, uptime_s INTEGER, rssi REAL, via_mqtt INTEGER, sats INTEGER, loc_source TEXT)")
    c.execute("CREATE TABLE env_log(id INTEGER PRIMARY KEY, ts REAL, node_id TEXT, node_name TEXT, temperature REAL, humidity REAL, pressure REAL, lat REAL, lon REAL)")
    c.execute("CREATE TABLE telemetry(id INTEGER PRIMARY KEY, ts REAL, node_id TEXT, node_name TEXT, kind TEXT, metric TEXT, value REAL)")
    c.execute("CREATE TABLE neighbors(id INTEGER PRIMARY KEY, ts REAL, node_id TEXT, neighbor_id TEXT, snr REAL)")
    now = time.time()
    c.execute("INSERT INTO msg_log(ts,direction,node_id,node_name,channel,is_dm,is_ai,text) VALUES(?,?,?,?,?,?,?,?)", (now-60, "in", "!aa11bb22", "K4XR-7", 0, 0, 0, "hello"))
    c.execute("INSERT INTO msg_log(ts,direction,node_id,node_name,channel,is_dm,is_ai,text) VALUES(?,?,?,?,?,?,?,?)", (now-30, "out", "dashboard", "Dashboard", 0, 0, 0, "hi back"))
    c.execute("INSERT INTO nodes(node_id,short_name,long_name,lat,lon,battery,snr,hops,last_heard,updated,hw_model,role) "
              "VALUES('!aa11bb22','K4XR','K4XR-7',34.1,-84.2,86,7.5,0,?,?,'HELTEC_V3','CLIENT')", (now-120, now-31))
    c.execute("INSERT INTO nodes(node_id,short_name,long_name,lat,lon,battery,snr,hops,last_heard,updated) "
              "VALUES('!bb22cc33','RZRB','Base',34.0,-84.3,100,NULL,0,?,?)", (now-60, now-20))
    c.execute("INSERT INTO env_log(ts,node_id,node_name,temperature,humidity,pressure) VALUES(?, '!aa11bb22', 'K4XR-7', 21.5, 40.0, 1013.2)", (now-90,))
    c.execute("INSERT INTO neighbors(ts,node_id,neighbor_id,snr) VALUES(?, '!aa11bb22', '!bb22cc33', 6.25)", (now-45,))
    c.commit(); c.close()

@pytest.fixture()
def client(tmp_path, monkeypatch):
    db = tmp_path / "memory.db"
    make_db(str(db))
    img = tmp_path / "images"; img.mkdir()
    (img / "hawk.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    (img / "evil.sh").write_bytes(b"nope")
    monkeypatch.setenv("MEM_DB", str(db))
    monkeypatch.setenv("IMAGES_DIR", str(img))
    monkeypatch.setenv("SEND_TOKEN", "tok")
    monkeypatch.setenv("BRIDGE_URL", "http://bridge.test:8700")
    import importlib, app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app), app_module

def test_feed_newest_first_and_capped(client):
    c, _ = client
    r = c.get("/api/feed")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["text"] for i in items] == ["hi back", "hello"]
    assert c.get("/api/feed?limit=99999").status_code == 422  # over cap rejected, not coerced

def test_feed_since_filter(client):
    c, _ = client
    all_items = c.get("/api/feed").json()["items"]
    r = c.get("/api/feed", params={"since": all_items[-1]["ts"]})
    assert [i["text"] for i in r.json()["items"]] == ["hi back"]

def test_nodes(client):
    c, _ = client
    body = c.get("/api/nodes").json()
    assert {i["node_id"] for i in body["items"]} == {"!aa11bb22", "!bb22cc33"}
    assert body["snapshot_ts"] is not None

def test_nodes_includes_latest_weather(client):
    c, _ = client
    items = c.get("/api/nodes").json()["items"]
    k4xr = next(i for i in items if i["node_id"] == "!aa11bb22")
    assert k4xr["temperature"] == 21.5

def test_neighbors_links(client):
    c, _ = client
    items = c.get("/api/neighbors").json()["items"]
    assert len(items) == 1
    edge = items[0]
    assert (edge["from_id"], edge["to_id"], edge["snr"]) == ("!aa11bb22", "!bb22cc33", 6.25)
    assert edge["from_lat"] == 34.1 and edge["to_lat"] == 34.0

def test_neighbors_derived_base_star(client, monkeypatch):
    # With BASE_NODE_ID set, hops==0 nodes get a derived base->node edge; the
    # explicit neighbors-table edge for the same pair must win over the star.
    c, m = client
    monkeypatch.setattr(m, "BASE_NODE_ID", "!bb22cc33")
    items = c.get("/api/neighbors").json()["items"]
    pairs = {(e["from_id"], e["to_id"]) for e in items}
    assert ("!bb22cc33", "!aa11bb22") in pairs, "derived star edge missing"
    assert ("!aa11bb22", "!bb22cc33") in pairs, "explicit table edge missing"

def test_images_whitelist(client):
    c, _ = client
    names = [i["name"] for i in c.get("/api/images").json()["items"]]
    assert names == ["hawk.png"], "non-image files must not be listed"
    assert c.get("/api/images/../../etc/passwd").status_code in (404, 422)
    assert c.get("/api/images/evil.sh").status_code == 422

def test_db_is_readonly(client):
    # A write attempt on the mode=ro connection raises sqlite3.OperationalError
    # from the query phase, which q() now leaves uncaught (only the connect
    # phase is mapped to 503) -- the write is still refused, proving the
    # read-only guarantee holds, and a real query bug stays loud instead of
    # masquerading as a transient outage.
    _, m = client
    with pytest.raises(sqlite3.OperationalError):
        m.q("INSERT INTO msg_log(ts) VALUES(1)")

def test_send_validation_and_forwarding(client, monkeypatch):
    c, m = client
    sent = {}
    class FakeResp:
        status_code = 200
        def json(self): return {"ok": True}
    def fake_post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, json=json, headers=headers); return FakeResp()
    monkeypatch.setattr(m.httpx, "post", fake_post)
    assert c.post("/api/send", json={"text": ""}, headers=CSRF_HEADERS).status_code == 422
    assert c.post("/api/send", json={"text": "x" * 400}, headers=CSRF_HEADERS).status_code == 422
    r = c.post("/api/send", json={"text": "hello", "channel": 0}, headers=CSRF_HEADERS)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert sent["url"] == "http://bridge.test:8700/api/send"
    assert sent["headers"]["X-Send-Token"] == "tok"

def _no_bridge_call(*a, **k):
    raise AssertionError("bridge must not be called when validation/CSRF rejects the request")

def test_send_requires_csrf_header(client, monkeypatch):
    c, m = client
    monkeypatch.setattr(m.httpx, "post", _no_bridge_call)
    r = c.post("/api/send", json={"text": "hello"})  # no X-Mesh-Dashboard header
    assert r.status_code == 403
    assert r.json() == {"detail": "missing X-Mesh-Dashboard header"}

def test_send_rejects_dest_with_trailing_newline(client, monkeypatch):
    c, m = client
    monkeypatch.setattr(m.httpx, "post", _no_bridge_call)
    r = c.post("/api/send", json={"text": "hello", "to": "!aa11bb22\n"}, headers=CSRF_HEADERS)
    assert r.status_code == 422

def test_send_rejects_control_chars(client, monkeypatch):
    c, m = client
    monkeypatch.setattr(m.httpx, "post", _no_bridge_call)
    assert c.post("/api/send", json={"text": "hi\nthere"}, headers=CSRF_HEADERS).status_code == 422
    assert c.post("/api/send", json={"text": "hi\x00there"}, headers=CSRF_HEADERS).status_code == 422

def test_send_rate_limit_sixth_ok_seventh_429(client, monkeypatch):
    c, m = client
    class FakeResp:
        status_code = 200
        def json(self): return {"ok": True}
    monkeypatch.setattr(m.httpx, "post", lambda *a, **k: FakeResp())
    for i in range(6):
        r = c.post("/api/send", json={"text": "hello {}".format(i)}, headers=CSRF_HEADERS)
        assert r.status_code == 200, "send #{} should be within the 6/min budget".format(i + 1)
    r = c.post("/api/send", json={"text": "one too many"}, headers=CSRF_HEADERS)
    assert r.status_code == 429

def test_image_name_trailing_newline_rejected(client):
    c, _ = client
    r = c.get("/api/images/hawk.png%0A")
    assert r.status_code != 200

def test_symlink_escape_blocked(client, tmp_path):
    c, m = client
    img_dir = pathlib.Path(m.IMAGES_DIR)
    secret = tmp_path / "secret_outside_images.png"
    secret.write_bytes(b"top secret, must not be servable")
    link = img_dir / "escape.png"
    try:
        link.symlink_to(secret)
    except OSError:
        pytest.skip("symlink creation not permitted for this user/platform")
    r = c.get("/api/images/escape.png")
    assert r.status_code == 404

def test_symlink_escape_blocked_via_realpath_simulation(client, monkeypatch, tmp_path):
    c, m = client
    img_dir = pathlib.Path(m.IMAGES_DIR)
    (img_dir / "evil.png").write_bytes(b"placeholder")
    outside = tmp_path / "outside_secret.png"
    outside.write_bytes(b"top secret, must not be servable")
    real_realpath = os.path.realpath
    def fake_realpath(p):
        # Simulate "evil.png" resolving (as a symlink would) to a path OUTSIDE
        # IMAGES_DIR, while every other path resolves normally.
        if os.path.basename(str(p)) == "evil.png":
            return str(outside)
        return real_realpath(p)
    monkeypatch.setattr(os.path, "realpath", fake_realpath)
    r = c.get("/api/images/evil.png")
    assert r.status_code == 404

def test_status(client):
    c, _ = client
    s = c.get("/api/status").json()
    assert s["last_msg_ts"] is not None and s["last_node_update"] is not None

def test_log_view_default_and_cap(client):
    c, _ = client
    r = c.get("/api/log")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["text"] for i in items] == ["hi back", "hello"]
    assert c.get("/api/log?limit=99999").status_code == 422  # over cap rejected, not coerced

def test_send_bridge_non_200_propagates_status_and_detail(client, monkeypatch):
    c, m = client
    class FakeResp:
        status_code = 429
        def json(self): return {"error": "rate limited"}
    monkeypatch.setattr(m.httpx, "post", lambda *a, **k: FakeResp())
    r = c.post("/api/send", json={"text": "hello"}, headers=CSRF_HEADERS)
    assert r.status_code == 429
    assert r.json() == {"detail": "rate limited"}

def test_send_bridge_unreachable_returns_502(client, monkeypatch):
    c, m = client
    def raise_connect_error(*a, **k):
        raise httpx.ConnectError("connection refused")
    monkeypatch.setattr(m.httpx, "post", raise_connect_error)
    r = c.post("/api/send", json={"text": "hello"}, headers=CSRF_HEADERS)
    assert r.status_code == 502

def test_images_mtime_ordering(client):
    c, m = client
    img_dir = pathlib.Path(m.IMAGES_DIR)
    older = img_dir / "older.png"
    newer = img_dir / "newer.png"
    older.write_bytes(b"1")
    newer.write_bytes(b"2")
    now = time.time()
    os.utime(older, (now - 100, now - 100))
    os.utime(newer, (now - 10, now - 10))
    names = [i["name"] for i in c.get("/api/images").json()["items"]]
    assert names.index("newer.png") < names.index("older.png"), "newest mtime must sort first"

def test_image_file_missing_returns_404(client):
    c, _ = client
    r = c.get("/api/images/missing.png")  # matches IMG_RE, dir exists, file absent
    assert r.status_code == 404

def test_images_race_resilience(client, monkeypatch):
    c, m = client
    class FakeStat:
        def __init__(self, mtime):
            self.st_mtime = mtime
    class FakeEntry:
        def __init__(self, name, mtime=None, raise_stat=False):
            self.name = name
            self._mtime = mtime
            self._raise = raise_stat
        def stat(self):
            if self._raise:
                raise OSError("vanished mid-scan")
            return FakeStat(self._mtime)
    class FakeScandirCtx:
        def __init__(self, entries):
            self._entries = entries
        def __enter__(self):
            return iter(self._entries)
        def __exit__(self, *a):
            return False
    entries = [
        FakeEntry("a.png", mtime=100),
        FakeEntry("poisoned.png", raise_stat=True),
        FakeEntry("c.png", mtime=50),
    ]
    monkeypatch.setattr(m.os, "scandir", lambda path: FakeScandirCtx(entries))
    r = c.get("/api/images")
    assert r.status_code == 200
    body = r.json()
    assert body["mounted"] is True
    names = [i["name"] for i in body["items"]]
    assert names == ["a.png", "c.png"], "poisoned entry must be skipped, not blank the whole gallery"

def test_images_mounted_flag(client, monkeypatch, tmp_path):
    c, m = client
    assert c.get("/api/images").json()["mounted"] is True
    missing = tmp_path / "does_not_exist"
    monkeypatch.setattr(m, "IMAGES_DIR", str(missing))
    r = c.get("/api/images")
    assert r.json() == {"items": [], "mounted": False}

def test_send_rate_limit_xff_shared_when_peer_untrusted(client, monkeypatch):
    # TestClient's direct peer is "testclient" (non-IP), which can never match a
    # trusted-proxy CIDR, so XFF is IGNORED and every request shares ONE bucket.
    # An untrusted client rotating XFF must NOT be able to mint a fresh budget.
    c, m = client
    class FakeResp:
        status_code = 200
        def json(self): return {"ok": True}
    monkeypatch.setattr(m.httpx, "post", lambda *a, **k: FakeResp())
    headers_a = dict(CSRF_HEADERS, **{"X-Forwarded-For": "10.0.0.1"})
    headers_b = dict(CSRF_HEADERS, **{"X-Forwarded-For": "10.0.0.2"})
    for i in range(6):
        r = c.post("/api/send", json={"text": "hello {}".format(i)}, headers=headers_a)
        assert r.status_code == 200, "send #{} should be within the 6/min budget".format(i + 1)
    r7 = c.post("/api/send", json={"text": "one too many"}, headers=headers_a)
    assert r7.status_code == 429
    r_other = c.post("/api/send", json={"text": "spoofed fresh budget"}, headers=headers_b)
    assert r_other.status_code == 429, "spoofed XFF from an untrusted peer must share the one bucket"


def _stub_request(peer_host, xff=None):
    """Minimal duck-typed stand-in for starlette Request that client_ip() reads:
    .client.host and case-insensitive .headers.get('x-forwarded-for')."""
    class _Client:
        host = peer_host
    class _Headers:
        def __init__(self, xff):
            self._xff = xff
        def get(self, key):
            return self._xff if key.lower() == "x-forwarded-for" else None
    class _Req:
        client = _Client()
        headers = _Headers(xff)
    return _Req()

def test_client_ip_honors_xff_from_trusted_proxy(client, monkeypatch):
    _, m = client
    monkeypatch.setattr(m, "_TRUSTED_NETS", [ipaddress.ip_network("172.16.0.0/12")])
    req = _stub_request("172.17.0.5", xff="203.0.113.9, 172.17.0.5")
    assert m.client_ip(req) == "203.0.113.9", "trusted proxy peer -> take first XFF hop"

def test_client_ip_ignores_xff_from_untrusted_peer(client, monkeypatch):
    _, m = client
    monkeypatch.setattr(m, "_TRUSTED_NETS", [ipaddress.ip_network("172.16.0.0/12")])
    req = _stub_request("203.0.113.50", xff="10.0.0.1")
    assert m.client_ip(req) == "203.0.113.50", "untrusted direct peer -> XFF ignored"

def test_client_ip_non_ip_peer_ignores_xff(client, monkeypatch):
    _, m = client
    monkeypatch.setattr(m, "_TRUSTED_NETS", [ipaddress.ip_network("172.16.0.0/12")])
    req = _stub_request("testclient", xff="10.0.0.1")
    assert m.client_ip(req) == "testclient", "non-IP peer can't be trusted -> XFF ignored"

def test_feed_db_missing_returns_503(client, monkeypatch, tmp_path):
    c, m = client
    monkeypatch.setattr(m, "DB_PATH", str(tmp_path / "does_not_exist.db"))
    r = c.get("/api/feed")
    assert r.status_code == 503, "absent DB must be a 503, not a 500"

def test_status_db_missing_returns_ok_false(client, monkeypatch, tmp_path):
    c, m = client
    monkeypatch.setattr(m, "DB_PATH", str(tmp_path / "does_not_exist.db"))
    class FakeResp:
        def json(self): return {"ok": True, "node": "RZRB"}
    monkeypatch.setattr(m.httpx, "get", lambda *a, **k: FakeResp())
    r = c.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["db_ok"] is False
    assert body["last_msg_ts"] is None and body["last_node_update"] is None
    assert body["bridge"] == {"ok": True, "node": "RZRB"}  # bridge still probed

def test_status_bridge_non_dict_json_is_nulled(client, monkeypatch):
    c, m = client
    class FakeResp:
        def json(self): return ["not", "a", "dict"]
    monkeypatch.setattr(m.httpx, "get", lambda *a, **k: FakeResp())
    r = c.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["bridge"] is None, "non-dict bridge health must be dropped, not crash"
    assert body["ok"] is False
    assert body["db_ok"] is True  # DB is healthy in this fixture

def test_map_asset_at2x_sprite_served(client, monkeypatch, tmp_path):
    # High-DPI sprite names contain '@' (light@2x.json); the asset allowlist
    # must accept them or every retina/phone client loses map icons.
    c, m = client
    sprites = tmp_path / "maps" / "basemaps-assets" / "sprites" / "v4"
    sprites.mkdir(parents=True)
    (sprites / "light@2x.json").write_text("{}")
    monkeypatch.setattr(m, "MAPS_DIR", str(tmp_path / "maps"))
    r = c.get("/maps/assets/sprites/v4/light@2x.json")
    assert r.status_code == 200

def test_map_asset_traversal_still_blocked(client, monkeypatch, tmp_path):
    c, m = client
    (tmp_path / "maps" / "basemaps-assets").mkdir(parents=True)
    monkeypatch.setattr(m, "MAPS_DIR", str(tmp_path / "maps"))
    assert c.get("/maps/assets/../../etc/passwd").status_code in (404, 422)
    assert c.get("/maps/assets/sprites/%2e%2e/secret.json").status_code in (404, 422)

def test_stats_counts(client):
    c, _ = client
    r = c.get("/api/stats")
    assert r.status_code == 200
    body = r.json()
    # fixture: 2 msgs in last 60s -> 1 in ("hello"), 1 out ("hi back"), 0 ai
    assert body == {"msgs_24h": 2, "in_24h": 1, "out_24h": 1, "ai_24h": 0}
