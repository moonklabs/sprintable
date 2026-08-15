"""#2512 real-DB — customerKey 사전발급→체크아웃 전체 흐름을 실 org_billing_keys +
org_subscriptions 위에서 검증. TossAdapter의 HTTP 왕복만 mock.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

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


@pytest.fixture(autouse=True)
def _crypto_key(monkeypatch):
    import app.core.config as config_module
    from app.services import billing_key_crypto

    monkeypatch.setattr(config_module.settings, "org_billing_key_encryption_key", "W3x6lXDky6UQE36FyRU_Snf9m7d73Aev59D4PvS4-N0=")
    billing_key_crypto._get_multi_fernet.cache_clear()
    yield
    billing_key_crypto._get_multi_fernet.cache_clear()


@pytest.mark.anyio
async def test_ensure_customer_key_then_checkout_reuses_placeholder_realdb():
    """FE 실 플로우 재현: ①customerKey 사전발급(위젯 열기 前) ②위젯 인증 완료 후
    checkout(authKey) 호출 — 같은 customer_key가 그대로 쓰이고 placeholder가 실 빌링키로
    덮어써지는지, 그리고 checkout이 정상적으로 active까지 도달하는지 실PG로 확認."""
    from app.services.org_billing_key import ensure_customer_key
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            # #2092 TOCTOU-fix(3차) — checkout_subscription이 organizations 행을 FOR
            # UPDATE로 잠근다(존재 확인 겸함) — 실 org 행 필요.
            await session.execute(
                text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
                {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
            )
            for _ in range(3):  # starter included_seats=3 — 초과 없이
                await session.execute(
                    text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :oid, :uid, 'member')"),
                    {"id": uuid.uuid4(), "oid": org_id, "uid": uuid.uuid4()},
                )
            await session.commit()

            # ① 위젯 열기 前 — customerKey 사전발급.
            pre_widget_key = await ensure_customer_key(session, org_id=org_id)
            assert pre_widget_key.startswith("org-")

            row = (
                await session.execute(
                    text("SELECT status, encrypted_billing_key, customer_key FROM org_billing_keys WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.status == "awaiting_auth"
            assert row.encrypted_billing_key is None
            assert row.customer_key == pre_widget_key

            # ② 위젯 인증 완료 → checkout(authKey) — 같은 customer_key로 Toss 호출돼야.
            captured_customer_keys = []

            async def _fake_post(self, path, *, json, timeout, op_label, idempotency_key=None):
                if op_label == "billing key issuance":
                    captured_customer_keys.append(json["customerKey"])
                    return {
                        "billingKey": "real-billing-key",
                        "card": {"issuerCode": "61", "number": "1234****", "cardType": "신용", "ownerType": "개인"},
                        "authenticatedAt": "2026-08-07T00:00:00+09:00",
                    }
                return {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 29_000}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                sub = await checkout_subscription(
                    session, org_id=org_id, auth_key="widget-auth-key", tier="starter", billing_cycle="monthly",
                )

            assert sub.status == "active"
            assert captured_customer_keys == [pre_widget_key]  # placeholder의 customer_key 재사용됨

            final_row = (
                await session.execute(
                    text("SELECT status, encrypted_billing_key, customer_key FROM org_billing_keys WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert final_row.status == "active"
            assert final_row.encrypted_billing_key is not None  # placeholder가 실 빌링키로 덮어써짐
            assert final_row.customer_key == pre_widget_key  # customer_key는 그대로
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_customer_key_is_idempotent_across_calls_realdb():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            from app.services.org_billing_key import ensure_customer_key

            org_id = uuid.uuid4()
            key1 = await ensure_customer_key(session, org_id=org_id)
            key2 = await ensure_customer_key(session, org_id=org_id)
            assert key1 == key2

            count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM org_billing_keys WHERE org_id=:oid"), {"oid": org_id}
                )
            ).scalar_one()
            assert count == 1  # 두 번 불러도 1행만
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_awaiting_auth_placeholder_is_never_treated_as_active_billing_key_realdb():
    """PO/카디르 결함사냥 축② 사전 pin — awaiting_auth placeholder(위젯 인증 前, 실
    빌링키 없음)를 charge_org가 "활성 빌링키"로 오인해 청구를 시도하면 안 된다.
    org_subscription이 active라도(예: 과거 다른 경로로 active가 됐거나 테스트 조작)
    billing_key가 없으면 명시 실패해야지, 조용히 청구가 나가면 안 된다."""
    from app.services.billing_charge import charge_org
    from app.services.org_billing_key import ensure_customer_key

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            # placeholder만 있고(실 빌링키 없음) — 위젯 인증 前 상태 그대로.
            await ensure_customer_key(session, org_id=org_id)

            row = (
                await session.execute(
                    text("SELECT status FROM org_billing_keys WHERE org_id=:oid"), {"oid": org_id}
                )
            ).first()
            assert row.status == "awaiting_auth"

            with pytest.raises(RuntimeError, match="no active billing key"):
                await charge_org(
                    session, org_id=org_id, order_id=f"test-{uuid.uuid4()}",
                    amount_minor=59_000, currency="krw",
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_customer_key_concurrent_calls_create_exactly_one_row_realdb():
    """PO/카디르 결함사냥 축① 사전 pin — 진짜 동시성 하네스(#2505 max_packs와 동형).
    같은(신규) org에 대해 완전히 독립된 두 커넥션이 동시에 customer-key를 요청해도
    org_billing_keys에는 정확히 1행만 남고, 둘 다 «같은» customer_key를 받아야 한다
    (ON CONFLICT DO NOTHING + 레이스 패배 시 재조회가 실제로 직렬화하는지 실증)."""
    import asyncio
    from app.services.org_billing_key import ensure_customer_key

    org_id = uuid.uuid4()
    engine_a = create_async_engine(_ASYNC)
    engine_b = create_async_engine(_ASYNC)
    Session_a = async_sessionmaker(engine_a, expire_on_commit=False)
    Session_b = async_sessionmaker(engine_b, expire_on_commit=False)

    async def _attempt(session_factory):
        async with session_factory() as session:
            return await ensure_customer_key(session, org_id=org_id)

    try:
        key_a, key_b = await asyncio.gather(_attempt(Session_a), _attempt(Session_b))
        assert key_a == key_b

        verify_engine = create_async_engine(_ASYNC)
        try:
            async with async_sessionmaker(verify_engine, expire_on_commit=False)() as verify_session:
                count = (
                    await verify_session.execute(
                        text("SELECT COUNT(*) FROM org_billing_keys WHERE org_id=:oid"), {"oid": org_id}
                    )
                ).scalar_one()
                assert count == 1
        finally:
            await verify_engine.dispose()
    finally:
        await engine_a.dispose()
        await engine_b.dispose()


@pytest.mark.anyio
async def test_ensure_customer_key_vs_issue_billing_key_cross_function_race_converges_realdb():
    """카디르 결함사냥 HIGH fix 검증(#2892 리뷰, 2026-08-07) — «동일함수」가 아니라
    «교차함수» 레이스: 위젯을 연 요청(ensure_customer_key, 커넥션 A)과 거의 동시에
    도착한 checkout(issue_billing_key, 커넥션 B)이 같은 신규 org를 놓고 경쟁한다.
    fix 前엔 issue_billing_key가 스스로 SELECT로 "행 없음"을 보고 새 키로 Toss를
    불러 DB customer_key(ensure_customer_key가 나중에 커밋한 값)와 영구 불일치가
    났다 — fix 後엔 issue_billing_key도 ensure_customer_key()를 거치므로 둘이 반드시
    같은 customer_key로 수렴하고, Toss에 실제로 등록된 키(create_billing_key 호출
    인자)와 최종 DB customer_key가 항상 일치해야 한다."""
    import asyncio
    from app.services.org_billing_key import ensure_customer_key, issue_billing_key

    org_id = uuid.uuid4()
    engine_a = create_async_engine(_ASYNC)
    engine_b = create_async_engine(_ASYNC)
    Session_a = async_sessionmaker(engine_a, expire_on_commit=False)
    Session_b = async_sessionmaker(engine_b, expire_on_commit=False)

    captured_toss_customer_key = {}

    async def _fake_post(self, path, *, json, timeout, op_label, idempotency_key=None):
        captured_toss_customer_key["value"] = json["customerKey"]
        return {
            "billingKey": "real-billing-key",
            "card": {"issuerCode": "61", "number": "1234****", "cardType": "신용", "ownerType": "개인"},
            "authenticatedAt": "2026-08-07T00:00:00+09:00",
        }

    async def _widget_open():
        async with Session_a() as session:
            return await ensure_customer_key(session, org_id=org_id)

    async def _checkout_issue():
        async with Session_b() as session:
            row = await issue_billing_key(session, org_id=org_id, auth_key="widget-auth-key")
            return row.customer_key

    try:
        with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
            widget_key, checkout_key = await asyncio.gather(_widget_open(), _checkout_issue())

        assert widget_key == checkout_key  # 두 함수가 같은 값으로 수렴
        assert captured_toss_customer_key["value"] == widget_key  # Toss 등록 키 == 최종 DB 키(불일치 없음)

        verify_engine = create_async_engine(_ASYNC)
        try:
            async with async_sessionmaker(verify_engine, expire_on_commit=False)() as verify_session:
                row = (
                    await verify_session.execute(
                        text("SELECT COUNT(*) as cnt FROM org_billing_keys WHERE org_id=:oid"),
                        {"oid": org_id},
                    )
                ).first()
                assert row.cnt == 1  # 행도 1개만(중복 생성 없음)

                final = (
                    await verify_session.execute(
                        text("SELECT customer_key, status FROM org_billing_keys WHERE org_id=:oid"),
                        {"oid": org_id},
                    )
                ).first()
                assert final.customer_key == widget_key
                assert final.status == "active"  # issue_billing_key가 실제로 완료됨
        finally:
            await verify_engine.dispose()
    finally:
        await engine_a.dispose()
        await engine_b.dispose()
