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


def _seeded_platform_keys() -> set[str]:
    """시드 마이그레이션이 만든 플랫폼 프리셋 key 집합 — 0400의 EN_ACTIONS가 그 목록이다(공유 DB엔 다른 테스트가 넣은 org_id NULL
    테스트 정의가 섞여 있어 «org_id NULL 전부»로는 못 가른다). 새 플랫폼 프리셋은 시드에 action_i18n을 싣고 이 목록에 들어가야 한다."""
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic/versions/0400_preset_stage_action_i18n_en.py"
    spec = importlib.util.spec_from_file_location("_mig_0400", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return {key for key, _stage in mod.EN_ACTIONS}


async def _platform_stages():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    keys = sorted(_seeded_platform_keys())
    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT key, stage_metadata FROM event_definitions "
                "WHERE org_id IS NULL AND key = ANY(:keys) AND stage_metadata IS NOT NULL"
            ), {"keys": keys})).all()
    finally:
        await engine.dispose()
    return [(key, stage, meta) for key, sm in rows for stage, meta in sm.items() if isinstance(meta, dict)]


def test_token_check_positive_and_negative_control():
    assert missing_code_tokens("brief를 바탕으로 loop_artifacts로 등록", "Register variants from the brief as loop_artifacts") == []
    assert missing_code_tokens("doc_approval 게이트를 통과", "get it approved") == ["doc_approval"]
    assert missing_code_tokens("AC 체크리스트 검증 후 APPROVE/REJECT", "Verify the AC checklist, then approve") == ["APPROVE/REJECT"]


async def test_every_platform_stage_has_en_agent_action_keeping_code_tokens():
    stages = await _platform_stages()
    assert len(stages) >= 59, len(stages)  # 하한 — 시드가 사라져 공허 통과하지 않게
    problems = []
    for key, stage, meta in stages:
        ko = meta.get("action") or ""
        en = ((meta.get("action_i18n") or {}).get("en")) or ""
        if not en:
            problems.append((key, stage, "action_i18n.en 없음"))
            continue
        if _HANGUL.search(en):
            problems.append((key, stage, "en에 한글"))
        missing = missing_code_tokens(ko, en)
        if missing:
            problems.append((key, stage, f"en에 빠진 토큰 {missing}"))
    assert problems == [], problems
