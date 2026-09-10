"""story #3766(별건 ⑩·성과 보드, 3746 §3 유나 定) — 「사람 차례」 발행 명령 축.
insights_board 행에 그 발행물(gate)의 최신 PublicationCommand.status를 조인 1필드로
싣는다(channel_posts.py::_channel_post_to_list_item의 gate당 최신 명령 패턴과 동형 —
gate_id IN (...) 배치 조회 후 created_at DESC로 gate당 첫 행만 남긴다).

세팅 헬퍼는 test_3502_insights_board.py 재사용(중복 재발명 금지) — 이 파일 전용
(PublicationCommand 시딩)만 새로 추가한다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3471_org_content_rules_lint import _seed_human, _seed_org, _seed_story, _session_factory
from tests.test_3502_insights_board import _seed_channel_publication, _seed_gate, _seed_site_post

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_command(
    session, *, org_id, gate_id, requested_by_member_id, status="pending",
    created_at=None, destination=None, approved_version=None,
):
    from app.models.publication_command import PublicationCommand

    cmd = PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id,
        destination=destination or uuid.uuid4(), approved_version=approved_version or uuid.uuid4(),
        operation="publish", content_kind="channel_post", status=status,
        attempt_count=0, requested_by_member_id=requested_by_member_id,
    )
    session.add(cmd)
    await session.commit()
    if created_at is not None:
        # created_at은 모델 server_default(now())라 시딩 시점 순서를 뒤집을 방법이
        # INSERT 인자로는 없다 — "gate당 최신"(created_at DESC) 판정을 테스트하려면
        # 커밋 뒤 UPDATE로 시각을 직접 되돌린다(다른 시딩 헬퍼들과 달리 이 필드만
        # 예외 — 서버 시각을 테스트가 통제할 유일한 길).
        from sqlalchemy import update

        await session.execute(
            update(PublicationCommand).where(PublicationCommand.id == cmd.id).values(created_at=created_at)
        )
        await session.commit()
    return cmd


@pytest.mark.anyio
async def test_dead_letter_command_status_joins_onto_row():
    """AC1 — dead_letter 발행 명령이 있으면 그 행의 command_status가 "dead_letter"."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            now = datetime.now(timezone.utc)

            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )
            await _seed_command(s, org_id=org_id, gate_id=gate.id, requested_by_member_id=human_id, status="dead_letter")

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == cp.id)
        assert row["command_status"] == "dead_letter"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_blocked_command_status_joins_onto_row():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            now = datetime.now(timezone.utc)

            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )
            await _seed_command(s, org_id=org_id, gate_id=gate.id, requested_by_member_id=human_id, status="blocked")

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == cp.id)
        assert row["command_status"] == "blocked"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_command_for_gate_leaves_command_status_none():
    """뮤테이션 대조 짝 — 명령 자체가 없는(정상 발행, 재시도/차단 이력 0) 행은 None.
    이 케이스가 없으면 "항상 뭔가 채워진다"는 거짓양성을 위 두 테스트가 못 잡는다."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == cp.id)
        assert row["command_status"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_row_command_status_always_none():
    """site_post_arm은 Gate를 아예 조인하지 않는다(그라운딩) — gate_id가 항상 null이라
    command_status도 구조적으로 항상 None이다(site_post는 이 스토리 스코프 밖)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-none", title="글",
                published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == sp.id)
        assert row["command_status"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_latest_command_by_created_at_wins_when_gate_has_multiple_commands():
    """AC1 뮤테이션 표적 — 한 gate에 명령이 여러 번(예: 실패 뒤 수동 재시도로 새 명령)
    쌓이면 created_at이 더 최신인 쪽 status가 이긴다(channel_posts.py 관례와 동형).
    이 테스트가 없으면 "아무 명령이나 하나 조인"으로 구현이 퇴화해도 위 단일-명령
    테스트들은 계속 그린이라 못 잡는다."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            now = datetime.now(timezone.utc)

            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )
            # 옛 명령(실패로 dead_letter) → 그 뒤 사람이 재시도해 새 명령(pending)을 냄.
            await _seed_command(
                s, org_id=org_id, gate_id=gate.id, requested_by_member_id=human_id, status="dead_letter",
                created_at=now - timedelta(hours=2),
            )
            await _seed_command(
                s, org_id=org_id, gate_id=gate.id, requested_by_member_id=human_id, status="pending",
                created_at=now - timedelta(minutes=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == cp.id)
        assert row["command_status"] == "pending", "더 최신(created_at) 명령이 이겨야 하는데 옛 dead_letter가 남았다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_status_filter_axis_stays_separate_from_command_status():
    """AC「필터에 command 값 넣으면 422/무시」 — `status` 쿼리 파라미터는 InsightSnapshot.
    status(수집 상태 축)만 본다. command_status류 값("dead_letter")을 넣어도 그 값을
    가진 스냅샷이 애초에 없으니(다른 테이블·다른 값 집합) 조용히 0건을 낸다 — 두 축이
    섞여 command_status=dead_letter인 행이 엉뚱하게 걸리면(교차 오염) 이 테스트가 RED."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            now = datetime.now(timezone.utc)

            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )
            await _seed_command(s, org_id=org_id, gate_id=gate.id, requested_by_member_id=human_id, status="dead_letter")

            result = await list_insights_board(s, org_id=org_id, window="30d", status="dead_letter")
        assert result["rows"] == [], (
            "status='dead_letter'가 InsightSnapshot 축이 아니라 command_status 축에 "
            "잘못 걸리면(교차 오염) 이 행이 여기 섞여 든다 — 두 축은 분리돼야 한다"
        )
    finally:
        await engine.dispose()
