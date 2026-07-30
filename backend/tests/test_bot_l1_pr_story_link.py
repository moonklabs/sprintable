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
async def test_resolver_auto_substring_not_high_no_close():
    """⭐substring/contains 는 high 아님(오매치 방지): story 'Login' + PR 'fix login bug' → high/close 금지.

    exact slug equality 만 high. 'login' 은 'fix-login-bug' 의 부분문자열이지만 != 전체 slug → token overlap
    (medium/low) → canonical link/auto-close 안 됨(story_id None·should_auto_close False).
    """
    story = _story(id=uuid.uuid4(), title="Login")
    # explicit(None) → auto_stories([story]) → SID(None). auto 가 high 면 안 됨.
    session = _session([_scalar(None), _scalars([story]), _scalar(None)])
    rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 9, ["fix login bug"])
    assert rl.confidence != "high"
    assert rl.story_id is None and rl.should_auto_close is False  # auto-close 안 됨.


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


# ── story_number SID(§2327 후속, 2026-07-30) — org-scope 조회 + 유일성 ─────────────
# 실측 근거: _SID_RE(UUID 36자 전용)가 팀이 실제로 쓰는 두 PR 제목 형식(`[SID:2288]`·
# `fix(#2288):`) 어느 쪽과도 안 맞았다 — 오늘 PR 제목 3건으로 직접 실행해 확認(story #2202).
# story_number는 org 전체 유일이 아니므로(uq_stories_project_id_story_number) 여기서도 "정확히
# 1건일 때만 확定"을 반드시 검증한다(0건·2건+는 오매치 방지를 위해 close 금지).

@pytest.mark.anyio
async def test_resolver_story_number_bracket_form_resolves_when_org_known():
    """`[SID:2288]`(팀 실사용 형식1) + org 알 때 + 정확히 1건 → sid_exact_by_number·close 가능."""
    story = _story(id=uuid.uuid4())
    # explicit(None) → auto_match([]) → scoped_story_by_number([story]).
    session = _session([_scalar(None), _scalars([]), _scalars([story])])
    rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 7, ["[SID:2288] 세 목록 상호참조 코멘트에 만료 조건 추가"])
    assert rl.story_id == story.id and rl.source == "sid" and rl.confidence == "high"
    assert rl.should_auto_close is True and rl.reason == "sid_exact_by_number"


@pytest.mark.anyio
async def test_resolver_story_number_fix_hash_form_resolves_when_org_known():
    """`fix(#2328):`(팀 실사용 형식2) + org 알 때 + 정확히 1건 → 동일하게 해소."""
    story = _story(id=uuid.uuid4())
    session = _session([_scalar(None), _scalars([]), _scalars([story])])
    rl = await resolve_story_for_pr(
        session, ORG_A, "org/repo", 7, ["fix(#2328): 후보 머리글에 유나 규격의 em-dash 리터럴이 빠져 있었다"]
    )
    assert rl.story_id == story.id and rl.source == "sid" and rl.confidence == "high"
    assert rl.should_auto_close is True


@pytest.mark.anyio
async def test_resolver_story_number_negative_no_marker_falls_through():
    """숫자만 있고 마커 없으면(`fix: bump to 2288ms`) story_number 파싱 자체가 안 된다 — no_sid_tag로 귀결."""
    session = _session([_scalar(None), _scalars([])])  # explicit(None) → auto_match([]) → 그 이상 안 감.
    rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 7, ["fix: bump timeout to 2288ms"])
    assert rl.story_id is None and rl.reason == "no_sid_tag"


@pytest.mark.anyio
async def test_resolver_story_number_ambiguous_across_projects_no_resolve():
    """같은 org 안 다른 project 에 같은 story_number 2건+ → 추측 안 함(close 금지·ambiguous 사유)."""
    # explicit(None) → auto_match([]) → scoped_story_by_number(2건, len!=1 → None) → probe(2건, ambiguous 판정).
    session = _session([_scalar(None), _scalars([]), _scalars([_story(), _story()]), _scalars([_story(), _story()])])
    with patch.object(prl.logger, "warning") as warn:
        rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 7, ["[SID:1] title"])
    assert rl.story_id is None and rl.should_auto_close is False
    assert rl.reason == "story_number_ambiguous"
    # PO 지적(2026-07-30) — 「조용히 안 붙는」것 방지: skip이 셀 수 있는 신호를 남겨야 한다.
    warn.assert_called_once()
    assert "story_number_ambiguous" in warn.call_args.args[0]


@pytest.mark.anyio
async def test_resolver_story_number_not_found_when_org_known():
    """org 알고 번호 태그 있으나 0건 → story_number_not_found(추측 없이 skip)."""
    session = _session([_scalar(None), _scalars([]), _scalars([]), _scalars([])])
    with patch.object(prl.logger, "warning") as warn:
        rl = await resolve_story_for_pr(session, ORG_A, "org/repo", 7, ["[SID:99999]"])
    assert rl.story_id is None and rl.reason == "story_number_not_found"
    warn.assert_not_called()  # not_found(0건)는 ambiguous가 아니다 — 경고 과다발생 방지.


@pytest.mark.anyio
async def test_resolver_story_number_requires_org_scope_when_org_none():
    """legacy(org 미상) + 번호 태그 → «전역 조회로 오매치」를 막기 위해 DB 호출 자체를 안 함.

    org_id None이면 explicit/auto_match/(uuid) global 조회 전부 미도달이고 number 축도 org
    가드에 걸려 조회 자체가 없다 — execute 0회를 `_session([])`(빈 side_effect)로 직접 증명한다."""
    session = _session([])
    rl = await resolve_story_for_pr(session, None, "org/repo", 7, ["[SID:2288] title"])
    assert rl.story_id is None and rl.reason == "story_number_requires_org_scope"
    session.execute.assert_not_awaited()


# ── legacy org resolve(repo owner→account_login, story #2327 후속) ──────────────
@pytest.mark.anyio
async def test_resolve_legacy_org_by_repo_owner_exact_one_match():
    from app.routers.verdict_capture import _resolve_legacy_org_by_repo_owner

    session = _session([_scalars([ORG_A])])
    org_id, reason = await _resolve_legacy_org_by_repo_owner(session, "moonklabs/sprintable")
    assert org_id == ORG_A and reason == "org_resolved_via_repo_owner"


@pytest.mark.anyio
async def test_resolve_legacy_org_by_repo_owner_ambiguous_two_matches():
    """2건+ → 「첫 것을 고른다」 금지 — 거부(None)."""
    from app.routers.verdict_capture import _resolve_legacy_org_by_repo_owner

    session = _session([_scalars([ORG_A, ORG_B])])
    org_id, reason = await _resolve_legacy_org_by_repo_owner(session, "shared/repo")
    assert org_id is None and reason == "repo_owner_ambiguous"


@pytest.mark.anyio
async def test_resolve_legacy_org_by_repo_owner_zero_matches():
    from app.routers.verdict_capture import _resolve_legacy_org_by_repo_owner

    session = _session([_scalars([])])
    org_id, reason = await _resolve_legacy_org_by_repo_owner(session, "unknown-owner/repo")
    assert org_id is None and reason == "repo_owner_unknown"


@pytest.mark.anyio
async def test_resolve_legacy_org_by_repo_owner_malformed_repo_no_db_call():
    """`owner/repo` 형식 아니면 추측 없이 즉시 unknown — DB 조회 자체를 안 함."""
    from app.routers.verdict_capture import _resolve_legacy_org_by_repo_owner

    session = _session([])
    org_id, reason = await _resolve_legacy_org_by_repo_owner(session, "no-slash-here")
    assert org_id is None and reason == "repo_owner_unknown"
    session.execute.assert_not_awaited()


# ── explicit-link endpoint (anti-IDOR) ───────────────────────────────────────────
def _inst(account_login="org"):
    return MagicMock(account_login=account_login, suspended_at=None)


async def _post_link(body, *, org_id=ORG_A, story_result, installation_result=None, member_id=None):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app
    from app.routers import github_integration as gi

    session = AsyncMock()
    session.add = MagicMock()
    story_res = MagicMock()
    story_res.scalar_one_or_none.return_value = story_result
    inst_res = MagicMock()
    inst_res.scalar_one_or_none.return_value = installation_result
    # 쿼리 순서: ①story org-scope ②installation(repo-context). story None 이면 installation 미도달.
    session.execute = AsyncMock(side_effect=[story_res, inst_res, inst_res])
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
    """story org-scope 통과 + repo owner == installation account_login → upsert."""
    body = {"story_id": str(STORY_ID), "repo_full_name": "org/repo", "pr_number": 7}
    resp, up = await _post_link(body, story_result=_story(org_id=ORG_A), installation_result=_inst("org"))
    assert resp.status_code == 200
    up.assert_awaited_once()


@pytest.mark.anyio
async def test_explicit_link_cross_org_404_no_oracle():
    """타 org story_id → org-scope 조회 미스 → generic 404·upsert 0(존재 oracle 0)."""
    body = {"story_id": str(STORY_ID), "repo_full_name": "org/repo", "pr_number": 7}
    resp, up = await _post_link(body, story_result=None)  # 타 org/부재 → scoped 미스.
    assert resp.status_code == 404
    up.assert_not_awaited()


@pytest.mark.anyio
async def test_explicit_link_repo_not_in_org_context_404():
    """story 는 org 소속이나 repo owner != installation account(or 미설치) → generic 404·upsert 0(repo oracle 0)."""
    body = {"story_id": str(STORY_ID), "repo_full_name": "evil/repo", "pr_number": 7}
    # owner 'evil' != installation account 'org' → repo_not_in_org_context.
    resp, up = await _post_link(body, story_result=_story(org_id=ORG_A), installation_result=_inst("org"))
    assert resp.status_code == 404
    up.assert_not_awaited()
    # 미설치(installation None)도 동일 404.
    resp2, up2 = await _post_link(body, story_result=_story(org_id=ORG_A), installation_result=None)
    assert resp2.status_code == 404
    up2.assert_not_awaited()


@pytest.mark.anyio
async def test_explicit_link_invalid_pr_identity_422():
    body = {"story_id": str(STORY_ID), "repo_full_name": "  ", "pr_number": 0}
    resp, up = await _post_link(body, story_result=_story(org_id=ORG_A), installation_result=_inst("org"))
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
                 patch.object(vmod, "_resolve_legacy_org_by_repo_owner",
                              new=AsyncMock(return_value=(None, "repo_owner_unknown"))), \
                 patch.object(vmod, "resolve_story_for_pr", new=AsyncMock(return_value=rl)), \
                 patch.object(vmod, "capture_pr_ci_verdict",
                              new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})), \
                 patch.object(vmod.logger, "info") as info_log:
                resp = await c.post("/api/v2/internal/verdict/github-webhook", content=body, headers=headers)
        return resp, session, info_log
    finally:
        fastapi_app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_close_on_merge_confident_reports_would_close_but_does_not_mutate():
    """story #2327 PO 판정(2026-07-30, 「머지≠done」규율) — merge + confident link여도 close-on-merge

    정지됐다: session.get(Story)로 실제 조회·mutation을 하지 않고(story.status 안 건드림), 응답의
    auto_close.closed=False·would_close=True로만 «벌어졌을 일」을 관측 가능하게 남긴다."""
    resp, session, info_log = await _merge_webhook(should_close=True)
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["auto_close"] == {
        "closed": False, "would_close": True, "source": "sid", "confidence": "high",
        "note": "story #2327 PO 판정 2026-07-30: close-on-merge 정지 — done은 사람 확認 後",
    }
    session.get.assert_not_awaited()  # story mutation 경로 자체에 안 감(no-op).
    # PO 지적(2026-07-30) — 웹훅 HTTP 응답은 아무도 안 읽는다. would_close를 로그로도 셀 수
    # 있어야 #2339(자동 done on/off 설정) 크기를 잴 수 있다.
    # story #2327 후속(legacy org repo-owner resolve)이 먼저 1회 로그 → suppressed 로그가 2번째.
    assert info_log.call_count == 2
    assert "legacy org resolve" in info_log.call_args_list[0].args[0]
    assert "auto_close suppressed" in info_log.call_args_list[1].args[0]


# ── _process_webhook_event: legacy org resolve 배선(story #2327 후속) ───────────
def _delivery():
    return MagicMock(org_id=None)


@pytest.mark.anyio
async def test_process_webhook_event_legacy_repo_owner_org_feeds_resolver():
    """repo owner로 org가 풀리면 그 org_id가 resolve_story_for_pr에 그대로 전달된다(legacy도
    app과 동등하게 org-scoped 해소를 탈 수 있게 되는 것 — 이 배선이 핵심 변경점)."""
    from app.routers import verdict_capture as vmod

    session = AsyncMock()
    delivery = _delivery()
    rl = ResolvedLink(STORY_ID, ORG_A, "sid", "high", True, "sid_exact_by_number")
    payload = {"action": "closed", "repository": {"full_name": "moonklabs/sprintable"},
               "pull_request": {"number": 9, "merged": True, "title": "fix(#2288): x"}}
    with patch.object(vmod, "_resolve_legacy_org_by_repo_owner",
                       new=AsyncMock(return_value=(ORG_A, "org_resolved_via_repo_owner"))), \
         patch.object(vmod, "resolve_story_for_pr", new=AsyncMock(return_value=rl)) as resolver, \
         patch.object(vmod, "capture_pr_ci_verdict",
                       new=AsyncMock(return_value={"recorded": ["pr"]})), \
         patch.object(vmod.logger, "info"):
        await vmod._process_webhook_event(session, "legacy", "pull_request", payload, None, delivery)
    resolver.assert_awaited_once()
    called_org_id = resolver.call_args.args[1]
    assert called_org_id == ORG_A  # None이 아니라 repo-owner로 풀린 org가 실제로 전달됨.


@pytest.mark.anyio
async def test_process_webhook_event_legacy_repo_owner_ambiguous_overrides_skipped_reason():
    """org 해소가 ambiguous(2건+)로 실패 + resolver도 그것 때문에(story_number_requires_org_scope)
    skip → 최종 skipped_reason이 더 구체적인 repo_owner_ambiguous로 대체된다(세는 자리 확보)."""
    from app.routers import verdict_capture as vmod

    session = AsyncMock()
    delivery = _delivery()
    rl = ResolvedLink(None, None, None, None, False, "story_number_requires_org_scope")
    payload = {"action": "closed", "repository": {"full_name": "shared/repo"},
               "pull_request": {"number": 9, "merged": True, "title": "fix(#2288): x"}}
    with patch.object(vmod, "_resolve_legacy_org_by_repo_owner",
                       new=AsyncMock(return_value=(None, "repo_owner_ambiguous"))), \
         patch.object(vmod, "resolve_story_for_pr", new=AsyncMock(return_value=rl)), \
         patch.object(vmod.logger, "info"):
        result, status = await vmod._process_webhook_event(
            session, "legacy", "pull_request", payload, None, delivery
        )
    assert status == "ignored"
    assert result["skipped_reason"] == "repo_owner_ambiguous"


@pytest.mark.anyio
async def test_process_webhook_event_legacy_repo_owner_unknown_unrelated_reason_not_overridden():
    """org 해소는 실패(unknown)했지만 resolver의 실제 skip 사유가 그것과 무관(no_sid_tag)하면
    그대로 둔다 — 관련 없는 skip까지 repo_owner 사유로 덮어써 원인을 흐리지 않는다."""
    from app.routers import verdict_capture as vmod

    session = AsyncMock()
    delivery = _delivery()
    rl = ResolvedLink(None, None, None, None, False, "no_sid_tag")
    payload = {"action": "closed", "repository": {"full_name": "unknown/repo"},
               "pull_request": {"number": 9, "merged": True, "title": "no tag here"}}
    with patch.object(vmod, "_resolve_legacy_org_by_repo_owner",
                       new=AsyncMock(return_value=(None, "repo_owner_unknown"))), \
         patch.object(vmod, "resolve_story_for_pr", new=AsyncMock(return_value=rl)), \
         patch.object(vmod.logger, "info"):
        result, status = await vmod._process_webhook_event(
            session, "legacy", "pull_request", payload, None, delivery
        )
    assert status == "ignored"
    assert result["skipped_reason"] == "no_sid_tag"


@pytest.mark.anyio
async def test_close_on_merge_skips_when_not_confident():
    """merge 라도 should_auto_close=False(med/low/text) → auto_close 필드 자체가 안 실림."""
    resp, session, info_log = await _merge_webhook(should_close=False)
    assert resp.status_code == 200
    assert "auto_close" not in resp.json()["data"]
    session.get.assert_not_awaited()
    # not-confident 는 suppressed 로그 대상이 아니다(로그 과다발생 방지) — legacy org resolve 로그만 1회.
    info_log.assert_called_once()
    assert "legacy org resolve" in info_log.call_args.args[0]
