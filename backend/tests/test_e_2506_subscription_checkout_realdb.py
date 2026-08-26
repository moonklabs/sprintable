"""#2502+#2506 real-DB — checkout_subscription 전체 상태기계를 실 org_billing_keys/
org_subscriptions/billing_orders/billing_ledger_entries 위에서 검증. TossAdapter의 HTTP
왕복(create_billing_key/charge)만 mock — 나머지(암호화·DB 쓰기·원장)는 전부 실제로 돈다.

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


async def _seed_org_with_members(session, *, human_seats=5):
    org_id = uuid.uuid4()
    # #2092 TOCTOU-fix(3차) — checkout_subscription이 이제 organizations 행을 FOR UPDATE로
    # 잠근다(존재 확인 겸함) — 실제 org 행 없이는 checkout 자체가 명시 실패한다(정확히
    # 프로덕션과 동일 — org_id는 항상 실 org를 가리켜야 한다).
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
    )
    for _ in range(human_seats):
        await session.execute(
            text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :uid, 'member')"),
            {"id": uuid.uuid4(), "org_id": org_id, "uid": uuid.uuid4()},
        )
    await session.commit()
    return org_id


@pytest.mark.anyio
async def test_checkout_full_flow_activates_subscription_and_writes_ledger_realdb():
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_members(session, human_seats=5)  # team 포함좌석과 동일

            toss_billing_key_response = {
                "billingKey": "billing-key-plaintext-test",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {
                "paymentKey": f"pay-{uuid.uuid4()}",
                "orderId": "unused-here",
                "totalAmount": 59_000,
            }

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                sub = await checkout_subscription(
                    session, org_id=org_id, auth_key="test-auth-key", tier="team", billing_cycle="monthly",
                )

            assert sub.status == "active"
            assert sub.tier == "team"
            assert sub.billing_cycle == "monthly"
            assert sub.current_period_start is not None
            assert sub.current_period_end is not None

            # org_billing_keys에 암호화된 빌링키가 실제로 저장됐는지.
            row = (
                await session.execute(
                    text("SELECT status, encrypted_billing_key FROM org_billing_keys WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row is not None
            assert row.status == "active"
            assert row.encrypted_billing_key != "billing-key-plaintext-test"  # 평문 아님

            # billing_orders가 confirmed로 남았는지.
            order_row = (
                await session.execute(
                    text("SELECT status, amount_minor, payment_key FROM billing_orders WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert order_row.status == "confirmed"
            # story #3097 — VAT 10% 가산(공급가 59,000 → 청구 64,900).
            assert order_row.amount_minor == 64_900

            # 원장(A2)에 charge 엔트리가 실제로 기입됐는지.
            ledger_row = (
                await session.execute(
                    text("SELECT entry_type, amount_minor, direction FROM billing_ledger_entries WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert ledger_row.entry_type == "charge"
            assert ledger_row.amount_minor == 64_900
            assert ledger_row.direction == "credit"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_retry_same_day_does_not_double_charge_realdb():
    """더블클릭/네트워크 재시도 시나리오 — 같은 날 두 번째 checkout 호출도 같은
    orderId로 수렴해(#2493 원자적 claim) 원장에 charge 엔트리가 1건만 남아야 한다."""
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_members(session, human_seats=5)

            toss_billing_key_response = {
                "billingKey": "billing-key-plaintext-test-2",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 59_000}

            # 1차 호출 — 정상 완료.
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                sub1 = await checkout_subscription(
                    session, org_id=org_id, auth_key="test-auth-key", tier="team", billing_cycle="monthly",
                )
            assert sub1.status == "active"

            # 2차 호출(더블클릭 재시도 가정) — billing key는 기존 customer_key 재사용,
            # charge는 같은 orderId라 charge_org가 기존 confirmed order를 그대로 반환
            # (Toss _post가 다시 호출되지 않아야 함 — side_effect 리스트에 charge용
            # 응답을 안 넣어서, 만약 다시 호출되면 StopIteration으로 즉시 실패한다).
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response]
            )):
                sub2 = await checkout_subscription(
                    session, org_id=org_id, auth_key="test-auth-key", tier="team", billing_cycle="monthly",
                )
            assert sub2.status == "active"

            ledger_count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid AND entry_type='charge'"),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert ledger_count == 1  # 이중청구 안 됨
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_concurrent_different_tier_charges_at_most_once_realdb():
    """#2511 — 카디르 #2890 결함사냥 재QA 발견 재현+fix 검증: 같은 org에 «다른» tier/cycle
    로 진짜 동시(asyncio.gather, 완전히 독립된 두 커넥션) checkout이 도착해도 charge는
    최대 1회·구독은 1개로 수렴해야 한다(story #2511 AC1, "카디르 #2890 동시성 하네스"
    재사용 — 진짜 크로스-커넥션 레이스, 같은 세션 mock이 아니다)."""
    import asyncio

    from app.services.org_subscription_checkout import CheckoutInProgress, checkout_subscription

    engine_a = create_async_engine(_ASYNC)
    engine_b = create_async_engine(_ASYNC)
    Session_a = async_sessionmaker(engine_a, expire_on_commit=False)
    Session_b = async_sessionmaker(engine_b, expire_on_commit=False)

    seed_engine = create_async_engine(_ASYNC)
    try:
        async with async_sessionmaker(seed_engine, expire_on_commit=False)() as seed_session:
            org_id = await _seed_org_with_members(seed_session, human_seats=3)
    finally:
        await seed_engine.dispose()

    # 승자만 Toss를 부른다(billing-key 발급 1회 + charge 1회) — 패자는 claim 실패로
    # issue_billing_key조차 도달 못 해야 하므로, 이 응답 목록이 2번 넘게 쓰이면(=패자도
    # Toss를 불렀다는 뜻) 즉시 StopIteration으로 실패한다.
    toss_billing_key_response = {
        "billingKey": "billing-key-plaintext-concurrent",
        "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
        "authenticatedAt": "2026-08-07T00:00:00+09:00",
    }
    toss_charge_response = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 59_000}

    async def _checkout_starter():
        async with Session_a() as session:
            try:
                return await checkout_subscription(
                    session, org_id=org_id, auth_key="ak-starter", tier="starter", billing_cycle="monthly",
                )
            except CheckoutInProgress:
                return "rejected"

    async def _checkout_team():
        async with Session_b() as session:
            try:
                return await checkout_subscription(
                    session, org_id=org_id, auth_key="ak-team", tier="team", billing_cycle="annual",
                )
            except CheckoutInProgress:
                return "rejected"

    try:
        with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
            side_effect=[toss_billing_key_response, toss_charge_response]
        )):
            result_a, result_b = await asyncio.gather(_checkout_starter(), _checkout_team())

        results = [result_a, result_b]
        winners = [r for r in results if r != "rejected"]
        losers = [r for r in results if r == "rejected"]
        assert len(winners) == 1  # 정확히 하나만 성공
        assert len(losers) == 1   # 정확히 하나만 거부(CheckoutInProgress)
        assert winners[0].status == "active"

        verify_engine = create_async_engine(_ASYNC)
        try:
            async with async_sessionmaker(verify_engine, expire_on_commit=False)() as verify_session:
                ledger_count = (
                    await verify_session.execute(
                        text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid AND entry_type='charge'"),
                        {"oid": org_id},
                    )
                ).scalar_one()
                assert ledger_count == 1  # 이중청구 안 됨(AC1 핵심)

                sub_count = (
                    await verify_session.execute(
                        text("SELECT COUNT(*) FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                    )
                ).scalar_one()
                assert sub_count == 1  # 구독도 1개로 수렴

                claim_state = (
                    await verify_session.execute(
                        text("SELECT checkout_claimed_at FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                    )
                ).scalar_one()
                assert claim_state is None  # 승자의 finally가 claim을 해제함(다음 checkout 안 막힘)
        finally:
            await verify_engine.dispose()
    finally:
        await engine_a.dispose()
        await engine_b.dispose()


@pytest.mark.anyio
async def test_checkout_stale_reclaimed_late_confirm_does_not_premature_activate_realdb():
    """#2511 — 카디르 재QA(codex, #2896 리뷰, 2026-08-07) CRITICAL 재현+fix 검증.

    시나리오: A(starter)가 claim한 直後 STALE_CLAIM_WINDOW를 넘겨(Toss charge 65초+
    issue 15초 정상 왕복만으로도 합이 근접·초과할 수 있음 — A는 죽은 게 아니라 그냥
    느린 것) B(team)가 claim을 정당하게 뺏어 자기 흐름을 진행 中(아직 자기 charge는
    confirm 前, status='pending')인데, 그 사이 A의 원래 charge가 뒤늦게 confirmed로
    돌아온다. fix 前엔 step④ activate UPDATE가 org_id로만 매칭해 A의 뒤늦은 confirm이
    B의 아직 미확定 tier 행을 소유권 재확認 없이 곧장 active로 밀어버렸다 — 그 뒤 B의
    실제 charge가 카드 거절로 실패해도(TossApiError) declined 경로는 status를 다시
    되돌리지 않으므로, "확정된 결제가 하나도 없는데 active"라는 영구 오염이 남는다.

    이 테스트는 정확히 그 타이밍을 asyncio.Event 3개로 결정론적으로 강제한다(진짜
    시간 경과 대신 STALE_CLAIM_WINDOW를 음수로 monkeypatch해 "이미 지남" 조건만
    재현 — 3분을 실제로 기다리지 않는다).

    카디르 재QA(codex, #2896 리뷰, 2026-08-07) — CI 20% 플레이키 재현+fix: 원래는
    billing-key issuance 단계만 코디네이션해 "A가 먼저 claim한다"는 전제를 코드가
    강제하지 않았다(asyncio.gather가 두 태스크의 claim UPSERT 순서까지 보장하진
    않음 — B가 먼저 claim하면 시나리오가 뒤집혀 assert가 반대로 실패). a_claimed
    이벤트로 "A의 claim이 이미 커밋됐다"를 B가 시작하기 前에 명시 확인시켜 claim
    경쟁 자체를 결정화한다(레이스에 안 기대는 재현)."""
    import asyncio
    from datetime import timedelta

    import app.services.org_subscription_checkout as checkout_module
    from app.services.org_subscription_checkout import CheckoutDeclined, checkout_subscription
    from app.services.payment.toss_adapter import TossApiError

    org_id = uuid.uuid4()
    engine_a = create_async_engine(_ASYNC)
    engine_b = create_async_engine(_ASYNC)
    Session_a = async_sessionmaker(engine_a, expire_on_commit=False)
    Session_b = async_sessionmaker(engine_b, expire_on_commit=False)

    seed_engine = create_async_engine(_ASYNC)
    try:
        async with async_sessionmaker(seed_engine, expire_on_commit=False)() as seed_session:
            # _seed_org_with_members는 매번 새 org_id를 만들어버리므로(여기선 미리 정한
            # org_id가 필요) 직접 멤버만 심는다.
            await seed_session.execute(
                text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
                {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
            )
            for _ in range(3):
                await seed_session.execute(
                    text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :uid, 'member')"),
                    {"id": uuid.uuid4(), "org_id": org_id, "uid": uuid.uuid4()},
                )
            await seed_session.commit()
    finally:
        await seed_engine.dispose()

    a_claimed = asyncio.Event()  # A의 claim UPSERT가 이미 커밋됐다(issue_billing_key는 claim 커밋 後에만 호출됨).
    b_ready = asyncio.Event()   # B가 claim(뺏기)+issuance까지 끝냈다 — A는 이제 진행해도 됨
    a_done = asyncio.Event()    # A가 자기 흐름(step④ 포함)을 완전히 끝냈다 — B는 이제 charge해도 됨
    charge_call_count = {"n": 0}

    async def _post_mock(self, path, *, json, timeout, op_label, idempotency_key=None):
        auth = json.get("authKey")
        if op_label == "billing key issuance" and auth == "ak-b-fast":
            b_ready.set()
            await a_done.wait()  # B는 A가 완전히 끝날 때까지 자기 charge를 미룬다.
            return {
                "billingKey": "billing-key-B", "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
        if op_label == "billing key issuance" and auth == "ak-a-slow":
            # issue_billing_key는 claim UPSERT+commit이 끝난 뒤에만 호출되므로, 여기
            # 도달했다는 것 자체가 "A의 claim이 이미 DB에 커밋됐다"는 명시 증거다.
            a_claimed.set()
            await b_ready.wait()  # A는 B가 claim을 뺏어갈 시간을 번다(=STALE_CLAIM_WINDOW 초과 흉내).
            return {
                "billingKey": "billing-key-A", "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
        if op_label == "charge":
            charge_call_count["n"] += 1
            if charge_call_count["n"] == 1:
                return {"paymentKey": f"pay-a-{uuid.uuid4()}", "totalAmount": json["amount"]}  # A — 뒤늦게 confirmed.
            raise TossApiError("CARD_DECLINED", "카드 거절", status_code=400)  # B — 실제로는 거절.
        raise AssertionError(f"unexpected _post call: op_label={op_label!r} json={json!r}")

    async def _run_a():
        result = await checkout_subscription(
            Session_a(), org_id=org_id, auth_key="ak-a-slow", tier="starter", billing_cycle="monthly",
        )
        a_done.set()
        return result

    async def _run_b():
        # #2511 CI 플레이키 fix(카디르/codex) — A의 claim이 이미 커밋된 뒤에야 B 자신의
        # claim 시도를 시작한다. claim UPSERT 순서 자체를 asyncio.gather의 스케줄링
        # 우연에 맡기지 않고 명시 이벤트로 결정화 — "B가 먼저 claim"하는 경우가 원천
        # 배제돼 시나리오가 뒤집힐 수 없다.
        await a_claimed.wait()
        with pytest.raises(CheckoutDeclined) as exc_info:
            await checkout_subscription(
                Session_b(), org_id=org_id, auth_key="ak-b-fast", tier="team", billing_cycle="monthly",
            )
        return exc_info.value

    try:
        with patch.object(checkout_module, "STALE_CLAIM_WINDOW", timedelta(seconds=-60)), \
             patch("app.services.payment.toss_adapter.TossAdapter._post", new=_post_mock):
            result_a, declined_b = await asyncio.gather(_run_a(), _run_b())

        # A 자신의 반환값도 «현재 org의 실제 상태»(pending — 더 이상 A 소유 아님)를 정직히
        # 반영한다. A의 charge_org 청구 자체는 confirmed로 남아 있고(별도 축, C4/환불
        # 대상) — 아래에서 billing_orders로 직접 확認한다.
        assert result_a.status == "pending"

        verify_engine = create_async_engine(_ASYNC)
        try:
            async with async_sessionmaker(verify_engine, expire_on_commit=False)() as verify_session:
                row = (
                    await verify_session.execute(
                        text("SELECT tier, status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                    )
                ).first()
                # 핵심 단정 — B의 실제 charge는 거절됐으므로 org의 최종 상태는 «확정된 결제
                # 없음»을 정직하게 반영해야 한다. A의 뒤늦은 confirm이 여기 status를
                # active로 밀어버리면(fix 前 버그) 이 assert가 깨진다.
                assert row.tier == "team"  # B의 claim이 마지막으로 쥔 tier(오염 없음)
                assert row.status == "pending"  # active로 오염되지 않음(fix 검증 핵심)

                confirmed_orders = (
                    await verify_session.execute(
                        text("SELECT COUNT(*) FROM billing_orders WHERE org_id=:oid AND status='confirmed'"),
                        {"oid": org_id},
                    )
                ).scalar_one()
                assert confirmed_orders == 1  # A의 charge 자체는 실제로 confirmed(별도 축)
        finally:
            await verify_engine.dispose()
    finally:
        await engine_a.dispose()
        await engine_b.dispose()


@pytest.mark.anyio
async def test_checkout_unexpected_exception_mid_flow_still_releases_claim_realdb():
    """#2511 — PO/카디르가 못박은 핵심 질문: "claim 성공 요청이 실패하면 claimed_at이
    풀려 재시도되나(락 영구 점유 함정)?" TossApiError(CheckoutDeclined로 잡히는 경로)
    말고 «완전히 예상 밖» 예외(여기선 compute_charge_amount가 던지는 RuntimeError로
    시뮬레이트 — issue_billing_key 다음·charge_org 前, 어떤 명시 except 절도 안 잡는
    지점)가 나도 finally가 release를 보장하는지, 그리고 release된 뒤 즉시 재시도가
    실제로 성공하는지까지 실DB로 실증한다."""
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session1:
            org_id = await _seed_org_with_members(session1, human_seats=3)

            toss_billing_key_response = {
                "billingKey": "billing-key-unexpected-1",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response]
            )), patch(
                "app.services.org_subscription_checkout.compute_charge_amount",
                new=AsyncMock(side_effect=RuntimeError("simulated unexpected mid-flow failure")),
            ):
                with pytest.raises(RuntimeError, match="simulated unexpected"):
                    await checkout_subscription(
                        session1, org_id=org_id, auth_key="ak-unexpected", tier="starter", billing_cycle="monthly",
                    )

            # 예외가 명시 except 어디에도 안 잡혔어도 claim은 release돼야 한다.
            claim_state = (
                await session1.execute(
                    text("SELECT checkout_claimed_at FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                )
            ).scalar_one()
            assert claim_state is None

        # release가 실제로 "다음 요청을 막지 않는지"까지 — 새 세션으로 즉시 재시도.
        async with Session() as session2:
            toss_charge_response = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 5_000}
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                retried = await checkout_subscription(
                    session2, org_id=org_id, auth_key="ak-retry", tier="starter", billing_cycle="monthly",
                )
            assert retried.status == "active"  # 영구 점유 함정 없음 — 재시도가 정상 완결됨
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_sequential_different_tier_after_completion_blocked_by_active_paid_guard_realdb():
    """⛔#2511 AC2를 뒤집는다(페드루 P0 실측 지시, 2026-08-21, story a8fec107) — 이
    테스트는 원래 "1차 완결 後 다른 tier로 순차 재구독은 막지 않는다"를 의도된 동작으로
    고정하고 있었다. 그런데 그게 정확히 실 사고 경로였다: claim 해제(1차 완결) 後엔
    org가 이미 active+유료인 상태로 checkout_subscription에 다시 들어가면 기존 구독을
    pending으로 덮어쓰고 신 tier 전액을 재청구했다 — «막으면 안 된다»가 아니라 «막아야
    한다»가 맞는 판정이었다. ActivePaidSubscriptionExists(400)로 거부해야 한다."""
    from app.services.org_subscription_checkout import ActivePaidSubscriptionExists, checkout_subscription

    # 두 호출에 별개 세션을 쓴다 — 실제로도 서로 다른 HTTP 요청은 각자 새 세션을 받는다
    # (같은 세션을 재사용하면 expire_on_commit=False identity map이 1차 refetch 시
    # 캐싱한 객체를 2차 조회에서도 그대로 돌려줘 "진짜 DB 상태"가 아니라 "세션이 기억하는
    # 상태"를 검증하게 되는 착시가 생긴다 — 이 테스트가 검증하려는 건 claim 해제 그 자체).
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session1:
            org_id = await _seed_org_with_members(session1, human_seats=3)

            toss_billing_key_response = {
                "billingKey": "billing-key-seq-1",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response_1 = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 5_000}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response_1]
            )):
                sub1 = await checkout_subscription(
                    session1, org_id=org_id, auth_key="ak-seq-1", tier="starter", billing_cycle="monthly",
                )
            assert sub1.status == "active"
            assert sub1.tier == "starter"

        # 1차가 완전히 끝난 後(claim 해제됨) — 다른 tier로 순차 재구독(새 세션, 새 요청
        # 흉내). ⛔이제는 막혀야 한다 — Toss는 한 번도 안 불려야 함(side_effect를
        # 비워 둬서, 만약 다시 호출되면 StopAsyncIteration으로 즉시 실패한다).
        async with Session() as session2:
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(side_effect=[])):
                with pytest.raises(ActivePaidSubscriptionExists, match="change-tier"):
                    await checkout_subscription(
                        session2, org_id=org_id, auth_key="ak-seq-2", tier="team", billing_cycle="monthly",
                    )

            # 기존 starter 구독이 그대로 살아있어야 한다(덮어써지지 않음).
            row = (
                await session2.execute(text("SELECT tier, status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})
            ).first()
            assert row.tier == "starter"
            assert row.status == "active"

            charge_count = (
                await session2.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid AND entry_type='charge'"),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert charge_count == 1  # 2차 청구가 절대 나가지 않았어야 함(이중청구 방지 = 이 P0의 핵심)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_sequential_same_tier_after_completion_not_blocked_realdb():
    """P0 가드의 음성대조 — «같은» tier 재제출(더블클릭·네트워크 재시도)은 여전히
    막지 않는다(claim-supersede 무해 경로, story #2511 원 취지는 이 축에서만 유효)."""
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session1:
            org_id = await _seed_org_with_members(session1, human_seats=3)

            toss_billing_key_response = {
                "billingKey": "billing-key-same-tier",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 59_000}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                sub1 = await checkout_subscription(
                    session1, org_id=org_id, auth_key="ak-1", tier="team", billing_cycle="monthly",
                )
            assert sub1.status == "active"

        # 같은 org_id, 같은 tier로 재요청 — 오늘 날짜라 order_id가 같은 값으로 수렴,
        # DUPLICATED_ORDER_ID 조회 경로만 타야 하므로 billing-key 발급만 있고 charge
        # 호출은 없어야 한다(기존 계약 그대로).
        async with Session() as session2:
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response]
            )):
                sub2 = await checkout_subscription(
                    session2, org_id=org_id, auth_key="ak-2", tier="team", billing_cycle="monthly",
                )
            assert sub2.status == "active"
            assert sub2.tier == "team"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_not_blocked_for_non_active_status_cancelled_org_negative_control_realdb():
    """P0 가드의 두 번째 음성대조(페드루 AC③) — «취소 상태 org의 재결제»는 막으면 안
    되는 경계. story #2882(구독 취소)가 아직 없어 실제 'cancelled' 상태 전이 코드는
    없지만, 이 가드 자체의 판정 로직(status=='active'만 막는다, 그 외 어떤 비-active
    값이든 통과)을 직접 seed로 실증한다 — #2882가 실제로 그 상태를 쓰게 될 때 이 가드가
    자동으로 올바르게 열려 있을 것을 보장."""
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_members(session, human_seats=3)
            offering_id = (
                await session.execute(
                    text("SELECT id FROM offering_versions WHERE tier='starter' AND currency='krw' AND effective_to IS NULL")
                )
            ).scalar_one()
            await session.execute(
                text(
                    "INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, currency, provider, offering_version_id) "
                    "VALUES (:id, :org_id, 'starter', 'monthly', 'cancelled', 'krw', 'toss', :oid)"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "oid": offering_id},
            )
            await session.commit()

            toss_billing_key_response = {
                "billingKey": "billing-key-cancelled-resub",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 59_000}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                sub = await checkout_subscription(
                    session, org_id=org_id, auth_key="ak-resub", tier="team", billing_cycle="monthly",
                )
            assert sub.status == "active"
            assert sub.tier == "team"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_same_tier_different_billing_cycle_blocked_realdb():
    """⛔P0 후속(페드루 실측 지적, 2026-08-21 — 카디르 QA 中) — 같은 tier인데 cycle만
    다른 재제출(예: starter monthly active → 같은 날 starter annual checkout)은 tier만
    비교하면 안 걸린다. offering_version_id가 cycle과 무관(한 tier의 monthly/annual
    가격이 같은 행에 있음)이라 `_checkout_order_id`가 1차 charge와 order_id 충돌 →
    charge_org가 기존 confirmed order를 재사용(Toss 재호출 없음)한 채 구독만
    billing_cycle='annual'로 갱신되는 실 재현(디디 직접 확認, 2026-08-21) — 이중청구가
    아니라 «월납 가격에 연납 권리 획득»(반대방향 매출 누수)이었다. 이제 cycle도 비교
    대상이라 이 경로가 막혀야 한다."""
    from app.services.org_subscription_checkout import ActivePaidSubscriptionExists, checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session1:
            org_id = await _seed_org_with_members(session1, human_seats=3)

            toss_billing_key_response = {
                "billingKey": "billing-key-cycle-1",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response_1 = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 5_000}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response_1]
            )):
                sub1 = await checkout_subscription(
                    session1, org_id=org_id, auth_key="ak-cycle-1", tier="starter", billing_cycle="monthly",
                )
            assert sub1.status == "active"
            assert sub1.billing_cycle == "monthly"

        # 같은 tier, 다른 cycle(annual) — 이제 막혀야 한다. Toss는 한 번도 다시 안 불려야
        # 함(side_effect 비움 — 다시 호출되면 StopAsyncIteration으로 즉시 실패).
        async with Session() as session2:
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(side_effect=[])):
                with pytest.raises(ActivePaidSubscriptionExists, match="change-tier"):
                    await checkout_subscription(
                        session2, org_id=org_id, auth_key="ak-cycle-2", tier="starter", billing_cycle="annual",
                    )

            row = (
                await session2.execute(text("SELECT tier, billing_cycle, status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})
            ).first()
            assert row.tier == "starter"
            assert row.billing_cycle == "monthly"  # cycle이 덮어써지지 않음
            assert row.status == "active"

            charge_count = (
                await session2.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid AND entry_type='charge'"),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert charge_count == 1  # 원 monthly charge 하나만 — 매출 누수도 이중청구도 없음
    finally:
        await engine.dispose()
