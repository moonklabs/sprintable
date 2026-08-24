"""story #2989(AC1·AC2·AC3) realdb 검증 — 결제수단(빌링키) 셀프서브 삭제 + admin 초기화가
공유하는 단일 레일 `revoke_billing_key()`. 핵심 검증축: ①활성 유료 구독이면 차단(P3,
force 아닐 때) ②force=True(admin)면 그 차단을 우회 ③Toss 실 폐기 호출 확認(전면 mock —
실 Toss 왕복은 이 스위트 스코프 밖) ④DB 행이 status='deleted'+카드정보 전부 NULL로
정리되지만 customer_key는 보존(재등록 시 재사용) ⑤이미 삭제됐거나 카드가 아예 없으면
no-op(idempotent) ⑥placeholder(awaiting_auth, encrypted_billing_key=None)는 Toss 호출 없이
DB 정리만 ⑦ActivityLog에 billing_key_revoked 기록 ⑧issue_billing_key 재발급(카드 교체)이
신 키 저장 성공 後 구 키를 Toss에서도 폐기(PO 동승 권고, PR#3423 리뷰 — C4 유예 갭을 이
스토리가 닫음), 폐기 실패해도 신 키 저장은 유지. 로컬 PG 미설정 시 skip(CI 관례 동일)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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
def _configure_billing_key_crypto(monkeypatch):
    """revoke_billing_key가 실제로 decrypt_billing_key()를 거친다 — 다른 realdb 스위트처럼
    가짜 문자열("enc-token")을 넣으면 Fernet 파싱에서 터진다. 실 키를 구성해 seed에도
    encrypt_billing_key()로 진짜 토큰을 만든다([[feedback_no_secret_shaped_literals]]와
    별개 축 — 이건 Fernet 대칭키지 Toss/Stripe 형태의 secret 리터럴이 아니다)."""
    import importlib
    from cryptography.fernet import Fernet
    import app.core.config as config_module

    key = Fernet.generate_key().decode()
    monkeypatch.setattr(config_module.settings, "org_billing_key_encryption_key", key)
    import app.services.billing_key_crypto as crypto_module
    importlib.reload(crypto_module)
    import app.services.org_billing_key as org_billing_key_module
    monkeypatch.setattr(org_billing_key_module, "encrypt_billing_key", crypto_module.encrypt_billing_key)
    monkeypatch.setattr(org_billing_key_module, "decrypt_billing_key", crypto_module.decrypt_billing_key)
    return crypto_module


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(
    session, *, tier: str | None = None, sub_status: str = "active",
    current_period_end: datetime | None = None,
):
    from app.models.organization import Organization
    from app.models.org_subscription import OrgSubscription

    org = Organization(id=uuid.uuid4(), name="Org2989", slug=f"org2989-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    if tier is not None:
        session.add(OrgSubscription(
            id=uuid.uuid4(), org_id=org.id, tier=tier, status=sub_status,
            current_period_end=current_period_end,
        ))
        await session.flush()
    await session.commit()
    return org.id


async def _seed_billing_key(
    session, *, org_id, status: str = "active", plaintext: str | None = "billing_plaintext_token",
    customer_key: str | None = None,
):
    from app.models.org_billing_key import OrgBillingKey
    from app.services.billing_key_crypto import encrypt_billing_key

    key = OrgBillingKey(
        id=uuid.uuid4(), org_id=org_id, customer_key=customer_key or f"cust-{uuid.uuid4().hex[:10]}",
        encrypted_billing_key=encrypt_billing_key(plaintext) if plaintext else None,
        card_issuer_code="61" if plaintext else None,
        card_number_masked="1234********5678" if plaintext else None,
        card_type="신용" if plaintext else None,
        card_owner_type="개인" if plaintext else None,
        status=status,
        issued_at=datetime(2026, 1, 1, tzinfo=timezone.utc) if plaintext else None,
    )
    session.add(key)
    await session.commit()
    return key.id, key.customer_key


@pytest.mark.asyncio
async def test_revoke_billing_key_blocks_when_active_paid_subscription():
    """P3 — 활성 유료 구독이 있으면(force 아닐 때) 결제수단 삭제를 서버가 명시 거부한다.
    PO 재지적(2026-08-24, PR#3423 리뷰, 유나 관찰) — 해지는 예약형이라 "해지 후 다시
    시도" 안내는 거짓이다. 예외가 current_period_end를 정확히 실어야 라우터/FE가 실
    날짜를 보여줄 수 있다."""
    from app.services.org_billing_key import ActiveSubscriptionBlocksRevoke, revoke_billing_key

    period_end = datetime(2026, 9, 24, tzinfo=timezone.utc)
    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="starter", sub_status="active", current_period_end=period_end)
            await _seed_billing_key(s, org_id=org_id)

        async with maker() as s:
            with pytest.raises(ActiveSubscriptionBlocksRevoke) as exc_info:
                await revoke_billing_key(s, org_id=org_id, actor_id=uuid.uuid4(), actor_type="human")
            assert exc_info.value.tier == "starter"
            assert exc_info.value.current_period_end == period_end
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_allows_when_no_paid_subscription():
    """free tier(또는 구독 자체 없음)면 차단되지 않는다 — P1/P2 하한은 이 함수 스코프
    밖(라우터/FE가 이미 카드 1건뿐인 UI라 자연히 만족, org_billing_keys가 org당 1행)."""
    from app.services.org_billing_key import revoke_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free", sub_status="active")
            await _seed_billing_key(s, org_id=org_id)

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()) as mock_delete:
            async with maker() as s:
                result = await revoke_billing_key(s, org_id=org_id, actor_id=uuid.uuid4(), actor_type="human")

        assert result["deleted"] is True
        assert result["toss_revoked"] is True
        mock_delete.assert_awaited_once()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_force_bypasses_active_subscription_block():
    """AC3 — admin 경로(force=True)는 활성 유료 구독이 있어도 차단을 우회한다."""
    from app.services.org_billing_key import revoke_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team", sub_status="active")
            await _seed_billing_key(s, org_id=org_id)

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()):
            async with maker() as s:
                result = await revoke_billing_key(s, org_id=org_id, actor_id=None, actor_type="agent", force=True)

        assert result["deleted"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_calls_toss_delete_before_db_mutation_and_clears_card_fields():
    """순서 고정 — Toss 실 폐기가 먼저(성공해야 DB를 건드림). 성공 후 DB 행은 status=
    'deleted'+카드정보 전부 NULL이지만 customer_key는 보존(재등록 시 재사용)."""
    from app.services.org_billing_key import revoke_billing_key
    from app.models.org_billing_key import OrgBillingKey
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            key_id, customer_key = await _seed_billing_key(s, org_id=org_id)

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()) as mock_delete:
            async with maker() as s:
                result = await revoke_billing_key(s, org_id=org_id, actor_id=uuid.uuid4(), actor_type="human")

        # billing_key_crypto로 복호화된 평문이 Toss 호출 인자로 정확히 실렸는지(암호화
        # 토큰 그대로가 아니라 seed에 쓴 원문과 동일해야 한다).
        mock_delete.assert_awaited_once_with(billing_key="billing_plaintext_token")
        assert result["card_number_masked"] == "1234********5678"

        async with maker() as s:
            row = (await s.execute(select(OrgBillingKey).where(OrgBillingKey.id == key_id))).scalar_one()
            assert row.status == "deleted"
            assert row.encrypted_billing_key is None
            assert row.card_issuer_code is None
            assert row.card_number_masked is None
            assert row.card_type is None
            assert row.card_owner_type is None
            assert row.customer_key == customer_key  # 보존 — 재등록 시 ensure_customer_key 재사용
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_placeholder_skips_toss_call():
    """awaiting_auth placeholder(encrypted_billing_key=None)는 Toss에 애초에 발급된 적이
    없어 폐기 대상이 없다 — Toss 호출 없이 DB 정리만(no-fiction)."""
    from app.services.org_billing_key import revoke_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            await _seed_billing_key(s, org_id=org_id, status="awaiting_auth", plaintext=None)

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()) as mock_delete:
            async with maker() as s:
                result = await revoke_billing_key(s, org_id=org_id, actor_id=uuid.uuid4(), actor_type="human")

        mock_delete.assert_not_awaited()
        assert result["deleted"] is True
        assert result["toss_revoked"] is False
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_noop_when_already_deleted():
    """멱등 — 이미 status='deleted'면 재호출해도 no-op(reason=no_active_billing_key)."""
    from app.services.org_billing_key import revoke_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            await _seed_billing_key(s, org_id=org_id, status="deleted", plaintext=None)

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()) as mock_delete:
            async with maker() as s:
                result = await revoke_billing_key(s, org_id=org_id, actor_id=uuid.uuid4(), actor_type="human")

        mock_delete.assert_not_awaited()
        assert result == {"deleted": False, "reason": "no_active_billing_key"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_noop_when_no_row_at_all():
    from app.services.org_billing_key import revoke_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            # org_billing_keys 행 자체를 세팅하지 않음.

        async with maker() as s:
            result = await revoke_billing_key(s, org_id=org_id, actor_id=uuid.uuid4(), actor_type="human")
        assert result == {"deleted": False, "reason": "no_active_billing_key"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_revoke_billing_key_records_activity_log():
    """AC3 요건(admin 초기화 감사) — 셀프서브도 동일하게 남긴다(감사 표면 일관)."""
    from app.services.org_billing_key import revoke_billing_key
    from app.models.activity_log import ActivityLog
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            await _seed_billing_key(s, org_id=org_id)
        actor_id = uuid.uuid4()

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()):
            async with maker() as s:
                await revoke_billing_key(s, org_id=org_id, actor_id=actor_id, actor_type="human")

        async with maker() as s:
            log = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.org_id == org_id, ActivityLog.action == "billing_key_revoked",
                )
            )).scalar_one()
            assert log.actor_id == actor_id
            assert log.actor_type == "human"
            assert log.context["toss_revoked"] is True
            assert log.context["card_number_masked"] == "1234********5678"
            assert log.context["force"] is False
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_issue_billing_key_reissue_revokes_old_toss_key_after_new_key_saved():
    """story #2989(PO 동승 권고, PR#3423 리뷰) — 카드 교체(재발급) 성공 後 구 빌링키를
    Toss에서도 실 폐기한다(신 키 저장 커밋이 먼저, 그 다음 구 키 폐기). 이전엔 구 키가
    Toss에 고아로 남는 C4 유예 갭이었다(issue_billing_key 옛 docstring)."""
    from app.services.org_billing_key import issue_billing_key
    from app.models.org_billing_key import OrgBillingKey
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            # customer_key는 unique 제약 대상 — _seed_billing_key 기본 생성(uuid 접미)에
            # 맡긴다(고정 리터럴을 썼다가 재실행 시 잔존행과 충돌해 UniqueViolationError를
            # 자초한 적이 있다, 이 파일의 다른 헬퍼들과 동일 관례로 정정).
            _, customer_key = await _seed_billing_key(
                s, org_id=org_id, plaintext="old_billing_key_plaintext",
            )

        mock_create = AsyncMock(return_value={
            "billingKey": "new_billing_key_plaintext",
            "authenticatedAt": "2026-08-24T00:00:00+09:00",
            "card": {"issuerCode": "61", "number": "9999********0000", "cardType": "신용", "ownerType": "개인"},
        })
        mock_delete = AsyncMock()
        with patch("app.services.org_billing_key.TossAdapter.create_billing_key", new=mock_create), \
                patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=mock_delete):
            async with maker() as s:
                await issue_billing_key(s, org_id=org_id, auth_key="auth_reissue")

        # 구 키가 정확히 그 평문으로 폐기 호출됐는지(암호화 토큰이 아니라 복호된 원문).
        mock_delete.assert_awaited_once_with(billing_key="old_billing_key_plaintext")

        async with maker() as s:
            row = (await s.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))).scalar_one()
            assert row.customer_key == customer_key  # 재발급이라 customer_key는 유지
            assert row.card_number_masked == "9999********0000"  # 새 카드로 갱신됨
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_issue_billing_key_new_org_no_old_key_skips_toss_delete():
    """신규 org(구 행 없음)면 old-key preread가 None → Toss delete 호출 자체가 없다."""
    from app.services.org_billing_key import issue_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            # org_billing_keys 행 자체를 세팅하지 않음(최초 발급 시나리오).

        mock_create = AsyncMock(return_value={
            "billingKey": "first_billing_key_plaintext",
            "authenticatedAt": "2026-08-24T00:00:00+09:00",
            "card": {"issuerCode": "61", "number": "1111********2222", "cardType": "신용", "ownerType": "개인"},
        })
        mock_delete = AsyncMock()
        with patch("app.services.org_billing_key.TossAdapter.create_billing_key", new=mock_create), \
                patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=mock_delete):
            async with maker() as s:
                await issue_billing_key(s, org_id=org_id, auth_key="auth_first")

        mock_delete.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_issue_billing_key_reissue_keeps_new_key_saved_even_if_old_key_toss_delete_fails():
    """PO 지시 순서 — 구 키 Toss 폐기 실패는 신 키 저장을 롤백하지 않는다(신 키는 이미
    커밋됨, 폐기 실패는 로깅만)."""
    from app.services.org_billing_key import issue_billing_key
    from app.models.org_billing_key import OrgBillingKey
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            await _seed_billing_key(s, org_id=org_id, plaintext="old_billing_key_plaintext")

        mock_create = AsyncMock(return_value={
            "billingKey": "new_billing_key_plaintext",
            "authenticatedAt": "2026-08-24T00:00:00+09:00",
            "card": {"issuerCode": "61", "number": "9999********0000", "cardType": "신용", "ownerType": "개인"},
        })
        mock_delete = AsyncMock(side_effect=RuntimeError("Toss 5xx"))
        with patch("app.services.org_billing_key.TossAdapter.create_billing_key", new=mock_create), \
                patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=mock_delete):
            async with maker() as s:
                result = await issue_billing_key(s, org_id=org_id, auth_key="auth_reissue")

        assert result is not None
        async with maker() as s:
            row = (await s.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))).scalar_one()
            assert row.status == "active"
            assert row.card_number_masked == "9999********0000"  # 신 키 저장은 유지
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_reset_billing_key_admin_wrapper_bypasses_block_and_audits():
    """admin_billing.reset_billing_key — revoke_billing_key(force=True)를 타는지 +
    _audit() 구조화 로깅이 도는지(예외 없이 완주하면 성공, 로그 포맷 자체는 다른 admin_billing
    액션들과 동형이라 별도 캡처 불요)."""
    from app.services.admin_billing import reset_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="business", sub_status="active")
            await _seed_billing_key(s, org_id=org_id)

        with patch("app.services.org_billing_key.TossAdapter.delete_billing_key", new=AsyncMock()):
            async with maker() as s:
                result = await reset_billing_key(s, org_id=org_id, actor_email="operator@moonklabs.com")

        assert result["deleted"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_reset_billing_key_admin_wrapper_noop_when_no_billing_key():
    from app.services.admin_billing import reset_billing_key

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")

        async with maker() as s:
            result = await reset_billing_key(s, org_id=org_id, actor_email="operator@moonklabs.com")
        assert result == {"deleted": False, "reason": "no_active_billing_key"}
    finally:
        await engine.dispose()
