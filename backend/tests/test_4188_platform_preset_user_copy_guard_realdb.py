"""story #4188(E-RECIPE-2·문구) — 플랫폼 프리셋(event_definitions.org_id IS NULL)의 사람 화면
노출 문구·라벨 가드. 실 PG(alembic heads) 기준이라 새 프리셋 시드 마이그레이션이 들어오면 그 PR에서
자동으로 검사된다.

1. 사용자 노출 문자열에 내부어 0 — 목록·이유는 아래 _FORBIDDEN(유나 확정 2026-09-23). 해제 조건:
   그 말이 제품 낱말로 채택될 때(유나 확정)만 줄을 지운다. «사용자 노출»의 범위(PR #4188 본문 AC1 표):
   - name: 모든 플랫폼 프리셋(이벤트 카탈로그 행 제목 `events/page.tsx:429`).
   - description·stage_metadata[*].action: 사이클형(stage enum 있음)만 — 설정 템플릿 갤러리
     (`workflow-template-gallery-section.tsx:271`)·루프 생성 미리보기(`loop-create-dialog.tsx:335,341`)·
     레시피 갤러리(`recipe-gallery.tsx:42`)·카탈로그 단계 목록(`events/page.tsx:530`)이 전부 사이클형 필터
     뒤에 있다. 신호형 프리셋의 description은 사람 화면 렌더 경로가 없다(에이전트 온보딩 가이드
     `routers/events.py:2833-2835`·API 응답뿐).
   - block_template 문자열: 모든 플랫폼 프리셋(채팅 이벤트 카드 `event-block-card.tsx`·카탈로그 미리보기).
2. 화면 라벨 등재 — 두 FE 표 모두 미등재 값을 원시값 그대로 흘리는 pass-through 구조라 누락이 곧 원시값
   노출이다. 범위: 마케팅 레시피(`preset.marketing.*` — 갤러리·상세·적용 다이얼로그가 이 도메인만 그린다,
   `use-marketing-recipes.ts:31,59`)의 stage slug 전부 + 사이클형 프리셋 전체의 role. 워크플로 프리셋의
   stage slug는 제외 — 그 화면들은 slug 대신 action을 그리고(`events/page.tsx:530`·`loop-create-dialog.tsx:341`),
   «레시피 시작»은 미등재 slug를 «단계 n/N»으로 자리표시한다(`recipe-start-section.tsx:19-27`).
   BE→FE 연결은 FE 소스 파일을 직접 파싱한다: 프리셋은 마이그레이션으로만 늘고, 그 PR의 BE 테스트가
   곧바로 RED가 나야 라벨을 같은 PR에서 등록하게 된다(FE 쪽 스냅샷은 BE 시드와 따로 놀아 늦게 안다).
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_STAGE_LABEL_TS = _REPO_ROOT / "apps/web/src/lib/recipe-stage-label.ts"
_STAGE_ROLE_TS = _REPO_ROOT / "apps/web/src/lib/stage-role.ts"

# (금지 패턴, 이유) — 유나 확정 목록(2026-09-23, story #4188 본문). «게이트»는 제품 화면 낱말이라 넣지 않는다.
_FORBIDDEN: list[tuple[str, str]] = [
    (r"BYOA", "내부 전략 약어 — 고객 화면 낱말 아님"),
    (r"딸깍", "팀 은어(클릭 한 번) — «승인»으로 쓴다"),
    (r"전이", "팀 은어(상태 전환) — 화면은 «진행·넘어감»"),
    (r"실탄", "팀 은어(유료 생성 비용) — «유료 생성·생성 예산»"),
    (r"발사", "팀 은어(유료 생성 실행) — «실행»"),
    (r"표적", "팀 은어(생성 대상) — «생성 대상»"),
    (r"i2v", "모델 약어(image-to-video) — «영상»"),
    (r"레시피 \d+호", "내부 일련번호"),
    (r"[一-鿿]", "한자 혼용(팀 채팅의 «확定»류)"),
]


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _platform_presets() -> list[dict]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT key, name, description, stage_metadata, block_template, payload_schema "
                "FROM event_definitions WHERE org_id IS NULL AND key LIKE 'preset.%' ORDER BY key"
            ))).mappings().all()
    finally:
        await engine.dispose()
    return [dict(r) for r in rows]


def _strings(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return []


def _is_cyclic(preset: dict) -> bool:
    enum = (((preset.get("payload_schema") or {}).get("properties") or {}).get("stage") or {}).get("enum")
    return bool(enum)


def _user_facing_strings(preset: dict) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if preset.get("name"):
        out.append(("name", preset["name"]))
    if _is_cyclic(preset):
        if preset.get("description"):
            out.append(("description", preset["description"]))
        for stage, meta in (preset.get("stage_metadata") or {}).items():
            if isinstance(meta, dict) and isinstance(meta.get("action"), str):
                out.append((f"stage_metadata.{stage}.action", meta["action"]))
    for s in _strings(preset.get("block_template")):
        out.append(("block_template", s))
    return out


def _find_violations(presets: list[dict]) -> list[str]:
    found = []
    for p in presets:
        for field, value in _user_facing_strings(p):
            for pattern, reason in _FORBIDDEN:
                m = re.search(pattern, value)
                if m:
                    found.append(f"{p['key']} {field}: «{m.group(0)}»({reason}) in {value!r}")
    return found


def _ts_table_keys(path: Path, table_name: str) -> set[str]:
    src = path.read_text(encoding="utf-8")
    m = re.search(rf"const {table_name}: Record<string, string> = \{{(.*?)\n\}};", src, re.S)
    assert m, f"{path.name}에서 {table_name} 표를 못 찾음 — 표 이름/형태가 바뀌었으면 이 파서를 같이 고쳐라"
    keys = set(re.findall(r"^\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*:", m.group(1), re.M))
    assert keys, f"{table_name} 파싱 결과가 비었다"
    return keys


@pytest.mark.anyio
async def test_platform_preset_user_copy_has_no_internal_words():
    presets = await _platform_presets()
    assert any(p["key"] == "preset.marketing.video_production" for p in presets), "시드가 안 보임 — DB가 heads인지 확인"
    violations = _find_violations(presets)
    assert not violations, "플랫폼 프리셋 사용자 노출 문구에 내부어:\n" + "\n".join(violations)


@pytest.mark.anyio
async def test_platform_preset_stage_and_role_values_have_fe_labels():
    presets = await _platform_presets()
    stage_keys = _ts_table_keys(_STAGE_LABEL_TS, "STAGE_LABEL_KEYS")
    role_keys = _ts_table_keys(_STAGE_ROLE_TS, "STAGE_ROLE_KEY")
    missing = []
    for p in presets:
        if not _is_cyclic(p):
            continue
        marketing = p["key"].startswith("preset.marketing.")
        for stage, meta in (p.get("stage_metadata") or {}).items():
            if marketing and stage not in stage_keys:
                missing.append(f"{p['key']}: stage «{stage}» → recipe-stage-label.ts 미등재")
            role = meta.get("role") if isinstance(meta, dict) else None
            if role and role not in role_keys:
                missing.append(f"{p['key']}: role «{role}» → stage-role.ts 미등재")
    assert not missing, "FE 라벨 미등재(화면에 원시값이 뜬다):\n" + "\n".join(missing)


def test_guard_catches_old_video_copy():
    """뮤테이션 대조군 — 0381 옛 문구를 넣으면 반드시 걸린다(가드가 허수아비가 아님)."""
    old = {
        "key": "preset.marketing.video_production",
        "name": "영상 제작(릴스·쇼츠)",
        "description": "BYOA 영상 제작 레시피 1호 — 사람 게이트 4곳만 딸깍하고 나머지 전이는 에이전트가 진행.",
        "payload_schema": {"properties": {"stage": {"enum": ["concept_confirmed"]}}},
        "stage_metadata": {"concept_confirmed": {"role": "Director", "action": "미션 정합 확定 승인"}},
        "block_template": {"blocks": [{"type": "header", "text": "영상 제작 레시피"}]},
    }
    hits = "\n".join(_find_violations([old]))
    for word in ("BYOA", "레시피 1호", "딸깍", "전이", "定"):
        assert word in hits
