"""story 4796 — what Phase 2 of the dev move reached (PO, 2026-10-27) and what was accepted, written where the cutover plan reads it (RUNBOOK §9).

Pinned: the status paragraph names what is done, the GitHub webhooks the PO moved, the two deferred paths with the 24-hour numbers they were deferred on, the accepted cost after Phase 3, and the callers still arriving at `run.app`;
the paragraph about links stored with the request host is true in the code (the publish route uses `request.base_url`, the recipe auto-publish uses `backend_url`, the front door sets `Host` to the Cloud Run host, the native-bootstrap and device routes build `web_origin` from `request.base_url`).
"""
from __future__ import annotations

from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]


def _sec9() -> str:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    return text[text.index("## 9. "):text.index("## 10. ")]


def test_the_status_paragraph_states_what_is_done_deferred_accepted_and_still_direct() -> None:
    sec = _sec9()
    status = sec[sec.index("**Phase 2 status"):sec.index("**Links stored with the request host (fixed by `PUBLIC_API_URL`).**")]
    for needle in (
        "34 agents and 17 relays moved", "the defaults of the Python and host connectors, the guides' dev examples and fakechat", "the Pi, OpenCode and OpenClaw entry points keep the prod app domain, see Phase 2",
        "about 1,800 requests a day", "the dev GitHub App's webhook and the repository webhook of `moonklabs/sprintable`", "a redelivery of each answered 200 through the front door",
        "the GA4 callback had 0 requests in 24 hours", "`score-ga4-outcomes`", "the Polar webhook had 0", "the branch `damrong/4796-ga4-backend-url`, not merged",
        "**Accepted cost:** after Phase 3 a GA4 connect started on dev fails with `redirect_uri_mismatch`", "the Google console knows only the old callback", "its webhook url is not moved", "the route exists on the VM only if `LICENSE_CONSENT` is `agreed`", "a `live_plain` name",
        "another Mac (an app version older than 0.2.2)", "the relay gap of story 4801", "retries with dead keys", "`dev-app`'s worker stream going straight to the backend",
    ):
        assert needle in status, needle


def test_the_stored_link_paragraph_is_true_in_the_code() -> None:
    routes = (_ROOT / "backend/app/routers/site_posts.py").read_text()
    services = (_ROOT / "backend/app/services/site_posts.py").read_text()
    assert "backend_base_url=public_api_origin(request)," in routes and "backend_base_url=public_api_origin(fallback=settings.backend_url)," in services, "the fix: no origin is built from the request any more"
    assert 'action="site_post_published"' in services and '"url": url' in services
    assert 'str(request.base_url).rstrip("/")' in (_ROOT / "backend/app/core/public_origin.py").read_text(), "the old behaviour survives only as the fallback when nothing is configured"
    assert "header_up Host {upstream_hostport}" in (_ROOT / "deploy/vm/bin/front-door.sh").read_text()
    for rel in ("backend/app/routers/auth_native_bootstrap.py", "backend/app/routers/device_installations.py"):
        assert "web_origin=public_api_origin(request)," in (_ROOT / rel).read_text(), rel
    sec = _sec9()
    para = sec[sec.index("**Links stored with the request host (fixed by `PUBLIC_API_URL`).**"):sec.index("\nOrder of work:")]
    for needle in ("`request.base_url`", "`header_up Host {upstream_hostport}`", "answer 404 once the Cloud Run backend is deleted (§10)", "the recipe-approved auto-publish (whose fallback is `backend_url`)",
                   "build from `public_api_origin()`", "on dev that is `PUBLIC_API_URL`, set from the one switch", "empty (prod) means the request's host, as before",
                   "rewritten by the one-off job of §10 («Stored hosted-site links»), a precondition of Phase 3", "after Phase 3 the host is `dev-api`"):
        assert needle in para, needle
    assert "Before §10 count the stored links" not in para, "the count is now the job's report, not a hand query"


def test_the_ga4_and_polar_statements_match_the_vm_env_and_the_code() -> None:
    """codex (status docs PR): the VM's BACKEND_URL is the dev API name, so a GA4 connect fails at Google (redirect_uri_mismatch), not at a closed host; the billing router exists only when LICENSE_CONSENT is `agreed`, which the VM takes from the private plain file"""
    import re

    env = (_ROOT / "deploy/vm/env/dev.yaml").read_text()
    assert 'BACKEND_URL: "https://dev-api.sprintable.ai"' in env
    live_plain = env[env.index("live_plain:"):]
    assert re.search(r"(?m)^\s+- LICENSE_CONSENT$", live_plain.split("\nprod")[0]), "LICENSE_CONSENT is a live_plain name, not dropped"
    config = (_ROOT / "backend/app/core/config.py").read_text()
    assert 'return self.license_consent.lower() == "agreed"' in config
    main = (_ROOT / "backend/app/main.py").read_text()
    assert "if settings.is_ee_enabled:\n    from ee.routers import billing" in main and 'app.include_router(billing.router, prefix="/api/v2/billing")' in main
    mc = (_ROOT / "backend/app/routers/measurement_connections.py").read_text()
    assert "settings.backend_url.rstrip('/')}/api/v2/measurement-connections/ga4/callback" in mc
    sec = _sec9()
    assert "Unless the organization has a site connector with a `site_base_url`" in sec
    services = (_ROOT / "backend/app/services/site_posts.py").read_text()
    assert 'raw = connector.org_config.get("site_base_url")' in services and "if site_base_url is not None:" in services


def test_section_9_does_not_say_every_connector_default_moved() -> None:
    """codex (status docs PR, round 3): the Pi and OpenCode extensions and the OpenClaw channel name the prod app domain when no address is set, in section 9 as well as in Phase 2"""
    sec = _sec9()
    assert "the dev defaults of the Python and host connectors (`DEFAULT_API_URL` in `connectors/`)" in sec
    assert "and the entry points of the Pi and OpenCode extensions and the OpenClaw channel, which use `https://app.sprintable.ai` when `SPRINTABLE_API_URL` is not set" in sec
    assert "so do the dev defaults of the connectors (`DEFAULT_API_URL` in `connectors/`);" not in sec
