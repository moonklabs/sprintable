"""story #4202(E-RECIPE-2·i18n) — 플랫폼 마케팅 프리셋(event_definitions.org_id IS NULL · `preset.marketing.*`)
이름·설명의 로케일 문안 짝 가드. 실 PG(alembic heads) 기준이라 새 마케팅 프리셋 시드 마이그레이션이 들어오면
그 PR에서 자동으로 검사된다(4188 문구 가드 옆).

FE는 `apps/web/src/lib/platform-preset-copy.ts`의 두 표(PLATFORM_PRESET_NAME_KEY·…_DESCRIPTION_KEY)로 key →
messages `recipePreset.<키>`를 찾아 그린다. 표에 없는 key는 시드 원문(한국어)을 그대로 그리므로 누락이 곧
en 화면의 한국어다 — 그래서:
1. 시드 key 집합 == 두 표의 key 집합(양방향 — 시드에 없는 표 행도 낡은 행이라 RED).
2. 표가 가리키는 messages 키가 ko·en 둘 다 있고 비어 있지 않다.
3. ko 값 == 시드 원문(name·description) — 시드 문안이 바뀌면 ko 화면도 같이 바뀌어야 한다(두 곳이 갈리지 않게).
범위: `preset.marketing.*`만(유나 카드 «가드 범위»). 만료 조건: 워크플로우 프리셋 스토리(#4203) 착지 때 `preset.*`
사이클형으로 넓힌다.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_COPY_TS = _REPO_ROOT / "apps/web/src/lib/platform-preset-copy.ts"
_MESSAGES = {lang: _REPO_ROOT / f"apps/web/messages/{lang}.json" for lang in ("ko", "en")}
_NAMESPACE = "recipePreset"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _marketing_presets() -> dict[str, dict]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT key, name, description FROM event_definitions "
                "WHERE org_id IS NULL AND key LIKE 'preset.marketing.%' ORDER BY key"
            ))).mappings().all()
    finally:
        await engine.dispose()
    return {r["key"]: dict(r) for r in rows}


def _ts_table(table_name: str) -> dict[str, str]:
    src = _COPY_TS.read_text(encoding="utf-8")
    m = re.search(rf"const {table_name}: Record<string, string> = \{{(.*?)\n\}};", src, re.S)
    assert m, f"{_COPY_TS.name}에서 {table_name} 표를 못 찾음 — 표 이름/형태가 바뀌었으면 이 파서를 같이 고쳐라"
    table = dict(re.findall(r"^\s*'([^']+)'\s*:\s*'([^']+)'\s*,?\s*$", m.group(1), re.M))
    assert table, f"{table_name} 파싱 결과가 비었다"
    return table


def _messages(lang: str) -> dict:
    return json.loads(_MESSAGES[lang].read_text(encoding="utf-8")).get(_NAMESPACE, {})


def find_gaps(presets: dict[str, dict], names: dict[str, str], descriptions: dict[str, str],
              messages: dict[str, dict]) -> list[str]:
    gaps: list[str] = []
    seeded = set(presets)
    for label, table in (("NAME", names), ("DESCRIPTION", descriptions)):
        in_table = {k for k in table if k.startswith("preset.marketing.")}
        gaps += [f"{k}: PLATFORM_PRESET_{label}_KEY에 행 없음(en 화면에 한국어 원문)" for k in sorted(seeded - in_table)]
        gaps += [f"{k}: PLATFORM_PRESET_{label}_KEY 행이 시드에 없음(낡은 행)" for k in sorted(in_table - seeded)]
    for key, row in presets.items():
        for field, table in (("name", names), ("description", descriptions)):
            msg_key = table.get(key)
            if not msg_key:
                continue
            for lang, ns in messages.items():
                value = ns.get(msg_key)
                if not isinstance(value, str) or not value.strip():
                    gaps.append(f"{key} {field}: messages/{lang}.json {_NAMESPACE}.{msg_key} 없음/빈 값")
            seed = row.get(field) or ""
            if messages.get("ko", {}).get(msg_key) not in (None, seed):
                gaps.append(f"{key} {field}: ko 문안이 시드 원문과 다름 — 시드 {seed!r} / ko {messages['ko'].get(msg_key)!r}")
    return gaps


@pytest.mark.anyio
async def test_marketing_preset_keys_pair_with_messages_on_real_seed():
    presets = await _marketing_presets()
    # 양성 대조 — 시드가 비면 이 가드가 공허하게 통과한다.
    assert {"preset.marketing.video_production", "preset.marketing.social_card_news",
            "preset.marketing.social_text_post"} <= set(presets), sorted(presets)
    gaps = find_gaps(presets, _ts_table("PLATFORM_PRESET_NAME_KEY"), _ts_table("PLATFORM_PRESET_DESCRIPTION_KEY"),
                     {lang: _messages(lang) for lang in _MESSAGES})
    assert gaps == [], "\n".join(gaps)


def test_find_gaps_catches_each_failure_mode():
    """가드 자체 — 네 갈래(표 누락·낡은 표 행·messages 누락·ko≠시드)를 각각 잡는다."""
    presets = {"preset.marketing.a": {"key": "preset.marketing.a", "name": "가", "description": "가 설명"}}
    names = {"preset.marketing.a": "aName"}
    descs = {"preset.marketing.a": "aDescription"}
    ok = {"ko": {"aName": "가", "aDescription": "가 설명"}, "en": {"aName": "A", "aDescription": "A desc"}}
    assert find_gaps(presets, names, descs, ok) == []

    new_seed = {**presets, "preset.marketing.b": {"key": "preset.marketing.b", "name": "나", "description": ""}}
    assert any("preset.marketing.b: PLATFORM_PRESET_NAME_KEY에 행 없음" in g for g in find_gaps(new_seed, names, descs, ok))
    stale = {**names, "preset.marketing.gone": "goneName"}
    assert any("낡은 행" in g for g in find_gaps(presets, stale, descs, ok))
    no_en = {"ko": ok["ko"], "en": {"aName": "A"}}
    assert any("messages/en.json recipePreset.aDescription" in g for g in find_gaps(presets, names, descs, no_en))
    drift = {"ko": {"aName": "다른 이름", "aDescription": "가 설명"}, "en": ok["en"]}
    assert any("ko 문안이 시드 원문과 다름" in g for g in find_gaps(presets, names, descs, drift))
