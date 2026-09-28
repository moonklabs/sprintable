"""story #4188(E-RECIPE-2·문구) — 플랫폼 프리셋(event_definitions.org_id IS NULL)의 사람 화면
노출 문구·라벨 가드. 실 PG(alembic heads) 기준이라 새 프리셋 시드 마이그레이션이 들어오면 그 PR에서
자동으로 검사된다.

1. 사용자 노출 문자열에 내부어 0 — 목록·이유는 아래 _FORBIDDEN(유나 확정 2026-09-23). 해제 조건:
   그 말이 제품 낱말로 채택될 때(유나 확정)만 줄을 지운다. «사용자 노출»의 범위(PR #4188 본문 AC1 표):
   - name: 모든 플랫폼 프리셋(이벤트 카탈로그 행 제목 `events/page.tsx:429`).
   - description: 사이클형 + 마케팅(`preset.marketing.*`, 갤러리가 사이클 여부와 무관하게 그린다).
   - description·stage_metadata[*].action: 사이클형(stage enum 있음) — 설정 템플릿 갤러리
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

# 라틴 약어는 대소문자 무시 + 영숫자 경계(앞뒤가 영문자·숫자가 아닐 때만) — «VOD» 같은 다른 낱말 오탐 방지.
# 한글과 바로 붙어도(«VO애니매틱») 잡도록 \b 대신 ASCII 영숫자 lookaround(파이썬 \b는 한글을 낱말 문자로 본다).
def _latin_abbr(word: str) -> str:
    return rf"(?i)(?<![A-Za-z0-9]){word}(?![A-Za-z0-9])"


# story #4204(까디르 QA · PR 4561) — 한자 판정 범위. 예전 `[一-鿿]`(U+4E00–9FFF)은 호환 한자(U+F900–FAFF — 한글 IME 한자
# 변환이 내기도 함)·확장 A(U+3400–)·확장 B 이후(U+20000–)를 못 잡았다. 파이썬 `re`엔 `\p{Ideographic}`이 없어(`regex` 모듈은
# 의존성에 없다 — 가드 하나 때문에 런타임 의존을 늘리지 않는다) CJK 한자 블록을 명시한다. 이 범위가 유니코드 DB의
# «CJK UNIFIED/COMPATIBILITY IDEOGRAPH» 전부를 덮는지는 test_cjk_ideograph_range_covers_unicode_db가 unicodedata로 잰다.
_CJK_IDEOGRAPH = (
    "["
    "\u3400-\u4DBF"            # 확장 A
    "\u4E00-\u9FFF"            # 통합 한자
    "\uF900-\uFAFF"            # 호환 한자
    "\U00020000-\U0002FA1F"    # 확장 B~F·I · 호환 보충
    "\U00030000-\U000323AF"    # 확장 G·H
    "]"
)


# (금지 패턴, 이유) — 유나 확정 목록(2026-09-23, story #4188 본문). «게이트»는 제품 화면 낱말이라 넣지 않는다.
_FORBIDDEN: list[tuple[str, str]] = [
    (_latin_abbr("BYOA"), "내부 전략 약어 — 고객 화면 낱말 아님"),
    (r"딸깍", "팀 은어(클릭 한 번) — «승인»으로 쓴다"),
    (r"전이", "팀 은어(상태 전환) — 화면은 «진행·넘어감»"),
    (r"실탄", "팀 은어(유료 생성 비용) — «유료 생성·생성 예산»"),
    (r"발사", "팀 은어(유료 생성 실행) — «실행»"),
    (r"표적", "팀 은어(생성 대상) — «생성 대상»"),
    (_latin_abbr("i2v"), "모델 약어(image-to-video) — «영상»"),
    # 까디르 QA(PR 4549): 0395가 푼 «VO»를 되돌려도 통과하던 구멍 — 유나가 action에서 «내레이션»으로 푼 것과 같은 판단.
    (_latin_abbr("VO"), "영문 약어(voice-over) — «내레이션»"),
    (r"레시피 \d+호", "내부 일련번호"),
    (_CJK_IDEOGRAPH, "한자 혼용(팀 채팅의 «확定»류)"),
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
    # 마케팅 갤러리(recipe-gallery.tsx:42)는 사이클 여부와 무관하게 description을 그린다(까디르 QA·PO 판단).
    if preset.get("description") and (_is_cyclic(preset) or preset["key"].startswith("preset.marketing.")):
        out.append(("description", preset["description"]))
    if _is_cyclic(preset):
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


def test_guard_catches_latin_abbreviations_case_insensitively_without_false_positives():
    """까디르 QA(PR 4549) 구멍 a — 0395가 지운 옛 «VO» 문구 복원을 잡고, 대소문자·한글 붙음도 잡되
    «VOD»·«NOVO» 같은 다른 낱말은 안 잡는다."""
    def hits(action: str) -> str:
        preset = {
            "key": "preset.marketing.x",
            "payload_schema": {"properties": {"stage": {"enum": ["s"]}}},
            "stage_metadata": {"s": {"role": "Creator", "action": action}},
        }
        return "\n".join(_find_violations([preset]))

    assert "VO" in hits("무과금 스틸+텍스트+VO 애니매틱 제작 후 구조 판정 요청")
    assert hits("vo 녹음")
    assert hits("VO애니매틱")
    assert hits("I2V 호출")
    assert hits("byoa 채택")
    assert hits("VOD 편집") == ""
    assert hits("NOVO 캠페인") == ""


def test_guard_scans_description_of_non_cyclic_marketing_preset():
    """까디르 QA(PR 4549) 구멍 b — 마케팅 갤러리는 사이클 여부와 무관하게 description을 그린다."""
    non_cyclic_marketing = {"key": "preset.marketing.y", "name": "이름", "description": "딸깍 한 번이면 끝"}
    assert "딸깍" in "\n".join(_find_violations([non_cyclic_marketing]))
    # 대조: 비사이클 신호형(마케팅 아님)의 description은 사람 화면 밖이라 그대로 제외.
    non_cyclic_signal = {"key": "preset.agent_run.x", "name": "이름", "description": "확定"}
    assert _find_violations([non_cyclic_signal]) == []


@pytest.mark.parametrize("sample", ["\uF90A", "\u3400", "\U00020000"], ids=["호환 한자 U+F90A", "확장 A U+3400", "확장 B U+20000"])
def test_cjk_guard_catches_compat_and_extension_ideographs(sample):
    """story #4204 — 예전 범위(U+4E00–9FFF)가 놓치던 세 부류를 잡는다."""
    found = _find_violations([{"key": "preset.x", "name": f"문구 {sample} 끝", "description": None,
                               "stage_metadata": {}, "block_template": None, "payload_schema": {}}])
    assert any("한자 혼용" in f for f in found), found


def test_cjk_guard_keeps_hangul_and_ascii_clean():
    """음성대조 — 한글·한글 자모·영문·기호는 걸리지 않는다(기존 통과 문구 무변)."""
    for text in ("영상 제작(릴스·쇼츠)", "ㄱㄴㄷ 자모", "Video production (Reels, Shorts)", "→ · « » — …"):
        assert not re.search(_CJK_IDEOGRAPH, text), text


def test_cjk_ideograph_range_covers_unicode_db():
    """범위 완전성 — 파이썬 유니코드 DB가 «CJK UNIFIED/COMPATIBILITY IDEOGRAPH»로 이름 붙인 모든 코드포인트를 이 패턴이 잡는다.
    새 확장(유니코드 버전 업)이 들어오면 여기서 RED — 범위를 넓히라는 신호."""
    import sys
    import unicodedata

    missing = []
    for cp in range(sys.maxunicode + 1):
        name = unicodedata.name(chr(cp), "")
        if name.startswith(("CJK UNIFIED IDEOGRAPH", "CJK COMPATIBILITY IDEOGRAPH")) and not re.match(_CJK_IDEOGRAPH, chr(cp)):
            missing.append(f"U+{cp:04X}")
    assert missing == [], f"{len(missing)}개 누락: {missing[:10]}"
