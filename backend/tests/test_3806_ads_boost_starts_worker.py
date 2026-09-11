"""story #3806(Phase3·3-2 PR 6, 페드루 PO 確定 2026-09-11 13:27Z) — 봉인
`sealed_ads_starts_at` 자동 실행 워커(`process_due_ads_boost_starts`). AC2
"[제품] 상한 내 실행"의 원래 뜻(승인 뒤 시작 시점 도달 시 제품이 자동으로
`request_ads_boost_start`를 부름)을 채운다 — PR5의 「홍보 시작」 사람 클릭은
지름길로 유지되고(먼저 된 쪽이 이김), 이 워커는 "안 눌렀을 때의 안전망".

세팅은 test_3806_ads_boost_gate.py(PR 2)·test_3806_ads_boost_execution.py(PR 3)
와 동형 재사용(중복 재발명 금지) — `_setup_approved_gate`는 starts_at을 항상
미래(+1h)로 고정해 둬(그 파일의 관심사가 아님) 이 파일은 `hours_from_now`를
과거로 넘기는 자체 세팅 함수를 둔다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory, _seed_default_role
from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3806_ads_boost_gate import _seed_publication, _boost_body, _approve_gate

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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _setup_gate(session_factory_result, *, hours_from_now: float, approve: bool = True):
    """test_3806_ads_boost_execution.py::_setup_approved_gate와 동형이나
    `hours_from_now`를 그대로 `_boost_body`에 흘려 starts_at을 과거/미래로 고른다."""
    from app.main import app

    engine, Session = session_factory_result
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")
        conn = await _seed_channel_connection(s, org_id, channel="threads")
        ad_conn = await _seed_channel_connection(s, org_id, channel="ads_sandbox")
        await _seed_default_role(s, org_id)
        pub, _ = await _seed_publication(s, org_id=org_id, connection_id=conn.id)

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
            json=_boost_body(ad_connection_id=ad_conn.id, hours_from_now=hours_from_now),
        )
    assert r.status_code == 201, r.text
    gate_id = uuid.UUID(r.json()["gate_id"])
    app.dependency_overrides.clear()

    if approve:
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)

    return engine, Session, org_id, owner_id, gate_id


async def _get_boost_start_command(session, org_id: uuid.UUID, gate_id: uuid.UUID):
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    return (await session.execute(
        select(PublicationCommand).where(
            PublicationCommand.org_id == org_id, PublicationCommand.gate_id == gate_id,
            PublicationCommand.operation == "boost_start",
        )
    )).scalar_one_or_none()


@pytest.mark.anyio
async def test_due_approved_gate_gets_boost_start_command():
    from app.services.ads_boost_execution import process_due_ads_boost_starts

    engine, Session, org_id, owner_id, gate_id = await _setup_gate(
        await _session_factory(), hours_from_now=-1,  # 1시간 前 — 이미 도래
    )
    try:
        async with Session() as s:
            counts = await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))
        assert counts["started"] == 1, counts

        async with Session() as s:
            command = await _get_boost_start_command(s, org_id, gate_id)
        assert command is not None
        assert command.requested_by_member_id == owner_id  # gate.resolver_id 귀속
        # story #3806 PR 6 정정(페드루 PO 定 2026-09-11 13:42Z) — 「누가 시작했나」
        # 두 세계 처방. 뮤테이션 대상: process_due_ads_boost_starts의
        # request_ads_boost_start 호출에서 initiated_by="scheduler"를 걷으면(또는
        # publication_command.py::create_or_get_publication_command가 그 값을
        # 안 저장하면) 이 단언이 실패한다.
        assert command.initiated_by == "scheduler"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_triggered_start_is_marked_initiated_by_human():
    """뮤테이션 대상: `start_ads_boost_endpoint`(사람 경로)가 initiated_by="human"을
    안 넘기면 이 단언이 실패한다 — 워커 경로(scheduler)와의 구분이 이 값 하나에
    달려 있다."""
    from app.main import app

    engine, Session, org_id, owner_id, gate_id = await _setup_gate(
        await _session_factory(), hours_from_now=1, approve=True,
    )
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        assert r.status_code == 201, r.text
        app.dependency_overrides.clear()

        async with Session() as s:
            command = await _get_boost_start_command(s, org_id, gate_id)
        assert command is not None
        assert command.initiated_by == "human"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_not_yet_due_gate_is_skipped():
    """뮤테이션 대상: `Gate.sealed_ads_starts_at <= now` 조건을 걷으면 미래 gate도
    잡혀 이 테스트가 실패한다."""
    from app.services.ads_boost_execution import process_due_ads_boost_starts

    engine, Session, org_id, owner_id, gate_id = await _setup_gate(
        await _session_factory(), hours_from_now=1,  # 1시간 뒤 — 아직 안 도래
    )
    try:
        async with Session() as s:
            counts = await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))
        assert counts["started"] == 0, counts

        async with Session() as s:
            command = await _get_boost_start_command(s, org_id, gate_id)
        assert command is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pending_gate_not_yet_approved_is_skipped():
    """뮤테이션 대상: `Gate.status == "approved"` 조건을 걷으면 미승인 gate도
    잡힌다 — «승인=실행 허가» 원칙(ads_boost_execution.py 모듈 관례) 위반. 이 시나리오
    는 실 데이터로도 일어난다(요청 시점에 이미 starts_at이 봉인되고, 승인 전에
    시간이 지나 그 값이 과거가 될 수 있다 — PR 2 「pending 중 재봉인」 관례). 필터가
    없으면 내부 `_resolve_gate`가 재검사해 `AdsBoostGateNotApprovedError`로 막지만
    (started는 0 유지) 그 경로를 타면 `counts["error"]`가 늘어난다 — 그 차이로 검산
    (test_wrong_gate_type_is_skipped와 동형 이중 방어 구조)."""
    from app.services.ads_boost_execution import process_due_ads_boost_starts

    engine, Session, org_id, owner_id, gate_id = await _setup_gate(
        await _session_factory(), hours_from_now=-1, approve=False,
    )
    try:
        async with Session() as s:
            counts = await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))
        assert counts["started"] == 0, counts
        assert counts["error"] == 0, counts  # 필터가 살아있으면 이 gate는 시도조차 안 됨

        async with Session() as s:
            command = await _get_boost_start_command(s, org_id, gate_id)
        assert command is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_gate_type_is_skipped():
    """뮤테이션 대상: `Gate.gate_type == "ads_boost"` 조건을 걷으면 다른 gate_type도
    잡힌다. 실 데이터에선 `sealed_ads_starts_at`이 ads_boost 전용 nullable 컬럼이라
    다른 gate_type 행은 애초에 값이 없어(구조적으로 이 SQL필터가 못 걸릴 일이
    없다) — 그 방어를 직접 검산하려고 **인위적으로**(실 애플리케이션 플로우로는
    못 만드는 상태) concept_approval 게이트에 그 컬럼을 채워 넣는다. 그래도 이
    필터가 없으면 `request_ads_boost_start`의 내부 `_resolve_gate`가 재검사해
    `AdsBoostGateNotFoundError`로 막긴 하나(started 카운트는 0 유지) — 그 경로를
    타면 `counts["error"]`가 늘어난다(필터가 있으면 애초에 시도 자체를 안 해 0).
    그 차이로 이 SQL필터가 실제로 도는지 검산한다(`_resolve_gate`와의 이중 방어
    구조 — 어느 한쪽만 봐선 「하나는 죽은 코드」로 오독하기 쉬워 여기 기록)."""
    from sqlalchemy import select, update
    from app.models.gate import Gate
    from app.services.ads_boost_execution import process_due_ads_boost_starts
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            role_id = await _seed_default_role(s, org_id)
            other_gate = await create_gate(
                s, org_id, uuid.uuid4(), "story", "concept_approval", owner_id, role_id,
                scope_key=str(uuid.uuid4()),
            )
            other_gate.status = "approved"
            other_gate.resolver_id = owner_id
            await s.commit()
            other_gate_id = other_gate.id
            # 인위적 상태 주입 — 위 docstring 참고.
            await s.execute(
                update(Gate).where(Gate.id == other_gate_id).values(
                    sealed_ads_starts_at=datetime.now(timezone.utc) - timedelta(hours=1),
                )
            )
            await s.commit()

        async with Session() as s:
            counts = await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))
        assert counts["started"] == 0, counts
        assert counts["error"] == 0, counts  # 필터가 살아있으면 이 gate는 시도조차 안 됨

        async with Session() as s:
            from app.models.publication_command import PublicationCommand

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == other_gate_id)
            )).scalar_one_or_none()
        assert command is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_already_started_gate_is_not_reprocessed():
    """뮤테이션 대상: `~exists(AdsBoostRun...)` 필터를 걷으면 이미 run 행이 생긴
    gate도 매 tick 재선택된다 — «이미 시작된 게이트 재실행 0»(카드 §4)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import process_due_ads_boost_starts

    engine, Session, org_id, owner_id, gate_id = await _setup_gate(
        await _session_factory(), hours_from_now=-1,
    )
    try:
        async with Session() as s:
            run = AdsBoostRun(id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, status="running")
            s.add(run)
            await s.commit()

        async with Session() as s:
            counts = await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))
        assert counts["started"] == 0, counts

        async with Session() as s:
            command = await _get_boost_start_command(s, org_id, gate_id)
        # boost_start command 자체가 아예 없다(사람도 워커도 이 gate를 아직 건드린
        # 적 없이 run만 직접 심은 인위적 상태) — 워커가 이 gate를 건드리지 않았다는
        # 증거로 충분.
        assert command is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_calling_worker_twice_does_not_duplicate_command():
    """겹친 tick(또는 워커+사람 클릭 경합) 멱등 — 두 번째 호출은 no-op(create_or_get
    upsert가 안전망)."""
    from app.services.ads_boost_execution import process_due_ads_boost_starts

    engine, Session, org_id, owner_id, gate_id = await _setup_gate(
        await _session_factory(), hours_from_now=-1,
    )
    try:
        async with Session() as s:
            counts1 = await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))
        assert counts1["started"] == 1

        # 두 번째 tick — AdsBoostRun이 아직 안 생겼으므로(실행은 process_due_
        # publication_commands가 별도로 함) 필터를 다시 통과하지만, 아래에서
        # create_or_get_publication_command의 자체 멱등이 새 행을 안 만든다는
        # 것을 확認한다(카운트는 그래도 "started"로 집힘 — 그 자체가 no-op라는
        # 사실은 command 개수로 검증).
        async with Session() as s:
            await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc))

        async with Session() as s:
            from sqlalchemy import select
            from app.models.publication_command import PublicationCommand

            commands = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.org_id == org_id, PublicationCommand.gate_id == gate_id,
                    PublicationCommand.operation == "boost_start",
                )
            )).scalars().all()
        assert len(commands) == 1, "두 번째 tick이 새 command를 만들면 멱등이 깨진 것"
    finally:
        await engine.dispose()
