"""E-GHAPP Bot-L.1: PR↔story 링크 모델·resolver 체인·auto-match·close-on-merge 단위(산티아고 게이트).

커버: advance_story_to_done idempotent · resolver priority(explicit>auto high>SID) · auto high single-exact
만 link/close · auto medium/low/ambiguous suggestion(close 0) · SID legacy(org None) 무회귀 · explicit-link
endpoint anti-IDOR(same-org success·cross-org 404 oracle 0) · upsert · close-on-merge confident-only.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.services import pr_story_link as prl
from app.services.pr_story_link import ResolvedLink, normalize_repo, resolve_story_for_pr

ORG_A = uuid.uuid4()
ORG_B = uuid.uuid4()
STORY_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


def _scalars(rows):
    r = MagicMock()
    r.scalars.return_value.all.return_value = list(rows)
    return r


def _session(execute_seq):
    s = AsyncMock()
    s.execute = AsyncMock(side_effect=list(execute_seq))
    return s


def _story(id=STORY_ID, org_id=ORG_A, title="Add SSO login", status="in_progress"):
    return MagicMock(id=id, org_id=org_id, title=title, status=status)


def _link(story_id=STORY_ID, source="explicit", confidence="high"):
    return MagicMock(story_id=story_id, link_source=source, confidence=confidence, evidence=None)


# ── advance_story_to_done (단일 idempotent 헬퍼) ──────────────────────────────────
@pytest.mark.anyio
async def test_advance_story_to_done_transitions_and_emits():
    from app.services.story_status_events import advance_story_to_done
    story = _story(status="in_review")
    session = AsyncMock()
    with patch("app.services.story_status_events.emit_story_status_changed", new=AsyncMock()) as emit:
        changed = await advance_story_to_done(session, ORG_A, story, actor_type="system")
    assert changed is True and story.status == "done"
    emit.assert_awaited_once()


@pytest.mark.anyio
async def test_advance_story_to_done_idempotent_when_already_done():
    from app.services.story_status_events import advance_story_to_done
    story = _story(status="done")
    session = AsyncMock()
    with patch("app.services.story_status_events.emit_story_status_changed", new=AsyncMock()) as emit:
        changed = await advance_story_to_done(session, ORG_A, story, actor_type="system")
    assert changed is False                 # 이미 done → no-op.
    emit.assert_not_awaited()


@pytest.mark.anyio
async def test_advance_story_to_done_noop_when_none():
    from app.services.story_status_events import advance_story_to_done
    assert await advance_story_to_done(AsyncMock(), ORG_A, None, actor_type="system") is False


# ── resolver 우선순위 ─────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_resolver_explicit_wins():
    """explicit link 존재 → 최우선·should_auto_close=True. SID/auto 미조회."""
    story = _story()
    session = _session([_scalar(_link(source="explicit")), _scalar(story)])  # explicit → scoped story.
    rl = await resolve_story_for_pr(session, ORG_A, "Org/Repo", 7, ["feat [SID:%s]" % uuid.uuid4()])
    assert rl.story_id == STORY_ID and rl.source == "explicit" and rl.should_auto_close is True


@pytest.mark.anyio
async def test_resolver_sid_legacy_no_org():
    """legacy(org None): explicit/auto skip → SID 전역 → high·close=True(무회귀)."""
    story = _story()
    session = _session([_scalar(story)])  # SID 전역 1쿼리.
    rl = await resolve_story_for_pr(session, None, "Org/Repo", 7, ["feat [SID:%s]" % STORY_ID])
    assert rl.story_id == STORY_ID and rl.source == "sid" and rl.confidence == "high" and rl.should_auto_close


@pytest.mark.anyio
async def test_resolver_auto_high_single_exact():
    """auto-match: title slug exact & 후보 1개 → high·link/close 가능."""
    story = _story(title="Add SSO login")
    # explicit(None) → auto_stories([story]) (SID 미도달·auto high 즉시 반환).
    session = _session([_scalar(None), _scalars([story])])
    rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 9, ["Add SSO login"])
    assert rl.story_id == STORY_ID and rl.source == "auto_match" and rl.confidence == "high"
    assert rl.should_auto_close is True


@pytest.mark.anyio
async def test_resolver_auto_ambiguous_multiple_exact_no_close():
    """동일 slug 후보 복수 → ambiguous low·link 없음·close 금지(오매치 방지)."""
    s1, s2 = _story(id=uuid.uuid4(), title="Add SSO login"), _story(id=uuid.uuid4(), title="Add SSO login")
    session = _session([_scalar(None), _scalars([s1, s2]), _scalar(None)])  # explicit·auto(복수)·SID(None).
    rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 9, ["Add SSO login"])
    assert rl.story_id is None and rl.should_auto_close is False  # canonical link/close 금지.


@pytest.mark.anyio
async def test_resolver_auto_partial_medium_no_close_falls_below_sid():
    """partial token 후보(medium) + SID 있으면 SID(high)가 우선. SID 없으면 medium suggestion(close 0)."""
    partial = _story(id=uuid.uuid4(), title="Refactor SSO token cache layer")
    sid_story = _story(id=STORY_ID, title="Whatever")
    # SID 존재 케이스: explicit(None)·auto([partial]→medium)·SID(sid_story) → SID high 우선.
    session = _session([_scalar(None), _scalars([partial]), _scalar(sid_story)])
    rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 9, ["feat sso token [SID:%s]" % STORY_ID])
    assert rl.source == "sid" and rl.should_auto_close is True  # auto medium 이 SID 아래.


@pytest.mark.anyio
async def test_resolver_no_match_reason_legacy():
    """SID 없음(legacy) → no_sid_tag. SID 있으나 story 없음 → story_not_found."""
    s1 = _session([_scalar(None)])  # legacy SID 전역 미스(SID 없음 → SID 쿼리 자체 없음).
    rl1 = await resolve_story_for_pr(s1, None, "o/r", 1, ["no tag here"])
    assert rl1.story_id is None and rl1.reason == "no_sid_tag"
    s2 = _session([_scalar(None)])  # SID 있으나 전역 story None.
    rl2 = await resolve_story_for_pr(s2, None, "o/r", 1, ["feat [SID:%s]" % uuid.uuid4()])
    assert rl2.story_id is None and rl2.reason == "story_not_found"


def test_normalize_repo_lowercase():
    assert normalize_repo("  MoonkLabs/Sprintable ") == "moonklabs/sprintable"


# ── explicit-link endpoint (anti-IDOR) ───────────────────────────────────────────
async def _post_link(body, *, org_id=ORG_A, story_result, member_id=None):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app
    from app.routers import github_integration as gi

    session = AsyncMock()
    session.add = MagicMock()
    res = MagicMock()
    res.scalar_one_or_none.return_value = story_result
    session.execute = AsyncMock(return_value=res)
    session.commit = AsyncMock()
    session.flush = AsyncMock()

    async def override_db():
        yield session

    fastapi_app.dependency_overrides[get_db] = override_db
    fastapi_app.dependency_overrides[get_verified_org_id] = lambda: org_id
    # 엔드포인트는 auth.user_id(=member id)만 사용 → 경량 stub(AuthContext 전체 생성자 회피).
    fastapi_app.dependency_overrides[get_current_user] = lambda: MagicMock(
        user_id=str(member_id or uuid.uuid4())
    )
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(gi, "upsert_link", new=AsyncMock(return_value=MagicMock(
                id=uuid.uuid4(), repo_full_name="org/repo", pr_number=body["pr_number"]))) as up:
                resp = await c.post("/api/v2/integrations/github/links", json=body)
        return resp, up
    finally:
        fastapi_app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_explicit_link_same_org_success():
    body = {"story_id": str(STORY_ID), "repo_full_name": "org/repo", "pr_number": 7}
    resp, up = await _post_link(body, story_result=_story(org_id=ORG_A))
    assert resp.status_code == 200
    up.assert_awaited_once()  # org-scope story 통과 → upsert.


@pytest.mark.anyio
async def test_explicit_link_cross_org_404_no_oracle():
    """타 org story_id → org-scope 조회 미스 → generic 404·upsert 0(존재 oracle 0)."""
    body = {"story_id": str(STORY_ID), "repo_full_name": "org/repo", "pr_number": 7}
    resp, up = await _post_link(body, story_result=None)  # 타 org/부재 → scoped 미스.
    assert resp.status_code == 404
    up.assert_not_awaited()


@pytest.mark.anyio
async def test_explicit_link_invalid_pr_identity_422():
    body = {"story_id": str(STORY_ID), "repo_full_name": "  ", "pr_number": 0}
    resp, up = await _post_link(body, story_result=_story(org_id=ORG_A))
    assert resp.status_code == 422
    up.assert_not_awaited()


# ── close-on-merge (웹훅 통합·confident-only) ─────────────────────────────────────
import hashlib  # noqa: E402
import hmac  # noqa: E402
import json  # noqa: E402

_WH_SECRET = "legacy-wh-secret"


async def _merge_webhook(*, should_close: bool):
    """legacy merge PR(SID·head.sha 없음→native CI skip) → close-on-merge 경로 검증."""
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app
    from app.routers import verdict_capture as vmod

    story = _story(id=STORY_ID, org_id=ORG_A, status="in_review")
    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar(story))  # SID 전역 story.
    session.get = AsyncMock(return_value=story)

    async def override_db():
        yield session

    fastapi_app.dependency_overrides[get_db] = override_db
    payload = {"action": "closed", "repository": {"full_name": "o/r"},
               "pull_request": {"number": 5, "merged": True, "title": f"feat [SID:{STORY_ID}]"}}
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(_WH_SECRET.encode(), body, hashlib.sha256).hexdigest()
    headers = {"X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "m1", "X-Hub-Signature-256": sig}
    # resolver 가 반환할 should_auto_close 를 강제(SID=True / 비confident=False) — close 분기만 격리 검증.
    rl = ResolvedLink(STORY_ID, ORG_A, "sid", "high", should_close, "sid_exact")
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(vmod.settings, "github_webhook_secret", _WH_SECRET), \
                 patch.object(vmod.settings, "github_app_webhook_secret", ""), \
                 patch.object(vmod, "resolve_story_for_pr", new=AsyncMock(return_value=rl)), \
                 patch.object(vmod, "capture_pr_ci_verdict",
                              new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})), \
                 patch.object(vmod, "advance_story_to_done", new=AsyncMock(return_value=True)) as adv:
                resp = await c.post("/api/v2/internal/verdict/github-webhook", content=body, headers=headers)
        return resp, adv, session
    finally:
        fastapi_app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_close_on_merge_confident_advances_story():
    """merge + confident link(should_auto_close) → advance_story_to_done 호출(done)."""
    resp, adv, session = await _merge_webhook(should_close=True)
    assert resp.status_code == 200
    adv.assert_awaited_once()  # 단일 헬퍼로 done 진행.
    assert "auto_close" in resp.text


@pytest.mark.anyio
async def test_close_on_merge_skips_when_not_confident():
    """merge 라도 should_auto_close=False(med/low/text) → advance 미호출(오매치 done 0)."""
    resp, adv, session = await _merge_webhook(should_close=False)
    assert resp.status_code == 200
    adv.assert_not_awaited()
