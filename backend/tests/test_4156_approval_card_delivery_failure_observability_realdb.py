"""story #4156(E-RECIPE-1·Phase 3 폴리시, 페드루 PO 確定 2026-09-22) — #4153이 닫은
것은 승인 카드 배달 실패의 FK 위반 1종(승인자 members 앵커 부재)뿐이다.
`dispatch_approval_request_cards`의 per-approver `except Exception`(approval_
delivery.py) 자체는 그 FK 종류를 포함해 어떤 배달 실패든 지금까지 WARNING 한 줄로
삼켰다 — 게이트는 생기고 승인자에게 카드는 안 갔는데 아무 데도 안 남았다.

## AC4 그라운딩 — 배달 실패 종류별 관측 여부
per-approver try 블록이 `_get_or_create_approval_dm`부터 `_dispatch_conversation_event`
까지 통째로 감싸므로(approval_delivery.py:206-320), 그 구간 안에서 나는 **모든**
`Exception` 서브클래스가 이 카드의 처방(ERROR 로그+activity_logs 기록)으로 관측된다 —
아래 표는 "닫힌 코드/발명 0" 원칙상 특정 예외 타입별로 다른 처리를 새로 만들지 않고
`except Exception` 단일 축으로 전부 커버함을 실측으로 고정한다.

| 실패 종류 | 발생 위치 | 이 카드로 관측? |
|---|---|---|
| FK 위반(member_id not in team_members) | `_get_or_create_approval_dm`→INSERT | ✅ (본 파일 `test_fk_violation_...`) |
| 대화 생성 실패(예: dm_pair_key UNIQUE 경합) | `_get_or_create_approval_dm` | ✅ (같은 except 축 — IntegrityError도 Exception) |
| 권한/제약(예: `msg_metadata` 스키마 CHECK 위반) | `ConversationMessage` INSERT | ✅ (같은 except 축) |
| DB 일시 오류(커넥션 드롭 등) | try 블록 어디서든 | ✅ (같은 except 축 — 메시지 전송 큐잉 실패도 동일) |

FK 위반 외 종류는 실 DB 레벨에서 결정적으로 재현하기 어려워(레이스·네트워크 의존) 이
파일은 FK 위반 1종만 실측 주입하고, 위 표의 "동일 except 축" 논거로 나머지 종류의
관측 여부를 코드 구조(단일 `except Exception` 블록)로 고정한다."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="realdb 테스트는 실 Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4156", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, name="requester"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human",
        name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_doc(session, org_id, project_id, *, title="설계 문서"):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        content="본문", status="pending", slug=f"doc-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.commit()
    return doc


async def _delivery_failure_logs(session, *, org_id, gate_id):
    from app.models.activity_log import ActivityLog
    from sqlalchemy import select

    return (await session.execute(
        select(ActivityLog).where(
            ActivityLog.org_id == org_id,
            ActivityLog.entity_type == "gate",
            ActivityLog.entity_id == gate_id,
            ActivityLog.action == "approval_card_delivery_failed",
        )
    )).scalars().all()


@pytest.mark.anyio
async def test_fk_violation_delivery_failure_is_observed_error_log_and_activity_row(caplog):
    """⭐AC1 핵심 — FK 위반(test_2604의 nonexistent_approver 관례 재사용, 신규 실패유도
    메커니즘 발명 0)이 나면 ERROR 로그 1 + activity_logs에 닫힌 코드
    (action="approval_card_delivery_failed") 행이 남는다."""
    import logging

    from app.services.approval_delivery import dispatch_approval_request_cards, logger as _logger

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="4156a")
            requester_id = await _seed_human(s, org_id, project_id)
            doc = await _seed_doc(s, org_id, project_id)
            nonexistent_approver = uuid.uuid4()
            gate_id = uuid.uuid4()

            with caplog.at_level(logging.ERROR, logger=_logger.name):
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                    project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                    gate_type="doc_approval",
                    requester_id=requester_id, approver_ids=[nonexistent_approver],
                )
            await s.commit()

            error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
            assert any("카드 배달 실패" in r.message for r in error_records), (
                f"ERROR 로그가 안 남: {[r.message for r in caplog.records]}"
            )

            logs = await _delivery_failure_logs(s, org_id=org_id, gate_id=gate_id)
            assert len(logs) == 1, f"activity_logs 행이 정확히 1개여야: {logs}"
            assert logs[0].actor_type == "platform"
            assert logs[0].context["approver_id"] == str(nonexistent_approver)
            assert logs[0].context["exception_type"]  # 닫힌 코드 — 지어내지 않는다, 실측값 존재만 확인
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_successful_delivery_does_not_create_failure_activity_row():
    """회귀 0 — 정상 배달(앵커된 human approver)은 activity_logs에 실패 행을 안 남긴다
    (과잉 기록 방지, 성공 케이스가 시끄러워지면 안 된다)."""
    from app.services.approval_delivery import dispatch_approval_request_cards

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="4156b")
            requester_id = await _seed_human(s, org_id, project_id)
            good_approver = await _seed_human(s, org_id, project_id, name="approver")
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                gate_type="doc_approval",
                requester_id=requester_id, approver_ids=[good_approver],
            )
            await s.commit()

            logs = await _delivery_failure_logs(s, org_id=org_id, gate_id=gate_id)
            assert logs == [], f"정상 배달인데 실패 기록이 남음: {logs}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_still_succeeds_when_card_delivery_fails():
    """AC2 — 카드 배달 실패가 발행(호출부 트랜잭션) 자체를 되돌리지 않는다. dispatch_
    approval_request_cards는 예외를 밖으로 던지지 않고(best-effort) 정상 반환하며,
    호출부의 후속 write(여기서는 s.commit() 자체)가 그대로 성공해야 한다 — test_2604의
    poison-방지 검증과 같은 축, 이 카드에서는 "발행 성공 유지"의 직접 증거로 재확인."""
    from app.services.approval_delivery import dispatch_approval_request_cards

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="4156c")
            requester_id = await _seed_human(s, org_id, project_id)
            doc = await _seed_doc(s, org_id, project_id)
            nonexistent_approver = uuid.uuid4()
            gate_id = uuid.uuid4()

            # 예외가 밖으로 새면 이 await 자체가 여기서 실패한다 — 새지 않음이 AC2의 증거.
            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                gate_type="doc_approval",
                requester_id=requester_id, approver_ids=[nonexistent_approver],
            )
            # 세션이 poison 안 됐음을 후속 write로 확인(#4156이 추가한 activity_log 기록
            # 자체가 실 INSERT이므로, 이미 위 호출 안에서 한 번 증명됐다 — 여기서는 호출부
            # 관점의 커밋까지 한 번 더 실측).
            await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delivery_and_activity_log_both_fail_gate_creation_still_commits(caplog, monkeypatch):
    """⭐PR#4527 CHANGES-1(까디르 QA 지적, 페드루 PO 確定 2026-09-22) — 배달 자체 실패
    (FK 위반) **+** activity_log 기록까지 실패(SAVEPOINT 안에서 진짜 DB 예외, `SELECT
    1/0`)가 겹쳐도, 바깥(게이트 생성) 트랜잭션의 commit은 그대로 성공하고 「기록도
    실패」 WARNING만 남는다. 처방 前에는 `ActivityLogService.record()`의 내부
    `flush()`가 SAVEPOINT 밖에서 실패해 커넥션이 aborted 상태로 남아 이 s.commit()
    자체가 깨졌다(신규 리스크 — 이 PR이 새로 만든 코드 경로)."""
    import logging

    import app.services.activity_log as activity_log_module
    from sqlalchemy import text

    from app.services.approval_delivery import dispatch_approval_request_cards, logger as _logger

    original_record = activity_log_module.ActivityLogService.record

    async def _record_hits_real_db_error(self, **kwargs):
        await self._db.execute(text("SELECT 1/0"))
        return await original_record(self, **kwargs)  # pragma: no cover — 위에서 항상 먼저 raise

    monkeypatch.setattr(activity_log_module.ActivityLogService, "record", _record_hits_real_db_error)

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="4156d")
            requester_id = await _seed_human(s, org_id, project_id)
            doc = await _seed_doc(s, org_id, project_id)
            nonexistent_approver = uuid.uuid4()
            gate_id = uuid.uuid4()

            with caplog.at_level(logging.WARNING, logger=_logger.name):
                # 배달(FK 위반) + 기록(SELECT 1/0)이 둘 다 실패해도 이 await 자체는
                # 새지 않아야 한다(best-effort 계약 — AC2가 이 겹침에서도 유지됨).
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                    project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                    gate_type="doc_approval",
                    requester_id=requester_id, approver_ids=[nonexistent_approver],
                )
            # ⚠️PostgreSQL은 aborted 트랜잭션에 COMMIT을 보내면 예외 없이 **조용히
            # ROLLBACK**한다(클라이언트에 에러가 안 보인다) — 이 세션에 새로 flush할
            # 게 없는 채로 그냥 commit만 하면 "커밋이 안 터졌다"가 "실제로 커밋됐다"의
            # 증거가 못 된다(처방 前 코드로 최초 작성했을 때 이 구멍으로 뮤테이션이
            # 안 죽는 걸 실측으로 발견). 호출부(예: gates.py)가 게이트 생성 자체를
            # 같은 트랜잭션에서 하는 것과 동형으로, 여기서도 새 행 하나를 심어 그
            # INSERT가 flush 시점에 실제로 시도되게 한다 — aborted 상태였다면 바로
            # 이 지점에서 InFailedSQLTransactionError가 터진다(test_2604의 Sentinel
            # 기법과 동형, 발명 0).
            from app.models.organization import Organization

            sentinel_org_id = uuid.uuid4()
            s.add(Organization(id=sentinel_org_id, name="Sentinel4527c1", slug=f"sentinel-{uuid.uuid4().hex[:8]}"))
            await s.commit()

            warning_records = [r for r in caplog.records if r.levelno >= logging.WARNING]
            assert any("activity_log 기록도 실패" in r.message for r in warning_records), (
                f"기록 실패 WARNING이 안 남: {[r.message for r in caplog.records]}"
            )
            # 기록 자체가 실패했으니 activity_logs 행은 안 남는다(정직 — 지어내지 않는다).
            logs = await _delivery_failure_logs(s, org_id=org_id, gate_id=gate_id)
            assert logs == [], f"기록이 실패했는데 행이 남음(SAVEPOINT 롤백 미작동): {logs}"

        # 같은 세션이 아니라 fresh 세션으로 재조회 — commit이 "조용한 rollback"이
        # 아니라 진짜 커밋이었는지 끝단(#4156 세션의 «끝단 영속검증» 관례)까지 확인.
        from app.models.organization import Organization as OrgModel
        from sqlalchemy import select as sa_select

        async with Session() as s2:
            still_there = (await s2.execute(
                sa_select(OrgModel.id).where(OrgModel.id == sentinel_org_id)
            )).scalar_one_or_none()
            assert still_there is not None, (
                "sentinel org가 fresh 세션에서 안 보임 — commit이 실제로는 조용한 rollback이었을 수 있음"
            )
    finally:
        await engine.dispose()
