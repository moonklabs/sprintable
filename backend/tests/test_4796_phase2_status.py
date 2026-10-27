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
    status = sec[sec.index("**Phase 2 status"):sec.index("**Links stored with the request host.**")]
    for needle in (
        "34 agents and 17 relays moved", "the connectors' defaults, the guides' dev examples and fakechat",
        "about 1,800 requests a day", "the dev GitHub App's webhook and the repository webhook of `moonklabs/sprintable`", "a redelivery of each answered 200 through the front door",
        "the GA4 callback had 0 requests in 24 hours", "`score-ga4-outcomes`", "the Polar webhook had 0", "the branch `damrong/4796-ga4-backend-url`, not merged",
        "**Accepted cost:** after Phase 3 a GA4 connect started on dev fails", "a Polar webhook for dev would not arrive",
        "another Mac (an app version older than 0.2.2)", "the relay gap of story 4801", "retries with dead keys", "`dev-app`'s worker stream going straight to the backend",
    ):
        assert needle in status, needle


def test_the_stored_link_paragraph_is_true_in_the_code() -> None:
    routes = (_ROOT / "backend/app/routers/site_posts.py").read_text()
    services = (_ROOT / "backend/app/services/site_posts.py").read_text()
    assert "backend_base_url=str(request.base_url)" in routes and "backend_base_url=settings.backend_url" in services
    assert 'action="site_post_published"' in services and '"url": url' in services
    assert "header_up Host {upstream_hostport}" in (_ROOT / "deploy/vm/bin/front-door.sh").read_text()
    for rel in ("backend/app/routers/auth_native_bootstrap.py", "backend/app/routers/device_installations.py"):
        assert 'web_origin=str(request.base_url).rstrip("/")' in (_ROOT / rel).read_text(), rel
    sec = _sec9()
    para = sec[sec.index("**Links stored with the request host.**"):sec.index("\nOrder of work:")]
    for needle in ("`request.base_url`", "`header_up Host {upstream_hostport}`", "as they did before the flip", "answer 404 once the Cloud Run backend is deleted (§10)", "the recipe-approved auto-publish builds its link from `backend_url`",
                   "Before §10 count the stored links", "contains `run.app`"):
        assert needle in para, needle
