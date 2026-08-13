"""story #2603 P0 — handle_mention_parser.py: @handle 텍스트 파싱 + 안정 handle 채번.

AC4 핵심 단언: 유사 이름·부분 문자열 오매칭이 없다(정확 일치만) + word-boundary(이메일
user@host를 멘션으로 오인 안 함) + 신규 handle 채번의 org-scope 유일성."""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_extract_handle_tokens_word_boundary_and_dedup():
    from app.services.handle_mention_parser import extract_handle_tokens

    # 이메일의 @host는 멘션이 아니다(바로 앞이 단어문자) — word-boundary가 걸러야.
    assert extract_handle_tokens("contact user@example.com for help") == []
    # 정상 멘션 + 중복(대소문자 다름)은 첫 표기만 1건.
    assert extract_handle_tokens("hey @mooncli-sprintable and @Mooncli-Sprintable again") == ["mooncli-sprintable"]
    # 문장부호로 끝나는 멘션 — 토큰 자체는 손상 없이 뽑힌다(뒤의 콤마/마침표는 \b 밖).
    assert extract_handle_tokens("cc @qa-bot, please review.") == ["qa-bot"]
    assert extract_handle_tokens("no mentions here") == []
    assert extract_handle_tokens("") == []


def test_slugify_handle_base_strips_non_ascii():
    from app.services.handle_mention_parser import slugify_handle_base

    assert slugify_handle_base("Mooncli Sprintable") == "mooncli-sprintable"
    assert slugify_handle_base("순한글이름") == ""  # 전부 비ASCII → 빈 문자열(호출부가 "agent" 폴백)
    assert slugify_handle_base("QA-Bot_2") == "qa-bot-2"


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


async def _seed_org(session, org_id):
    from app.models.organization import Organization
    session.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
    await session.commit()


async def _seed_agent(session, org_id, name, handle):
    from app.models.member import Member
    m = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name, handle=handle, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_resolve_handle_mentions_exact_match_only_no_substring():
    from app.services.handle_mention_parser import resolve_handle_mentions

    engine, Session = await _realdb_session()
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await _seed_org(s, org_id)
            qa_id = await _seed_agent(s, org_id, "QA Bot", "qa-bot")
            qa2_id = await _seed_agent(s, org_id, "QA Bot Two", "qa-bot-2")

        async with Session() as s:
            # "@qa-bot-2"를 부분 문자열로 "qa-bot"에 오매칭하면 안 된다(정확 일치만).
            hits = await resolve_handle_mentions(s, org_id=org_id, content="cc @qa-bot-2 please look")
            assert hits == {qa2_id}, "부분 문자열 오매칭 — @qa-bot-2가 qa-bot도 함께 잡으면 AC4 위반"

        async with Session() as s:
            hits = await resolve_handle_mentions(s, org_id=org_id, content="cc @qa-bot please look")
            assert hits == {qa_id}

        async with Session() as s:
            # 존재하지 않는 handle — 매치 0(존재-검사 필요 없이 WHERE 자체가 스코프).
            hits = await resolve_handle_mentions(s, org_id=org_id, content="cc @nonexistent-handle")
            assert hits == set()

        async with Session() as s:
            # 대소문자 무관 정확 일치.
            hits = await resolve_handle_mentions(s, org_id=org_id, content="cc @QA-BOT")
            assert hits == {qa_id}
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_resolve_handle_mentions_scoped_to_org_and_agent_type():
    from app.services.handle_mention_parser import resolve_handle_mentions
    from app.models.member import Member

    engine, Session = await _realdb_session()
    try:
        org_a = uuid.uuid4()
        org_b = uuid.uuid4()
        async with Session() as s:
            await _seed_org(s, org_a)
            await _seed_org(s, org_b)
            await _seed_agent(s, org_b, "Bot", "bot")  # 다른 org의 동일 handle
            human_id = uuid.uuid4()
            s.add(Member(id=human_id, org_id=org_a, type="human", name="Human Bot", handle="bot", is_active=True))
            await s.commit()
            agent_a_id = await _seed_agent(s, org_a, "Bot A", "bot")

        async with Session() as s:
            # org_a 안에서 "bot" handle이 human과 agent 둘 다 있어도(unique index는 실제로 이걸
            # 막지만, 여기선 순수 조회 스코프 검증이 목적) type='agent' 필터가 human을 제외한다.
            hits = await resolve_handle_mentions(s, org_id=org_a, content="@bot")
            assert agent_a_id in hits
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_generate_unique_handle_dedupes_within_org():
    from app.services.handle_mention_parser import generate_unique_handle

    engine, Session = await _realdb_session()
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await _seed_org(s, org_id)
            h1 = await generate_unique_handle(s, org_id=org_id, name="Mooncli Sprintable")
            assert h1 == "mooncli-sprintable"
            await _seed_agent(s, org_id, "Mooncli Sprintable", h1)

        async with Session() as s:
            h2 = await generate_unique_handle(s, org_id=org_id, name="Mooncli Sprintable")
            assert h2 == "mooncli-sprintable-2", "같은 org 내 base 충돌 시 -2 접미사로 해소해야"

        async with Session() as s:
            # 다른 org는 독립 — 충돌 없이 base 그대로.
            h3 = await generate_unique_handle(s, org_id=uuid.uuid4(), name="Mooncli Sprintable")
            assert h3 == "mooncli-sprintable"

        async with Session() as s:
            # 전부 비ASCII 이름 — "agent" 폴백.
            h4 = await generate_unique_handle(s, org_id=org_id, name="순한글이름")
            assert h4 == "agent"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


def test_handle_generation_never_exceeds_parser_capture_cap():
    """story #2608 후속(카디르 QA 발견, #2603 종결부) — 64자 초과 handle + 65번째 문자가
    하이픈인 엣지에서 파서가 긴 handle을 잘라 다른(짧은) 에이전트와 오매칭할 수 있었다.
    생성 측(slugify_handle_base)이 파서의 캡처 상한(_MAX_HANDLE_LEN)보다 항상 짧게 만들면
    이 클래스의 오매칭 자체가 구조적으로 불가능해진다."""
    from app.services.handle_mention_parser import (
        _MAX_HANDLE_LEN,
        _HANDLE_TOKEN_RE,
        slugify_handle_base,
    )

    very_long_name = "This Is An Extremely Long Agent Name That Goes Well Past Sixty Four Characters In Total Length"
    base = slugify_handle_base(very_long_name)
    assert len(base) < _MAX_HANDLE_LEN, "base 하나만으로도 이미 상한 밑이어야(접미사 여유 포함 전)"

    # -N 접미사가 붙어도(현실적 충돌 자릿수 내) 여전히 상한 밑 — 그래서 그 handle 전체를
    # "@" + handle로 써도 파서가 정확히 전체를 캡처할 수 있어야 한다(자기 자신을 완전히
    # 멘션 못 하는 handle이 생기면 안 됨).
    for suffix in ("", "-2", "-99"):
        candidate = f"{base}{suffix}"
        assert len(candidate) <= _MAX_HANDLE_LEN, f"{candidate!r} 길이 {len(candidate)}가 상한 초과"
        m = _HANDLE_TOKEN_RE.match(f"@{candidate} hello")
        assert m is not None and m.group(1) == candidate, (
            f"자기 자신을 완전히 캡처 못함 — {candidate!r}"
        )
