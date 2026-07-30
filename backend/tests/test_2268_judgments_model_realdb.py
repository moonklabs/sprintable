"""story #2268(D단계, E-CONNECT — "판단 칸") — `judgments` 모델/마이그레이션 실PG 검증.

여기선 스키마 레벨 불변식만 잰다(엔드포인트/서비스 계층은 별도 스토리로 배선 — 오르테가가
AC를 #2268에 박는 중, 이 PR은 그 위에 다른 사람이 안전하게 올릴 수 있는 기반만 세운다):
  ①kind 허용목록
  ②scope 허용목록
  ③scope↔work_item_ids 쌍 강제("아직 안 붙임"과 "어디에도 안 붙는 것"을 스키마가 가른다)
  ④㉡(retraction/refinement/method_error)의 target_id는 선택(2026-07-30부터 — 뒤집힘, 아래 참조)
  ⑤target_id는 judgments 자기참조 FK
  ⑥source_message_id(신설, 2026-07-30) — nullable, 값이 그대로 저장/왕복되는지
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy.exc import IntegrityError

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


def _judgment(**overrides):
    from app.models.judgment import Judgment
    org_id = overrides.pop("org_id", uuid.uuid4())
    created_by = overrides.pop("created_by", uuid.uuid4())
    defaults = dict(
        id=uuid.uuid4(), org_id=org_id, scope="general", work_item_ids=[],
        kind="judgment", target_id=None, method=None,
        statement="stmt", created_by=created_by,
    )
    defaults.update(overrides)
    return Judgment(**defaults)


# ─── ①kind 허용목록 ─────────────────────────────────────────────────────────


async def test_kind_outside_allowlist_rejected():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(kind="not_a_real_kind"))
            with pytest.raises(IntegrityError, match="ck_judgments_kind"):
                await s.commit()
    finally:
        await engine.dispose()


# ─── ②scope 허용목록 ────────────────────────────────────────────────────────


async def test_scope_outside_allowlist_rejected():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(scope="not_a_real_scope"))
            with pytest.raises(IntegrityError, match="ck_judgments_scope"):
                await s.commit()
    finally:
        await engine.dispose()


# ─── ③scope↔work_item_ids 쌍 강제 ───────────────────────────────────────────


async def test_general_scope_with_nonempty_work_item_ids_rejected():
    """"어디에도 안 붙는 것"(general)이라면서 work_item_ids를 채우는 건 모순 — 거절."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(scope="general", work_item_ids=[uuid.uuid4()]))
            with pytest.raises(IntegrityError, match="ck_judgments_scope_work_item_ids_pairing"):
                await s.commit()
    finally:
        await engine.dispose()


async def test_items_scope_with_empty_work_item_ids_rejected():
    """"특정 항목에 붙는다"(items)면서 work_item_ids가 비어 있는 건 "아직 안 붙인" 잘못된
    상태 — CHECK가 즉시 거절한다(오르테가 지적: 빈 배열을 추론하지 말고 선언으로 받는다)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(scope="items", work_item_ids=[]))
            with pytest.raises(IntegrityError, match="ck_judgments_scope_work_item_ids_pairing"):
                await s.commit()
    finally:
        await engine.dispose()


async def test_general_scope_with_empty_work_item_ids_accepted():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(scope="general", work_item_ids=[]))
            await s.commit()
    finally:
        await engine.dispose()


async def test_items_scope_with_work_item_ids_accepted():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(scope="items", work_item_ids=[uuid.uuid4(), uuid.uuid4()]))
            await s.commit()
    finally:
        await engine.dispose()


# ─── ④㉡ target_id 선택(2026-07-30부터, 오르테가 철회) ─────────────────────────


@pytest.mark.parametrize("kind", ["retraction", "refinement", "method_error"])
async def test_meta_kind_without_target_id_now_accepted(kind):
    """⛔뒤집힘(2026-07-30): target_id NOT NULL 강제를 CHECK에서 뺐다 — target_id는
    "이전 판정의 id"인데 처음 쓰는 사람은 이전 판정이 없어 가리킬 것이 없었다(순환).
    이 테스트는 예전엔 IntegrityError를 기대했다 — 지금은 정반대로 성공을 확認한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(kind=kind, target_id=None))
            await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.parametrize("kind", ["judgment", "unmeasurable"])
async def test_original_kind_without_target_id_accepted(kind):
    """㉠(원래 낸 말)은 target_id 없이도 스스로 선다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(kind=kind, target_id=None))
            await s.commit()
    finally:
        await engine.dispose()


async def test_meta_kind_with_target_id_accepted():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            original = _judgment(kind="judgment")
            s.add(original)
            await s.flush()
            s.add(_judgment(kind="retraction", target_id=original.id))
            await s.commit()
    finally:
        await engine.dispose()


# ─── ⑤target_id 자기참조 FK ─────────────────────────────────────────────────


async def test_target_id_referencing_nonexistent_judgment_rejected():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            s.add(_judgment(kind="retraction", target_id=uuid.uuid4()))
            with pytest.raises(IntegrityError, match="fk_judgments_target_id_judgments"):
                await s.commit()
    finally:
        await engine.dispose()


# ─── method 필드 ─────────────────────────────────────────────────────────────


async def test_method_error_stores_method_for_backtrace():
    """method_error가 "같은 방법으로 낸 다른 말들"을 역추적하려면 그 방법 자체를
    저장해야 한다 — method가 NULL이면 역추적 축이 애초에 존재하지 않는다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            original = _judgment(kind="judgment", method="grep-based scan")
            s.add(original)
            await s.flush()
            correction = _judgment(
                org_id=original.org_id, kind="method_error",
                target_id=original.id, method="grep-based scan",
            )
            s.add(correction)
            await s.commit()

            from sqlalchemy import select
            from app.models.judgment import Judgment
            rows = (
                await s.execute(
                    select(Judgment).where(
                        Judgment.org_id == original.org_id, Judgment.method == "grep-based scan",
                    )
                )
            ).scalars().all()
            assert {r.id for r in rows} == {original.id, correction.id}
    finally:
        await engine.dispose()


# ─── source_message_id(신설, 2026-07-30) ────────────────────────────────────


async def test_source_message_id_round_trips():
    """이 판정이 나온 채팅 메시지를 가리키는 nullable 컬럼 — "이미 적은 것을 다시 안 쓰게"
    하는 목적. FK 없음(느슨한 참조, 이 프로젝트 관례)."""
    engine, Session = await _session_factory()
    try:
        msg_id = uuid.uuid4()
        async with Session() as s:
            j = _judgment(kind="judgment", source_message_id=msg_id)
            s.add(j)
            await s.commit()
            row_id = j.id

        async with Session() as s:
            from sqlalchemy import select
            from app.models.judgment import Judgment
            row = (
                await s.execute(select(Judgment).where(Judgment.id == row_id))
            ).scalar_one()
            assert row.source_message_id == msg_id
    finally:
        await engine.dispose()


async def test_source_message_id_defaults_to_none():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            j = _judgment(kind="judgment")
            s.add(j)
            await s.commit()
            assert j.source_message_id is None
    finally:
        await engine.dispose()
