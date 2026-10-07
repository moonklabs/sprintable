"""story #4580 (Kadir 01:02Z · PO 01:13Z) — one host rule for an agent's allowed addresses: the server's `clean_host`, lane.py
KEEP_ALLOW (Min) and the desktop daemon's hook-text parser hold the same shared case list, app/services/host-rule-vectors.json."""
def test_one_host_rule_every_shared_case():
    """Kadir 01:02Z: the server, lane.py KEEP_ALLOW and the daemon's parser hold the same rule — the shared case list."""
    import json
    from pathlib import Path

    from app.services.agent_run_profile import clean_host

    doc = json.loads((Path(__file__).resolve().parents[1] / "app" / "services" / "host-rule-vectors.json").read_text(encoding="utf-8"))
    for v in doc["vectors"]:
        assert clean_host(v["in"]) == v["clean"], v["in"]


