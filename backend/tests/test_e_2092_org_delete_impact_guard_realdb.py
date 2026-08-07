"""#2092(P0 보안) real-DB — OrganizationRepository.delete_by_user()의 impact 재조회 가드를
실 organizations/deletion_audit_logs 위에서 검증. "파괴 조작이라 실측까지"(PO 지시,
2026-08-07) — 진짜 Postgres에 대고 ①거부 시 org가 실제로 살아남는지 ②override 시 실제로
삭제되고 감사로그에 note가 남는지 ③정상(impact 성공) 시 종전과 동일하게 동작하는지 확認.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_org_with_owner(session):
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    org_name = f"test-org-{org_id}"
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": org_name, "slug": f"slug-{org_id}"},
    )
    await session.execute(
        text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :user_id, 'owner')"),
        {"id": uuid.uuid4(), "org_id": org_id, "user_id": user_id},
    )
    await session.commit()
    return org_id, user_id, org_name


@pytest.mark.anyio
async def test_delete_rejected_realdb_org_survives_when_impact_query_fails_and_no_override():
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            with patch.object(repo, "get_impact", side_effect=RuntimeError("simulated impact query failure")):
                result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": False, "reason": "impact_unavailable"}

            row = (
                await session.execute(
                    text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id}
                )
            ).first()
            assert row is not None  # 거부됐으므로 org는 실제로 살아있어야 한다(파괴 안 됨)

            audit_count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM deletion_audit_logs WHERE entity_id=:oid"), {"oid": org_id}
                )
            ).scalar_one()
            assert audit_count == 0  # 거부됐으므로 감사로그도 안 남는다(진행 자체가 안 됐음)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_proceeds_realdb_org_removed_and_audit_note_recorded_with_override():
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            with patch.object(repo, "get_impact", side_effect=RuntimeError("simulated impact query failure")):
                result = await repo.delete_by_user(
                    org_id=org_id, user_id=user_id, confirmation=org_name, confirm_without_impact=True,
                )
            await session.commit()

            assert result == {"ok": True}

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is None  # override로 진행됐으므로 실제로 삭제됨

            audit_row = (
                await session.execute(
                    text("SELECT actor_id, entity_type, note FROM deletion_audit_logs WHERE entity_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert audit_row is not None
            assert audit_row.actor_id == user_id
            assert audit_row.entity_type == "organization"
            assert audit_row.note is not None and "확認 없이" in audit_row.note
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_with_override_survives_real_postgres_transaction_abort_realdb():
    """카디르 결함사냥 HIGH①(#2898 재QA, 2026-08-07) 재현+fix 검증 — 순수 Python
    RuntimeError mock이 아니라 **진짜 Postgres 에러**(존재하지 않는 테이블 참조 →
    UndefinedTable, asyncpg가 그 커넥션의 트랜잭션을 실제로 "aborted" 상태로 만든다)로
    get_impact()를 실패시킨다. fix(savepoint) 前엔 override로 진행해도 그 아래
    audit-insert·org-delete가 오염된 트랜잭션 위에서 실행돼 깨끗한 성공도 실패도 아닌
    상태가 됐다 — fix 後엔 SAVEPOINT가 그 실패를 격리해 override 진행이 실제로 끝까지
    깨끗하게 성공(org 삭제+audit 기입)해야 한다."""
    from sqlalchemy.exc import DBAPIError

    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            async def _broken_get_impact(org_id):
                # 진짜 Postgres 에러 — 존재하지 않는 테이블 참조. asyncpg가 이 커넥션의
                # 현재 트랜잭션을 실제로 aborted 상태로 만든다(mock RuntimeError로는
                # 재현 불가능한 축).
                await session.execute(text("SELECT * FROM this_table_does_not_exist_2092"))

            with patch.object(repo, "get_impact", side_effect=_broken_get_impact):
                try:
                    result = await repo.delete_by_user(
                        org_id=org_id, user_id=user_id, confirmation=org_name, confirm_without_impact=True,
                    )
                except DBAPIError:
                    pytest.fail(
                        "savepoint 격리 실패 — get_impact()의 진짜 Postgres 에러가 바깥 "
                        "트랜잭션까지 오염시켜 audit-insert/delete가 aborted 트랜잭션 위에서 "
                        "실행되며 예외로 전파됨(fix 前 재현 정확히 이 형태)"
                    )
                await session.commit()

            assert result == {"ok": True}

            verify_engine = create_async_engine(_ASYNC)
            try:
                async with async_sessionmaker(verify_engine, expire_on_commit=False)() as verify_session:
                    org_row = (
                        await verify_session.execute(
                            text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id}
                        )
                    ).first()
                    assert org_row is None  # 진짜로, 완전히 삭제됨(부분실패 아님)

                    audit_row = (
                        await verify_session.execute(
                            text("SELECT note FROM deletion_audit_logs WHERE entity_id=:oid"), {"oid": org_id}
                        )
                    ).first()
                    assert audit_row is not None
                    assert audit_row.note is not None and "확認 없이" in audit_row.note
            finally:
                await verify_engine.dispose()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_proceeds_realdb_normal_path_no_audit_note_when_impact_succeeds():
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": True}

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is None

            audit_row = (
                await session.execute(
                    text("SELECT note FROM deletion_audit_logs WHERE entity_id=:oid"), {"oid": org_id}
                )
            ).first()
            assert audit_row is not None
            assert audit_row.note is None  # 정상 경로 — override 사유 없음
    finally:
        await engine.dispose()


# ─── 카디르 결함사냥 HIGH②(#2898 재QA, 2026-08-07) — checkout_claimed_at 인지 ────

async def _insert_pending_subscription_with_claim(session, *, org_id, claimed_at):
    await session.execute(
        text(
            "INSERT INTO org_subscriptions (id, org_id, tier, status, provider, currency, checkout_claimed_at) "
            "VALUES (:id, :org_id, 'starter', 'pending', 'toss', 'krw', :claimed_at)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "claimed_at": claimed_at},
    )
    await session.commit()


@pytest.mark.anyio
async def test_delete_rejected_when_checkout_in_flight_realdb():
    """진행 中(staleness 안 넘긴) checkout claim이 있으면(구독 status는 아직 'pending' —
    'active' 아님) org 삭제를 거부한다 — #2896의 checkout_claimed_at 진행 中 claim을
    「활성 구독」과 동형으로 취급(reason=active_subscription 재사용). fix 前엔 이 창에서
    org가 삭제되고, 뒤늦게 그 checkout의 charge가 confirmed돼도 org가 이미 사라진 뒤라
    삭제된 org에 실 청구가 완료될 수 있었다."""
    from datetime import datetime, timezone

    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            await _insert_pending_subscription_with_claim(
                session, org_id=org_id, claimed_at=datetime.now(timezone.utc)
            )
            repo = OrganizationRepository(session)

            result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": False, "reason": "active_subscription"}

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is not None  # 거부됐으므로 org는 살아있어야 한다
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_proceeds_when_checkout_claim_is_stale_realdb():
    """staleness를 넘긴(=죽은/멈춘) checkout claim은 「진행 中」으로 안 쳐준다 —
    자기치유 회귀 없음(영원히 삭제 불가능한 org가 생기면 안 됨)."""
    from datetime import datetime, timedelta, timezone

    from app.repositories.organization import OrganizationRepository
    from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            stale_claim_at = datetime.now(timezone.utc) - STALE_CLAIM_WINDOW - timedelta(minutes=1)
            await _insert_pending_subscription_with_claim(session, org_id=org_id, claimed_at=stale_claim_at)
            repo = OrganizationRepository(session)

            result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": True}  # 죽은 claim은 회복 증거로 안 쳐줌 — 정상 삭제

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_get_impact_reflects_in_flight_checkout_claim_realdb():
    """get_impact()의 has_active_subscription 필드(FE 표시용)도 진행 中 checkout claim을
    반영해야 한다 — 삭제 거부 판정과 사용자에게 보여주는 정보가 어긋나면 안 된다."""
    from datetime import datetime, timezone

    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            await _insert_pending_subscription_with_claim(
                session, org_id=org_id, claimed_at=datetime.now(timezone.utc)
            )
            repo = OrganizationRepository(session)

            impact = await repo.get_impact(org_id=org_id)
            assert impact.has_active_subscription is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_delete_vs_checkout_claim_real_race_no_window_realdb():
    """카디르 3차 재QA 요청(#2898 리뷰, 2026-08-07) — 두 커넥션 **실경쟁**(asyncio.gather,
    이벤트로 스테이징하지 않음 — 순서를 강제하지 않고 Postgres 자체의 FOR UPDATE 행잠금이
    직렬화하는지를 실증)으로 #2092 조직삭제와 #2511/#2896 checkout claim UPSERT 사이
    TOCTOU 창이 실제로 닫혔는지 확認한다.

    organizations 행 FOR UPDATE로 양쪽이 직렬화되므로, 어느 쪽이 이기든 다음 불변식이
    항상 성립해야 한다 — 결과가 모순(둘 다 성공 또는 판정 불일치)이면 안 된다:
    ①org가 삭제됐다 ⟹ checkout은 CheckoutError로 실패(claim조차 못 섬)
    ②org가 살아있다 ⟹ delete_by_user는 반드시 reason=active_subscription으로 거부

    타이밍을 강제하지 않으므로 여러 회 반복해 두 순서(delete 먼저/checkout 먼저) 다
    실제로 일어날 확률을 높인다."""
    import asyncio
    from unittest.mock import AsyncMock

    from app.repositories.organization import OrganizationRepository
    from app.services.org_subscription_checkout import CheckoutError, checkout_subscription

    for i in range(8):
        engine_a = create_async_engine(_ASYNC)
        engine_b = create_async_engine(_ASYNC)
        Session_a = async_sessionmaker(engine_a, expire_on_commit=False)
        Session_b = async_sessionmaker(engine_b, expire_on_commit=False)
        seed_engine = create_async_engine(_ASYNC)
        try:
            async with async_sessionmaker(seed_engine, expire_on_commit=False)() as seed_session:
                org_id, user_id, org_name = await _seed_org_with_owner(seed_session)

            toss_billing_key_response = {
                "billingKey": f"billing-key-race-{i}",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {"paymentKey": f"pay-race-{i}-{uuid.uuid4()}", "totalAmount": 5_000}

            async def _run_checkout():
                async with Session_a() as session:
                    with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                        side_effect=[toss_billing_key_response, toss_charge_response]
                    )):
                        try:
                            sub = await checkout_subscription(
                                session, org_id=org_id, auth_key=f"ak-race-{i}",
                                tier="starter", billing_cycle="monthly",
                            )
                            return ("ok", sub.status)
                        except CheckoutError as exc:
                            return ("checkout_error", str(exc))
                        except Exception as exc:  # CheckoutInProgress·CheckoutDeclined 등 — 이 테스트 관심사 아님
                            return ("other_failure", str(exc))

            async def _run_delete():
                async with Session_b() as session:
                    repo = OrganizationRepository(session)
                    result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
                    await session.commit()
                    return result

            checkout_result, delete_result = await asyncio.gather(_run_checkout(), _run_delete())

            verify_engine = create_async_engine(_ASYNC)
            try:
                async with async_sessionmaker(verify_engine, expire_on_commit=False)() as vs:
                    org_row = (
                        await vs.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
                    ).first()
                    org_deleted = org_row is None
            finally:
                await verify_engine.dispose()

            if org_deleted:
                assert delete_result["ok"] is True, f"iter{i}: org 삭제됐는데 delete_result={delete_result}"
                assert checkout_result[0] != "ok", (
                    f"iter{i}: 모순 — org가 삭제됐는데 checkout도 성공(claim이 죽은 org에 섬): {checkout_result}"
                )
            else:
                assert delete_result == {"ok": False, "reason": "active_subscription"}, (
                    f"iter{i}: 모순 — org가 살아있는데 delete가 active_subscription으로 안 막음: {delete_result}"
                )
        finally:
            await engine_a.dispose()
            await engine_b.dispose()


@pytest.mark.anyio
async def test_org_delete_vs_checkout_claim_deterministic_staged_race_realdb():
    """카디르 3차 재QA — 결정론적 스테이징으로 정확히 위험했던 그 순서(delete가 impact
    체크를 통과한 直後·아직 커밋 前 그 사이로 checkout claim이 끼어드는지)를 강제
    재현한다. fix(FOR UPDATE) 前엔 checkout의 claim UPSERT가 delete의 락과 무관하게
    즉시 진행돼버렸다(위 비결정론적 실경쟁 테스트가 못 잡을 만큼 창이 좁았다 — 로컬
    라운드트립이 빨라 우연히 안전한 순서로만 끝나곤 했음, 실측 확認). fix 後엔
    checkout의 FOR UPDATE 시도 자체가 delete가 그 org 행 락을 쥐고 있는 한 반드시
    block돼야 한다 — "안 끝난다"는 것 자체를 타임아웃으로 직접 증명한다."""
    import asyncio
    from unittest.mock import AsyncMock

    from app.repositories.organization import OrganizationRepository
    from app.services.org_subscription_checkout import checkout_subscription

    engine_a = create_async_engine(_ASYNC)
    engine_b = create_async_engine(_ASYNC)
    Session_a = async_sessionmaker(engine_a, expire_on_commit=False)  # delete
    Session_b = async_sessionmaker(engine_b, expire_on_commit=False)  # checkout
    seed_engine = create_async_engine(_ASYNC)
    try:
        async with async_sessionmaker(seed_engine, expire_on_commit=False)() as seed_session:
            org_id, user_id, org_name = await _seed_org_with_owner(seed_session)

        impact_checked = asyncio.Event()    # delete가 impact 체크(FOR UPDATE 락 보유 中)를 통과했다.
        delete_may_finish = asyncio.Event()  # 테스트가 delete에게 "이제 커밋해도 된다"를 허가.

        real_get_impact = OrganizationRepository.get_impact

        async def _paced_get_impact(self, org_id):
            result = await real_get_impact(self, org_id=org_id)
            impact_checked.set()
            # FOR UPDATE 락을 계속 쥔 채 대기 — 바로 이 구간이 fix 前엔 checkout이
            # 자유롭게 끼어들 수 있던 그 창(재확認 直後~실 delete/commit 前).
            await delete_may_finish.wait()
            return result

        async def _run_delete():
            async with Session_a() as session:
                with patch.object(OrganizationRepository, "get_impact", _paced_get_impact):
                    repo = OrganizationRepository(session)
                    result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
                    await session.commit()
                    return result

        async def _run_checkout():
            await impact_checked.wait()  # delete가 impact 체크를 통과(그러나 아직 커밋 前, 락 보유 中)한 뒤에 시작.
            async with Session_b() as session:
                with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(side_effect=[
                    {
                        "billingKey": "billing-key-staged", "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                        "authenticatedAt": "2026-08-07T00:00:00+09:00",
                    },
                    {"paymentKey": f"pay-staged-{uuid.uuid4()}", "totalAmount": 5_000},
                ])):
                    try:
                        sub = await checkout_subscription(
                            session, org_id=org_id, auth_key="ak-staged", tier="starter", billing_cycle="monthly",
                        )
                        return ("ok", sub.status)
                    except Exception as exc:
                        return ("failed", str(exc))

        delete_task = asyncio.ensure_future(_run_delete())
        checkout_task = asyncio.ensure_future(_run_checkout())

        await impact_checked.wait()  # delete가 impact 체크를 통과할 때까지(FOR UPDATE 락 보유 中) 대기.

        # 핵심 검증 — delete가 아직 커밋 前(락 보유 中)인 동안 checkout은 그 락에 막혀
        # 완결되지 못해야 한다(짧은 타임아웃 안에 안 끝남 = 진짜로 blocked됨을 직접 증명).
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(checkout_task), timeout=0.5)

        delete_may_finish.set()  # 이제 delete가 커밋하도록 허가.
        delete_result, checkout_result = await asyncio.gather(delete_task, checkout_task)

        assert delete_result == {"ok": True}
        assert checkout_result[0] == "failed"
        assert "찾을 수 없음" in checkout_result[1]  # 락 해제 後 org 없음으로 실패(claim 못 섬) — 죽은 org에 claim 안 섬
    finally:
        await engine_a.dispose()
        await engine_b.dispose()
