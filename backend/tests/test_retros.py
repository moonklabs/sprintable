"""S24 AC: Retro router + repository 단위 테스트 (7건 이상).

#1801 까심 QA HIGH(same-org cross-project IDOR) fix 후: `_require_retro_project_access`가 모든
session-scoped 라우트에서 `has_project_access`를 호출하므로, 기존 테스트는 그 호출을 명시
patch해야 한다(패치 안 하면 진짜 session.execute가 한 번 더 끼어들어 call-count 기반 mock
순번이 밀림 — 광역 mock 공유 함정. [[feedback_shared_flow_query_breaks_broad_mock]])."""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OTHER_PROJECT_ID = uuid.uuid4()
SESSION_ID = uuid.uuid4()
ITEM_ID = uuid.uuid4()
VOTER_ID = uuid.uuid4()


def _mock_session(phase: str = "collect", project_id: uuid.UUID = PROJECT_ID) -> MagicMock:
    s = MagicMock()
    s.id = SESSION_ID
    s.org_id = ORG_ID
    s.project_id = project_id
    s.sprint_id = None
    s.created_by = None
    s.title = "Sprint 3 Retro"
    s.phase = phase
    s.items = []
    s.actions = []
    s.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    # dc861e44: MagicMock은 미설정 속성을 truthy 자동생성하므로(parent_item_id와 동일 함정)
    # 명시 None — 실 ORM 컬럼 기본값(미생성)과 정합, SessionResponse(synthesis: Synthesis|None)
    # Pydantic 검증 통과에 필수.
    s.synthesis = None
    s.next_hypotheses = None
    return s


def _mock_item() -> MagicMock:
    i = MagicMock()
    i.id = ITEM_ID
    i.session_id = SESSION_ID
    i.author_id = None
    i.category = "good"
    i.text = "팀워크 좋았는"
    i.vote_count = 2
    i.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    # RetroItem 실 모델엔 없는 계산 필드 — MagicMock은 미설정 속성도 truthy를 자동생성하므로
    # (실 ORM 객체라면 getattr 이 없어 pydantic 기본값 False로 떨어짐) 명시적으로 맞춰준다.
    i.voted_by_me = False
    # B2: 실 컬럼(parent_item_id)이지만 미설정 시 MagicMock이 truthy 자동생성 → 잘못
    # "그룹핑됨"으로 오판(vote_item의 `is not None` 체크·get_session의 visible_items 필터
    # 둘 다 영향). 기본은 top-level(None).
    i.parent_item_id = None
    return i


def _mock_action() -> MagicMock:
    a = MagicMock()
    a.id = uuid.uuid4()
    a.session_id = SESSION_ID
    a.assignee_id = None
    a.title = "CI 속도 개선"
    a.status = "open"
    a.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return a


def _mock_vote() -> MagicMock:
    v = MagicMock()
    v.id = uuid.uuid4()
    v.item_id = ITEM_ID
    v.voter_id = VOTER_ID
    v.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return v


def _allow_project_access():
    """has_project_access를 True로 patch(router-local import 경로) — session-scope pre-check용."""
    return patch("app.routers.retros.has_project_access", new=AsyncMock(return_value=True))


def _deny_project_access():
    return patch("app.routers.retros.has_project_access", new=AsyncMock(return_value=False))


def _mock_resolve_member(member_id: uuid.UUID | None = None, member_type: str = "human"):
    """B4/P0: 라우터가 호출하는 resolve_member SSOT를 patch — DB member 해소 우회.
    ecc531ce: type 기본값 human(MagicMock 미설정 시 truthy 자동생성이 "human"과 항상
    불일치해 adopt 라우트의 human-gate가 오탐 403을 내던 함정 — 명시 설정 필수)."""
    resolved = MagicMock()
    resolved.id = member_id or uuid.uuid4()
    resolved.type = member_type
    return patch("app.routers.retros.resolve_member", new=AsyncMock(return_value=resolved))


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_list_retro_sessions_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_session()]
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["phase"] == "collect"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_retro_sessions_no_project_id_filters_by_access():
    """project_id 생략 시 org 전체가 아니라 has_project_access 통과분만 반환(#1801 스윕)."""
    client, session, app = await _client()
    try:
        accessible = _mock_session(project_id=PROJECT_ID)
        inaccessible = _mock_session(project_id=OTHER_PROJECT_ID)
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [accessible, inaccessible]
        session.execute = AsyncMock(return_value=mock_result)

        async def fake_access(_db, _user_id, project_id, _org_id):
            return project_id == PROJECT_ID

        with patch("app.routers.retros.has_project_access", new=AsyncMock(side_effect=fake_access)):
            async with client as c:
                resp = await c.get("/api/v2/retros")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["project_id"] == str(PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_retro_sessions_cross_project_403():
    client, session, app = await _client()
    try:
        with _deny_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros?project_id={OTHER_PROJECT_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_retro_session_201():
    client, session, app = await _client()
    try:
        resolved_id = uuid.uuid4()
        with (
            _allow_project_access(),
            _mock_resolve_member(resolved_id),
            patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_create.return_value = _mock_session()

            async with client as c:
                resp = await c.post("/api/v2/retros", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Sprint 3 Retro",
                    "created_by": str(uuid.uuid4()),  # P0: client 지정값은 무시돼야 함
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Sprint 3 Retro"
        # 핵심: created_by는 client body가 아니라 resolve_member 해소값으로 create 호출됨.
        mock_create.assert_awaited_once_with(
            project_id=PROJECT_ID, title="Sprint 3 Retro", sprint_id=None, created_by=resolved_id
        )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_retro_session_cross_project_403():
    """body.project_id를 검증 없이 신뢰하면 무권한 project에 session을 심을 수 있던 mutation IDOR."""
    client, session, app = await _client()
    try:
        with _deny_project_access():
            async with client as c:
                resp = await c.post("/api/v2/retros", json={
                    "project_id": str(OTHER_PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "무단 생성 시도",
                })

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_with_items_200():
    """GET /{id} → items + actions nested."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access(), _mock_resolve_member():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(SESSION_ID)
        assert "items" in body
        assert "actions" in body
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_voted_by_me_reflects_only_requester():
    """B4 — voted_by_me는 요청자 본인 투표만 반영(타인 투표는 노출 안 함)."""
    client, session, app = await _client()
    try:
        my_id = uuid.uuid4()
        other_id = uuid.uuid4()
        item_i_voted = _mock_item()
        item_i_voted.id = uuid.uuid4()
        item_other_voted = _mock_item()
        item_other_voted.id = uuid.uuid4()
        item_nobody_voted = _mock_item()
        item_nobody_voted.id = uuid.uuid4()

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            elif call_count == 2:
                result.scalars.return_value.all.return_value = [
                    item_i_voted, item_other_voted, item_nobody_voted,
                ]
            elif call_count == 3:
                result.scalars.return_value.all.return_value = []  # actions
            else:
                # votes query — voter_id=my_id 로 필터되므로 my_id가 실제 투표한 item만 반환
                result.scalars.return_value.all.return_value = [item_i_voted.id]
            return result

        session.execute = mock_execute

        with _allow_project_access(), _mock_resolve_member(my_id):
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 200
        items_by_id = {i["id"]: i for i in resp.json()["items"]}
        assert items_by_id[str(item_i_voted.id)]["voted_by_me"] is True
        assert items_by_id[str(item_other_voted.id)]["voted_by_me"] is False
        assert items_by_id[str(item_nobody_voted.id)]["voted_by_me"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_no_items_skips_votes_query():
    """items가 비어있으면 votes 쿼리 자체를 스킵(불필요 왕복 0)."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        with _allow_project_access(), _mock_resolve_member():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 200
        assert resp.json()["items"] == []
        # call1=session, call2=items(빈), call3=actions(빈) — votes 쿼리(4번째) 없음.
        assert call_count == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_item_default_not_voted():
    """add_item(신규 생성)은 voted_by_me 계산 없이 기본 False."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_session() if call_count == 1 else _mock_item()
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()
        session.add = MagicMock()

        with (
            _allow_project_access(),
            _mock_resolve_member(),
            patch("app.repositories.retro.RetroItemRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_create.return_value = _mock_item()

            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items", json={
                    "category": "good",
                    "text": "새 아이템",
                })

        assert resp.status_code == 201
        assert resp.json()["voted_by_me"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/retros/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_cross_project_403():
    """#1801 계열 — session은 org 내에 존재하나 caller가 그 project에 접근권 없음 → 403(404 아님)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_advance_phase_200():
    """B1 — collect → vote 인접 전이."""
    client, session, app = await _client()
    try:
        collect_session = _mock_session("collect")
        vote_session = _mock_session("vote")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            # call 1 = _require_retro_project_access pre-check, call 2 = set_phase() 내부 get()
            # (둘 다 현재 phase="collect" 세션이어야 전이 허용판정이 맞음) — call 3+ = update() 내부 get().
            if call_count <= 2:
                result.scalar_one_or_none.return_value = collect_session
            else:
                result.scalar_one_or_none.return_value = vote_session
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.patch(f"/api/v2/retros/{SESSION_ID}/phase", json={"phase": "vote"})

        assert resp.status_code == 200
        assert resp.json()["phase"] == "vote"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_advance_phase_backward_vote_to_collect_200():
    """B1 — 양방향: vote → collect 뒤로가기 허용(데이터는 손대지 않음, phase만 변경)."""
    client, session, app = await _client()
    try:
        vote_session = _mock_session("vote")
        collect_session = _mock_session("collect")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = vote_session if call_count <= 2 else collect_session
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.patch(f"/api/v2/retros/{SESSION_ID}/phase", json={"phase": "collect"})

        assert resp.status_code == 200
        assert resp.json()["phase"] == "collect"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "current_phase,target_phase",
    [
        ("collect", "action"),  # 비인접 점프
        ("collect", "closed"),  # 비인접 점프
        ("vote", "closed"),  # 비인접 점프
        ("closed", "action"),  # terminal에서 전이 시도
        ("closed", "vote"),  # terminal에서 전이 시도
        ("closed", "collect"),  # terminal에서 전이 시도
    ],
)
@pytest.mark.anyio
async def test_advance_phase_non_adjacent_rejected_400(current_phase, target_phase):
    """B1 — 비인접 전이는 여전히 거부(closed는 terminal이라 전이 0건)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(current_phase)
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access():
            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/phase", json={"phase": target_phase}
                )

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_advance_phase_same_phase_noop_200():
    """B1 — 같은 phase 재지정은 no-op(멱등 — FE 중복클릭 방어)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session("vote")
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access():
            async with client as c:
                resp = await c.patch(f"/api/v2/retros/{SESSION_ID}/phase", json={"phase": "vote"})

        assert resp.status_code == 200
        assert resp.json()["phase"] == "vote"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_item_201():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_session() if call_count == 1 else _mock_item()
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()
        session.add = MagicMock()

        resolved_id = uuid.uuid4()
        with (
            _allow_project_access(),
            _mock_resolve_member(resolved_id),
            patch("app.repositories.retro.RetroItemRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_create.return_value = _mock_item()

            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items", json={
                    "category": "good",
                    "text": "팀워크 좋았는",
                    "author_id": str(uuid.uuid4()),  # P0: client 지정값은 무시돼야 함
                })

        assert resp.status_code == 201
        assert resp.json()["category"] == "good"
        # 핵심: author_id는 client body가 아니라 resolve_member 해소값으로 create 호출됨.
        mock_create.assert_awaited_once_with(
            session_id=SESSION_ID, category="good", text="팀워크 좋았는", author_id=resolved_id
        )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_item_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroItemRepository.delete_from_session",
                new_callable=AsyncMock,
            ) as mock_delete,
        ):
            mock_delete.return_value = True

            async with client as c:
                resp = await c.delete(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}")

        assert resp.status_code == 200
        mock_delete.assert_awaited_once_with(SESSION_ID, ITEM_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_item_wrong_session_404():
    """item_id가 실존해도 session_id 소속이 아니면 404(2차 IDOR 방어 — parent session 접근권만으론 불충분)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroItemRepository.delete_from_session",
                new_callable=AsyncMock,
            ) as mock_delete,
        ):
            mock_delete.return_value = False  # 타 session 소속 item

            async with client as c:
                resp = await c.delete(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_duplicate_409():
    """중복 투표 → 409."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            # call1 = _require_retro_project_access, call2 = _require_item_in_session, call3+ = 중복투표 체크
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            elif call_count == 2:
                result.scalar_one_or_none.return_value = _mock_item()
            else:
                result.scalar_one_or_none.return_value = _mock_vote()  # 이미 존재
            return result

        session.execute = mock_execute

        with _allow_project_access(), _mock_resolve_member(VOTER_ID):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote")

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_item_wrong_session_404():
    """item_id가 session 소속이 아니면 투표도 404(2차 IDOR 방어)."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalar_one_or_none.return_value = None  # item이 이 session 소속 아님
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_grouped_child_forbidden_400():
    """B2 — parent_item_id가 있는(그룹핑된) child는 직접 투표 불가."""
    client, session, app = await _client()
    try:
        grouped_item = _mock_item()
        grouped_item.parent_item_id = uuid.uuid4()

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_session() if call_count == 1 else grouped_item
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote")

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_item_uses_resolved_caller_not_client_input():
    """P0(9f27af8f) — voter_id는 client 입력에서 완전히 배제, resolve_member 해소값만 사용
    (vote-spoofing 봉쇄). RetroVoteRepository.vote 가 resolve_member 해소값으로 호출되는지
    직접 검증(호출 인자 assert — DB 생성 필드 mocking 없이 라우팅 로직만 격리)."""
    client, session, app = await _client()
    try:
        resolved_id = uuid.uuid4()
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            # call1 = _require_retro_project_access, call2 = _require_item_in_session
            result.scalar_one_or_none.return_value = _mock_session() if call_count == 1 else _mock_item()
            return result

        session.execute = mock_execute

        with (
            _allow_project_access(),
            _mock_resolve_member(resolved_id),
            patch("app.repositories.retro.RetroVoteRepository.vote", new_callable=AsyncMock) as mock_vote,
        ):
            v = _mock_vote()
            v.voter_id = resolved_id
            mock_vote.return_value = v

            # POST body/query 어디에도 voter_id를 전혀 안 보냄 — 파라미터 자체가 없다.
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote")

        assert resp.status_code == 201
        assert resp.json()["voter_id"] == str(resolved_id)
        # 핵심: vote()가 resolve_member 해소값으로만 호출됐는지(client 입력 경로 자체가 없음).
        mock_vote.assert_awaited_once_with(ITEM_ID, resolved_id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_group_item_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        parent_id = uuid.uuid4()
        grouped = _mock_item()
        grouped.parent_item_id = parent_id

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroItemRepository.group_under_parent",
                new_callable=AsyncMock,
            ) as mock_group,
        ):
            mock_group.return_value = grouped

            async with client as c:
                resp = await c.post(
                    f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/group",
                    json={"parent_item_id": str(parent_id)},
                )

        assert resp.status_code == 200
        assert resp.json()["parent_item_id"] == str(parent_id)
        mock_group.assert_awaited_once_with(SESSION_ID, ITEM_ID, parent_id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_group_item_invalid_400():
    """category 불일치·이미 그룹핑됨·parent가 top-level 아님 등 — ValueError를 400으로 매핑."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroItemRepository.group_under_parent",
                new_callable=AsyncMock,
            ) as mock_group,
        ):
            mock_group.side_effect = ValueError("CATEGORY_MISMATCH")

            async with client as c:
                resp = await c.post(
                    f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/group",
                    json={"parent_item_id": str(uuid.uuid4())},
                )

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_ungroup_item_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        ungrouped = _mock_item()
        ungrouped.parent_item_id = None

        with (
            _allow_project_access(),
            patch("app.repositories.retro.RetroItemRepository.ungroup", new_callable=AsyncMock) as mock_ungroup,
        ):
            mock_ungroup.return_value = ungrouped

            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/ungroup")

        assert resp.status_code == 200
        assert resp.json()["parent_item_id"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_ungroup_item_not_found_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch("app.repositories.retro.RetroItemRepository.ungroup", new_callable=AsyncMock) as mock_ungroup,
        ):
            mock_ungroup.return_value = None

            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/ungroup")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_session_includes_grouped_children_flat():
    """P1(9f27af8f, 유나 real-payload 재현) — get_session은 grouped child도 items에 그대로
    포함(flat 배열, parent_item_id 세팅) — FE가 top-level/child를 자체 필터링해 클러스터를
    그리므로 child 객체 자체가 응답에 있어야 함(id만으론 렌더 불가). export만 top-level-only 유지."""
    client, session, app = await _client()
    try:
        parent = _mock_item()
        parent.id = uuid.uuid4()
        parent.parent_item_id = None
        child = _mock_item()
        child.id = uuid.uuid4()
        child.parent_item_id = parent.id

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            elif call_count == 2:
                result.scalars.return_value.all.return_value = [parent, child]
            elif call_count == 3:
                result.scalars.return_value.all.return_value = []  # actions
            else:
                result.scalars.return_value.all.return_value = []  # votes
            return result

        session.execute = mock_execute

        with _allow_project_access(), _mock_resolve_member():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        items = resp.json()["items"]
        by_id = {i["id"]: i for i in items}
        assert len(items) == 2
        assert by_id[str(parent.id)]["parent_item_id"] is None
        assert by_id[str(parent.id)]["grouped_item_ids"] == [str(child.id)]
        assert by_id[str(child.id)]["parent_item_id"] == str(parent.id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_action_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        updated_action = _mock_action()
        updated_action.status = "done"

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroActionRepository.update_in_session",
                new_callable=AsyncMock,
            ) as mock_update,
        ):
            mock_update.return_value = updated_action

            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/actions/{updated_action.id}",
                    json={"status": "done"},
                )

        assert resp.status_code == 200
        assert resp.json()["status"] == "done"
        mock_update.assert_awaited_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_action_cross_project_403():
    """#1801 원 적출 지점 — parent session이 caller 무권한 project 소속이면 403."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/actions/{uuid.uuid4()}",
                    json={"status": "done"},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_action_wrong_session_404():
    """action_id가 실존해도 session_id 소속이 아니면 404(2차 IDOR 방어)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroActionRepository.update_in_session",
                new_callable=AsyncMock,
            ) as mock_update,
        ):
            mock_update.return_value = None  # 타 session 소속 action

            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/actions/{uuid.uuid4()}",
                    json={"status": "done"},
                )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_export_markdown_200():
    client, session, app = await _client()
    try:
        retro_session = _mock_session("closed")
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = retro_session
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}/export")

        assert resp.status_code == 200
        assert "Sprint 3 Retro" in resp.text
        assert "# " in resp.text
    finally:
        app.dependency_overrides.clear()


# ── dc861e44: synthesize / recommend-next ────────────────────────────────────

@pytest.mark.anyio
async def test_synthesize_session_cross_project_403():
    """IDOR 가드 상속(#1801) — synthesize도 _require_retro_project_access를 탐."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/synthesize")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_synthesize_session_200_persists_via_repo_update():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalars.return_value.all.return_value = []  # items/actions 빈 리스트
            return result

        session.execute = mock_execute

        synthesis_result = {
            "learned": [{"text": "배운 것", "source": "s"}],
            "generated_at": "2026-07-03T00:00:00+00:00", "source": "ai_draft",
        }
        updated = _mock_session()
        updated.synthesis = synthesis_result

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.routers.retros.synth_svc.synthesize", new=AsyncMock(return_value=synthesis_result)),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock(return_value=updated)) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/synthesize")

        assert resp.status_code == 200
        assert resp.json()["synthesis"]["learned"][0]["text"] == "배운 것"
        mock_update.assert_awaited_once_with(SESSION_ID, synthesis=synthesis_result)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_synthesize_llm_failure_does_not_overwrite_existing_cache():
    """data-loss 방지(오르테가 지적 2026-07-03) — LLM 생성 실패(svc가 None 반환) 시 502를
    반환하고 repo.update()를 절대 호출하지 않는다(기존 good synthesis 캐시 보존)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch("app.routers.retros.synth_svc.synthesize", new=AsyncMock(return_value=None)),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock()) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/synthesize")

        assert resp.status_code == 502
        assert resp.json()["error"]["code"] == "SYNTHESIS_GENERATION_FAILED"
        mock_update.assert_not_awaited()  # 핵심 — 실패 시 캐시 절대 건드리지 않음
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_recommend_next_llm_failure_does_not_overwrite_existing_cache():
    client, session, app = await _client()
    try:
        s = _mock_session()
        s.synthesis = {"learned": [{"text": "x", "source": "s"}], "generated_at": "t", "source": "ai_draft"}
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = s
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch("app.routers.retros.synth_svc.recommend_next", new=AsyncMock(return_value=None)),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock()) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/recommend-next")

        assert resp.status_code == 502
        assert resp.json()["error"]["code"] == "RECOMMENDATION_GENERATION_FAILED"
        mock_update.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_recommend_next_without_synthesis_409():
    """PO 결(2026-07-03) — synthesis 미생성 시 fail-closed 409(자동 선행 생성 안 함)."""
    client, session, app = await _client()
    try:
        s = _mock_session()
        s.synthesis = None
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = s
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access():
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/recommend-next")

        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "SYNTHESIS_REQUIRED"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("malformed_synthesis", [
    {},                          # dict이지만 learned 키 부재
    [],                          # dict조차 아님 — .get() 호출 시 AttributeError 크래시 지점
    {"learned": []},             # 형태는 맞지만 실제론 빈 종합(근거 없음으로 생성된 케이스)
    {"learned": "x"},            # learned가 list가 아님
    "not a dict",                # 완전 이형
    {"learned": [123]},          # 까심 codex RC②: 아이템이 dict가 아님(shape 미검증 시 통과)
    {"learned": [{}]},           # 아이템이 dict지만 text 키 부재
    {"learned": [{"text": "  "}]},  # text가 공백뿐
])
@pytest.mark.anyio
async def test_recommend_next_malformed_synthesis_409_not_crash(malformed_synthesis):
    """까심 RC②(2026-07-03) — `is None`만 보던 구 게이트는 `[]`를 통과시켜
    `_build_next_hypotheses_prompt`의 `.get()` 호출에서 500 크래시가 났다. `_has_valid_synthesis`
    는 이 전부를 409로 fail-closed(크래시 없음·LLM 호출 없음·persist 없음)."""
    client, session, app = await _client()
    try:
        s = _mock_session()
        s.synthesis = malformed_synthesis
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = s
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch("app.routers.retros.synth_svc.recommend_next") as mock_recommend,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/recommend-next")

        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "SYNTHESIS_REQUIRED"
        mock_recommend.assert_not_called()  # 게이트에서 막혀 LLM 경로 진입 자체를 안 함
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_recommend_next_cross_project_403():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/recommend-next")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_recommend_next_200_when_synthesis_present():
    client, session, app = await _client()
    try:
        s = _mock_session()
        s.synthesis = {
            "learned": [{"text": "x", "source": "s"}],
            "generated_at": "2026-07-03T00:00:00+00:00", "source": "ai_draft",
        }
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = s
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        candidates = [{
            "id": str(uuid.uuid4()), "statement": "다음엔 X를 검증할 것이다.",
            "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
            "measure_after": "2026-08-01T00:00:00+00:00", "confidence": 0.5,
            "rationale": "r", "requires_confirmation": True,
        }]
        updated = _mock_session()
        updated.synthesis = s.synthesis
        updated.next_hypotheses = candidates

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.routers.retros.synth_svc.recommend_next", new=AsyncMock(return_value=candidates)),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock(return_value=updated)) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/recommend-next")

        assert resp.status_code == 200
        assert resp.json()["next_hypotheses"][0]["statement"] == "다음엔 X를 검증할 것이다."
        mock_update.assert_awaited_once_with(SESSION_ID, next_hypotheses=candidates)
    finally:
        app.dependency_overrides.clear()


# ── story 4b87d3a6: combined POST /{id}/synthesis(FE 계약 정합) ────────────────

@pytest.mark.anyio
async def test_synthesis_combined_200_both_l2_and_l3_succeed():
    """FE `retro/[id]/page.tsx`가 기대하는 정확한 shape — 1콜로 synthesis+next_hypotheses
    둘 다 채워져 돌아온다."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        synthesis_result = {
            "learned": [{"text": "배운 것", "source": "s"}],
            "generated_at": "2026-07-04T00:00:00+00:00", "source": "ai_draft",
        }
        candidates = [{
            "id": str(uuid.uuid4()), "statement": "다음엔 X를 검증할 것이다.",
            "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
            "measure_after": "2026-08-01T00:00:00+00:00", "confidence": 0.5,
            "rationale": "r", "requires_confirmation": True,
        }]

        after_l2 = _mock_session()
        after_l2.synthesis = synthesis_result
        after_l3 = _mock_session()
        after_l3.synthesis = synthesis_result
        after_l3.next_hypotheses = candidates

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.routers.retros.synth_svc.synthesize", new=AsyncMock(return_value=synthesis_result)),
            patch("app.routers.retros.synth_svc.recommend_next", new=AsyncMock(return_value=candidates)),
            patch(
                "app.repositories.base.BaseRepository.update",
                new=AsyncMock(side_effect=[after_l2, after_l3]),
            ) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/synthesis")

        assert resp.status_code == 200
        body = resp.json()
        assert body["synthesis"]["learned"][0]["text"] == "배운 것"
        assert body["next_hypotheses"][0]["statement"] == "다음엔 X를 검증할 것이다."
        assert mock_update.await_count == 2
        mock_update.assert_any_await(SESSION_ID, synthesis=synthesis_result)
        mock_update.assert_any_await(SESSION_ID, next_hypotheses=candidates)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_synthesis_combined_l2_failure_502_no_persist():
    """L2(synthesize) 실패 → 기존 /synthesize와 동일하게 502, repo.update 절대 호출 안 됨
    (data-loss 방지 — 기존 good synthesis/next_hypotheses 캐시 그대로)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch("app.routers.retros.synth_svc.synthesize", new=AsyncMock(return_value=None)),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock()) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/synthesis")

        assert resp.status_code == 502
        assert resp.json()["error"]["code"] == "SYNTHESIS_GENERATION_FAILED"
        mock_update.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_synthesis_combined_l3_failure_still_200_preserves_cached_next_hypotheses():
    """PO crux(2026-07-04 ①) — L2 성공+L3 실패는 combined 호출 자체를 안 죽인다. synthesis는
    갱신 저장되고, next_hypotheses는 재저장 없이 기존(예전) 캐시가 응답에 그대로 노출된다
    (#1863 data-loss 방지 원칙 연장 — 방금 실패한 L3로 예전 good 캐시를 지우지 않음)."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        synthesis_result = {
            "learned": [{"text": "새 종합", "source": "s"}],
            "generated_at": "2026-07-04T00:00:00+00:00", "source": "ai_draft",
        }
        stale_candidates = [{
            "id": str(uuid.uuid4()), "statement": "예전 추천(재생성 실패로 그대로 유지됨)",
            "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
            "measure_after": "2026-08-01T00:00:00+00:00", "confidence": 0.5,
            "rationale": "r", "requires_confirmation": True,
        }]
        after_l2 = _mock_session()
        after_l2.synthesis = synthesis_result
        after_l2.next_hypotheses = stale_candidates  # L3 미실행이라 재저장 없이 예전 값 그대로

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.routers.retros.synth_svc.synthesize", new=AsyncMock(return_value=synthesis_result)),
            patch("app.routers.retros.synth_svc.recommend_next", new=AsyncMock(return_value=None)),
            patch(
                "app.repositories.base.BaseRepository.update",
                new=AsyncMock(return_value=after_l2),
            ) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/synthesis")

        assert resp.status_code == 200
        body = resp.json()
        assert body["synthesis"]["learned"][0]["text"] == "새 종합"
        assert body["next_hypotheses"][0]["statement"] == "예전 추천(재생성 실패로 그대로 유지됨)"
        # L3 실패 시 next_hypotheses에 대한 repo.update 재호출이 없어야 함(synthesis만 1회).
        mock_update.assert_awaited_once_with(SESSION_ID, synthesis=synthesis_result)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_session_embeds_hypotheses_when_sprint_linked():
    """§5 hypotheses[] — sprint_id 있으면 story 1 필터 재사용해 채움."""
    client, session, app = await _client()
    try:
        s = _mock_session()
        s.sprint_id = uuid.uuid4()
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = s
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        hyp = SimpleNamespace(
            id=uuid.uuid4(), statement="stmt", status="verified",
            metric_definition={"metric": "x", "target": 1, "direction": "up"},
            outcome_result={"actual": 2},
        )

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])),
        ):
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["hypotheses"]) == 1
        assert body["hypotheses"][0]["statement"] == "stmt"
        assert body["hypotheses"][0]["actual"] == 2
        assert body["synthesis"] is None
        assert body["next_hypotheses"] is None
    finally:
        app.dependency_overrides.clear()


# ── ecc531ce: 다음가설 채택→시드 ─────────────────────────────────────────────

CANDIDATE_ID = uuid.uuid4()


def _candidate(**overrides) -> dict:
    base = {
        "id": str(CANDIDATE_ID), "statement": "다음엔 온보딩을 개선하면 이탈이 줄 것이다.",
        "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
        "measure_after": "2026-08-01T00:00:00+00:00", "confidence": 0.5,
        "rationale": "r", "requires_confirmation": True, "adopted_hypothesis_id": None,
    }
    base.update(overrides)
    return base


def _mock_session_with_candidate(candidate_overrides=None, project_id=PROJECT_ID) -> MagicMock:
    s = _mock_session(project_id=project_id)
    s.next_hypotheses = [_candidate(**(candidate_overrides or {}))]
    return s


@pytest.mark.anyio
async def test_adopt_requires_human_403():
    """SOUL-LOCK "채택=인간 게이트" — agent caller는 403."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access(), _mock_resolve_member(member_type="agent"):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": str(CANDIDATE_ID)})

        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "ADOPTION_REQUIRES_HUMAN"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_cross_project_403():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": str(CANDIDATE_ID)})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_candidate_not_found_404():
    client, session, app = await _client()
    try:
        s = _mock_session()
        s.next_hypotheses = []
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = s
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.repositories.retro.RetroSessionRepository.get_for_update", new=AsyncMock(return_value=s)),
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": str(CANDIDATE_ID)})

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "CANDIDATE_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_already_adopted_409():
    """PO 결(2026-07-03) — 재채택은 fail-closed 409(house style)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        locked = _mock_session_with_candidate({"adopted_hypothesis_id": str(uuid.uuid4())})

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.repositories.retro.RetroSessionRepository.get_for_update", new=AsyncMock(return_value=locked)),
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": str(CANDIDATE_ID)})

        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "ALREADY_ADOPTED"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_200_creates_hypothesis_and_seeds_next_sprint():
    client, session, app = await _client()
    try:
        s = _mock_session()
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = s
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        locked = _mock_session_with_candidate()
        hyp_id = uuid.uuid4()
        hyp = SimpleNamespace(id=hyp_id, project_id=PROJECT_ID)
        next_sprint = SimpleNamespace(id=uuid.uuid4())
        updated_session = _mock_session()
        updated_session.next_hypotheses = [_candidate(adopted_hypothesis_id=str(hyp_id))]

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.repositories.retro.RetroSessionRepository.get_for_update", new=AsyncMock(return_value=locked)),
            patch("app.routers.retros.hyp_svc.create_hypothesis", new=AsyncMock(return_value=hyp)) as mock_create,
            patch("app.routers.retros.seed_svc.resolve_next_sprint", new=AsyncMock(return_value=next_sprint)),
            patch("app.routers.retros.hyp_svc.link_hypothesis", new=AsyncMock()) as mock_link,
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock(return_value=updated_session)) as mock_update,
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": str(CANDIDATE_ID)})

        assert resp.status_code == 200
        mock_create.assert_awaited_once()
        mock_link.assert_awaited_once()
        link_args = mock_link.await_args.args
        assert link_args[2] == hyp_id
        assert link_args[3].sprint_id == next_sprint.id
        assert link_args[3].link_type == "seeded"
        mock_update.assert_awaited_once()
        assert resp.json()["next_hypotheses"][0]["adopted_hypothesis_id"] == str(hyp_id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_honors_human_edited_statement():
    """story 4b87d3a6 — sprint-close-cockpit의 OperatorTextarea로 사람이 편집한 statement가
    body에 실려오면 그걸 써야 한다(HITL "확정은 당신이" — 이전엔 body를 아예 안 읽고 서버
    저장 candidate의 statement만 써 사람 편집이 조용히 버려졌음)."""
    client, session, app = await _client()
    try:
        s = _mock_session()
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = s
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        locked = _mock_session_with_candidate()  # statement="다음엔 온보딩을 개선하면 이탈이 줄 것이다."
        hyp_id = uuid.uuid4()
        hyp = SimpleNamespace(id=hyp_id, project_id=PROJECT_ID)
        updated_session = _mock_session()
        updated_session.next_hypotheses = [_candidate(adopted_hypothesis_id=str(hyp_id))]

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.repositories.retro.RetroSessionRepository.get_for_update", new=AsyncMock(return_value=locked)),
            patch("app.routers.retros.hyp_svc.create_hypothesis", new=AsyncMock(return_value=hyp)) as mock_create,
            patch("app.routers.retros.seed_svc.resolve_next_sprint", new=AsyncMock(return_value=None)),
            patch("app.routers.retros.hyp_svc.link_hypothesis", new=AsyncMock()),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock(return_value=updated_session)),
        ):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt",
                    json={"id": str(CANDIDATE_ID), "statement": "사람이 직접 편집한 문구"},
                )

        assert resp.status_code == 200
        mock_create.assert_awaited_once()
        payload = mock_create.await_args.args[3]
        assert payload.statement == "사람이 직접 편집한 문구"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_blank_statement_override_falls_back_to_stored():
    """body.statement가 공백뿐이면(사람이 지웠다가 빈칸으로 제출) 서버 저장값으로 폴백 —
    빈 statement 가설이 만들어지지 않도록."""
    client, session, app = await _client()
    try:
        s = _mock_session()
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = s
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        locked = _mock_session_with_candidate()
        hyp_id = uuid.uuid4()
        hyp = SimpleNamespace(id=hyp_id, project_id=PROJECT_ID)
        updated_session = _mock_session()
        updated_session.next_hypotheses = [_candidate(adopted_hypothesis_id=str(hyp_id))]

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.repositories.retro.RetroSessionRepository.get_for_update", new=AsyncMock(return_value=locked)),
            patch("app.routers.retros.hyp_svc.create_hypothesis", new=AsyncMock(return_value=hyp)) as mock_create,
            patch("app.routers.retros.seed_svc.resolve_next_sprint", new=AsyncMock(return_value=None)),
            patch("app.routers.retros.hyp_svc.link_hypothesis", new=AsyncMock()),
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock(return_value=updated_session)),
        ):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt",
                    json={"id": str(CANDIDATE_ID), "statement": "   "},
                )

        assert resp.status_code == 200
        payload = mock_create.await_args.args[3]
        assert payload.statement == "다음엔 온보딩을 개선하면 이탈이 줄 것이다."
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_missing_id_returns_422():
    """PO crux(2026-07-04) — body.id 부재/malformed는 graceful 422(암묵계약 drift 대비).
    project-access/human 게이트보다 먼저 Pydantic 검증이 걸려야 하므로 mock 없이도 422."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={})
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_malformed_id_returns_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post(
                f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": "not-a-uuid"}
            )
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_adopt_no_next_sprint_skips_link_backlog_proposed():
    """AC #2 — 다음 sprint 없으면 backlog proposed(링크 자체를 생략)."""
    client, session, app = await _client()
    try:
        s = _mock_session()
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = s
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        locked = _mock_session_with_candidate()
        hyp_id = uuid.uuid4()
        hyp = SimpleNamespace(id=hyp_id, project_id=PROJECT_ID)
        updated_session = _mock_session()
        updated_session.next_hypotheses = [_candidate(adopted_hypothesis_id=str(hyp_id))]

        with (
            _allow_project_access(), _mock_resolve_member(),
            patch("app.repositories.retro.RetroSessionRepository.get_for_update", new=AsyncMock(return_value=locked)),
            patch("app.routers.retros.hyp_svc.create_hypothesis", new=AsyncMock(return_value=hyp)),
            patch("app.routers.retros.seed_svc.resolve_next_sprint", new=AsyncMock(return_value=None)),
            patch("app.routers.retros.hyp_svc.link_hypothesis", new=AsyncMock()) as mock_link,
            patch("app.repositories.base.BaseRepository.update", new=AsyncMock(return_value=updated_session)),
        ):
            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/next-hypotheses/adopt", json={"id": str(CANDIDATE_ID)})

        assert resp.status_code == 200
        mock_link.assert_not_called()
    finally:
        app.dependency_overrides.clear()
