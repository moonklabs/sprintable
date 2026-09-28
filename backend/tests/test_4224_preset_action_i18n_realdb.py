"""story #4224(까디르 QA 4588 [P2] · PO 23:25Z) — 플랫폼 프리셋 단계의 에이전트 지시 en(`stage_metadata[stage].action_i18n.en`)이
ko 시드 action의 도구·게이트·필드 이름(영문 토큰)을 전부 유지하는지 — 화면용 문안으로 바꿨더니 `doc_approval` · `loop_artifacts` ·
`outcome_snapshot`이 빠진 퇴행의 재발 가드. migrated(heads) DB의 실제 행을 본다."""
from __future__ import annotations

import os
import re

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_HANGUL = re.compile(r"[가-힣]")
_ASCII_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_/]*")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


def missing_code_tokens(ko: str, en: str) -> list[str]:
    """ko action 안의 영문 토큰(도구·게이트·필드 이름 등) 중 en에 없는 것 — 대소문자 무시 부분 일치."""
    low = en.lower()
    return [tok for tok in _ASCII_TOKEN.findall(ko) if tok.lower() not in low]


async def _platform_stages():
    """까디르 QA(b8353dfab [P2]) — 검사 대상을 0400 표가 아니라 **DB의 플랫폼 정의 전 단계**에서 직접 뽑는다(이후 마이그레이션이
    `action_i18n.en` 없는 플랫폼 프리셋을 넣으면 RED). 거르는 규칙 = 프리셋 key(`preset.*`) + org_id NULL + 사이클형(payload stage enum ·
    4202 짝 가드와 같은 판정). 신호형 프리셋은 stage_metadata가 `{}`라 단계가 없다."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT key, stage_metadata FROM event_definitions "
                "WHERE org_id IS NULL AND key LIKE 'preset.%' "
                "AND jsonb_typeof(payload_schema->'properties'->'stage'->'enum') = 'array'"
            ))).all()
    finally:
        await engine.dispose()
    return [(key, stage, meta) for key, sm in rows for stage, meta in (sm or {}).items() if isinstance(meta, dict)]


def find_problems(stages) -> list[tuple[str, str, str]]:
    problems = []
    for key, stage, meta in stages:
        ko = meta.get("action") or ""
        i18n = meta.get("action_i18n")
        en = (i18n.get("en") if isinstance(i18n, dict) else None) or ""
        if not en:
            problems.append((key, stage, "action_i18n.en 없음"))
            continue
        if _HANGUL.search(en):
            problems.append((key, stage, "en에 한글"))
        missing = missing_code_tokens(ko, en)
        if missing:
            problems.append((key, stage, f"en에 빠진 토큰 {missing}"))
    return problems


def test_token_check_positive_and_negative_control():
    assert missing_code_tokens("brief를 바탕으로 loop_artifacts로 등록", "Register variants from the brief as loop_artifacts") == []
    assert missing_code_tokens("doc_approval 게이트를 통과", "get it approved") == ["doc_approval"]
    assert missing_code_tokens("AC 체크리스트 검증 후 APPROVE/REJECT", "Verify the AC checklist, then approve") == ["APPROVE/REJECT"]


def test_find_problems_negative_controls():
    ok = ("preset.x", "s1", {"action": "doc_approval 게이트 통과", "action_i18n": {"en": "Pass the doc_approval gate"}})
    assert find_problems([ok]) == []
    # 새 프리셋 단계가 en 없이 들어옴(키 없음 · 객체 없음 · 객체 아님) → RED
    assert find_problems([("preset.new", "s1", {"action": "초안 작성"})]) == [("preset.new", "s1", "action_i18n.en 없음")]
    assert find_problems([("preset.new", "s1", {"action": "초안", "action_i18n": {"ko": "초안"}})])[0][2] == "action_i18n.en 없음"
    assert find_problems([("preset.new", "s1", {"action": "초안", "action_i18n": "x"})])[0][2] == "action_i18n.en 없음"
    assert find_problems([("preset.x", "s1", {"action": "초안", "action_i18n": {"en": "초안"}})])[0][2] == "en에 한글"


async def test_every_platform_stage_has_en_agent_action_keeping_code_tokens():
    stages = await _platform_stages()
    assert len(stages) >= 59, len(stages)  # 하한 — 시드가 사라져 공허 통과하지 않게
    # 양성 대조 — 0400 표 밖에서 뽑히는지(대상이 DB 전수): 알려진 사이클형 프리셋 둘이 실제로 잡힘.
    keys = {k for k, _s, _m in stages}
    assert {"preset.workflow.loop_agency", "preset.marketing.newsletter"} <= keys
    assert "preset.gate.verdict" not in keys  # 신호형(단계 없음)
    problems = find_problems(stages)
    assert problems == [], problems
