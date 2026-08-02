"""story #2414 + #2413 AC3(PO 지시, 2026-08-02) — "빈 값" 판정을 서버가 거부하는지 고정한다.

#2414: 스탠드업 done·plan·blockers가 «전부» 빈 경우만 거부(한두 칸만 빈 것은 정상 — 실측
122건 중 73건이 "done만 빔" 모양이었다. 이걸 막으면 과잉차단이다).
#2413 AC3: 회고 세션·스프린트 title이 빈 경우 거부.

공용 축(is_blank/reject_if_all_blank, app/schemas/validators.py) — ""·공백만·"\n"만·None
넷 다 blank로 본다. 이 정의가 갈리면 한쪽은 막고 한쪽은 통과하는 재발 축이 된다.
"""
from __future__ import annotations

import uuid
from datetime import date as _date
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.schemas.validators import is_blank, reject_if_all_blank


# ─── 공용 blank 판정 축 ───────────────────────────────────────────────────────

class TestIsBlank:
    @pytest.mark.parametrize("value", [None, "", "   ", "\n", "\n\t "])
    def test_blank_values(self, value):
        assert is_blank(value) is True

    @pytest.mark.parametrize("value", ["a", " a ", "\n일함\n", "0"])
    def test_non_blank_values(self, value):
        assert is_blank(value) is False


class TestRejectIfAllBlank:
    def test_all_blank_raises_with_actionable_message(self):
        with pytest.raises(ValueError, match="done·plan·blockers 중 최소 하나는 채워야 합니다"):
            reject_if_all_blank(done=None, plan="", blockers="   ")

    def test_one_filled_passes(self):
        reject_if_all_blank(done="did stuff", plan=None, blockers="")  # no raise

    def test_all_filled_passes(self):
        reject_if_all_blank(done="d", plan="p", blockers="b")  # no raise


# ─── #2414: StandupUpsert/StandupSelfUpdate ─────────────────────────────────

class TestStandupBlankReject:
    def test_all_three_blank_rejected(self):
        from app.schemas.standup import StandupUpsert
        with pytest.raises(ValidationError, match="done·plan·blockers 중 최소 하나는 채워야 합니다"):
            StandupUpsert(author_id=uuid.uuid4(), date=_date(2026, 8, 2))

    def test_all_three_whitespace_only_rejected(self):
        # story #2414 공용축 — ""뿐 아니라 공백/개행만 있는 것도 blank.
        from app.schemas.standup import StandupUpsert
        with pytest.raises(ValidationError):
            StandupUpsert(
                author_id=uuid.uuid4(), date=_date(2026, 8, 2),
                done=" ", plan="\n", blockers="   \n  ",
            )

    def test_done_only_filled_passes(self):
        # ⭐음성대조 — 실측 122건 중 73건이 이 모양(오늘 시작한 사람, done만 빔이 아니라
        # plan/blockers만 빔인 경우도 포함해 "한두 칸만 빈 것"은 전부 정상 취급돼야 한다).
        from app.schemas.standup import StandupUpsert
        u = StandupUpsert(author_id=uuid.uuid4(), date=_date(2026, 8, 2), done="어제 한 일")
        assert u.done == "어제 한 일"

    def test_normal_standup_passes(self):
        from app.schemas.standup import StandupUpsert
        u = StandupUpsert(
            author_id=uuid.uuid4(), date=_date(2026, 8, 2),
            done="a", plan="b", blockers="c",
        )
        assert (u.done, u.plan, u.blockers) == ("a", "b", "c")

    def test_self_update_same_rule(self):
        from app.schemas.standup import StandupSelfUpdate
        with pytest.raises(ValidationError):
            StandupSelfUpdate(date=_date(2026, 8, 2))
        s = StandupSelfUpdate(date=_date(2026, 8, 2), blockers="막힘")
        assert s.blockers == "막힘"


# ─── #2413 AC3: 회고 세션 title ──────────────────────────────────────────────

class TestRetroTitleBlankReject:
    def test_create_session_blank_title_rejected(self):
        from app.schemas.retro import CreateSession
        with pytest.raises(ValidationError, match="title은 비어 있을 수 없습니다"):
            CreateSession(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="")

    def test_create_session_whitespace_title_rejected(self):
        from app.schemas.retro import CreateSession
        with pytest.raises(ValidationError):
            CreateSession(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="   ")

    def test_create_session_real_title_passes(self):
        from app.schemas.retro import CreateSession
        s = CreateSession(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="Sprint 14 회고")
        assert s.title == "Sprint 14 회고"

    def test_get_or_create_by_sprint_omitted_title_passes(self):
        # None(생략) = 라우터가 자동 제목을 붙이는 경로 — 이 가드가 막지 않는다.
        from app.schemas.retro import GetOrCreateBySprint
        g = GetOrCreateBySprint(sprint_id=uuid.uuid4())
        assert g.title is None

    def test_get_or_create_by_sprint_explicit_blank_rejected(self):
        from app.schemas.retro import GetOrCreateBySprint
        with pytest.raises(ValidationError):
            GetOrCreateBySprint(sprint_id=uuid.uuid4(), title="")

    def test_get_or_create_by_sprint_real_title_passes(self):
        from app.schemas.retro import GetOrCreateBySprint
        g = GetOrCreateBySprint(sprint_id=uuid.uuid4(), title="수동 제목")
        assert g.title == "수동 제목"


# ─── #2413 AC3: 스프린트 title ───────────────────────────────────────────────

class TestSprintTitleBlankReject:
    def test_sprint_create_blank_title_rejected(self):
        from app.schemas.sprint import SprintCreate
        with pytest.raises(ValidationError, match="title은 비어 있을 수 없습니다"):
            SprintCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="")

    def test_sprint_create_whitespace_title_rejected(self):
        from app.schemas.sprint import SprintCreate
        with pytest.raises(ValidationError):
            SprintCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="\n")

    def test_sprint_create_real_title_passes(self):
        from app.schemas.sprint import SprintCreate
        s = SprintCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="Sprint 14")
        assert s.title == "Sprint 14"

    def test_sprint_update_omitted_title_passes(self):
        from app.schemas.sprint import SprintUpdate
        u = SprintUpdate(velocity=10)
        assert u.title is None

    def test_sprint_update_explicit_blank_rejected(self):
        from app.schemas.sprint import SprintUpdate
        with pytest.raises(ValidationError):
            SprintUpdate(title="   ")

    def test_sprint_update_real_title_passes(self):
        from app.schemas.sprint import SprintUpdate
        u = SprintUpdate(title="새 제목")
        assert u.title == "새 제목"


# ─── #2414 AC4: HTTP 레벨 검산 — 422를 실제로 받는지, 정상 값은 그대로 저장되는지 ──────────

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AUTHOR_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _standup_client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(AUTHOR_ID)
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
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.mark.anyio
async def test_post_standup_all_blank_returns_422_with_actionable_message():
    client, app = await _standup_client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/standups", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(ORG_ID),
                "author_id": str(AUTHOR_ID),
                "date": "2026-08-02",
                # ⛔done/plan/blockers 전부 생략(=None) — story #2414의 실측 결함 그대로 재현.
            })
        assert resp.status_code == 422
        assert "done·plan·blockers 중 최소 하나는 채워야 합니다" in resp.text
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_post_standup_normal_content_still_saves():
    """⭐양성대조 — 막는 규칙이 정상 값까지 잡아먹지 않는지(AC4)."""
    from app.services.member_resolver import ResolvedMember
    from unittest.mock import patch
    from datetime import date, datetime, timezone

    client, app = await _standup_client()
    try:
        entry = MagicMock()
        entry.id = uuid.uuid4()
        entry.org_id = ORG_ID
        entry.project_id = PROJECT_ID
        entry.sprint_id = None
        entry.author_id = AUTHOR_ID
        entry.date = date(2026, 8, 2)
        entry.done = "어제 한 일"
        entry.plan = None
        entry.blockers = None
        entry.plan_story_ids = []
        entry.created_at = datetime(2026, 8, 2, tzinfo=timezone.utc)
        entry.updated_at = datetime(2026, 8, 2, tzinfo=timezone.utc)
        member = ResolvedMember(
            id=AUTHOR_ID, user_id=AUTHOR_ID, name="h", type="human", role="member", org_id=ORG_ID,
        )
        with patch("app.repositories.standup.StandupEntryRepository.upsert", new_callable=AsyncMock) as mock_upsert, \
             patch("app.routers.standups.resolve_member", new=AsyncMock(return_value=member)):
            mock_upsert.return_value = entry
            async with client as c:
                resp = await c.post("/api/v2/standups", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "author_id": str(AUTHOR_ID),
                    "date": "2026-08-02",
                    "done": "어제 한 일",  # done만 채움 — 73/122건이 이 모양이었다(정상).
                })
        assert resp.status_code == 201
        assert resp.json()["done"] == "어제 한 일"
    finally:
        app.dependency_overrides.clear()
