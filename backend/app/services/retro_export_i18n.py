"""story #3778(BE·소형, 페드루 PO 決 2026-09-10) — 회고 「내보내기」 마크다운 문서
낱말표(ko/en). `backend/app/routers/retros.py::export_session`이 이 파일만 보고
문서를 짓는다 — 문서 안에 낱말을 직접 박지 않는다(정본 한 곳).

phase 라벨(`RETRO_PHASE_LABEL`)은 apps/web/messages/{ko,en}.json의
`retro.stageCollect`/`stagePriority`/`stageAction`/`stageClosed` 값을 그대로
옮겨 적었다(2026-09-10 실측 — FE `retro/[id]/page.tsx::STAGE_TO_PHASE`가
DB phase `vote`를 화면 stage `priority`로 맵핑하는 것까지 반영, 그래서 키가
`vote`인데 라벨은 "우선순위"다). `backend/tests/test_3778_retro_export_i18n.py`
가 FE 카탈로그 값과 이 dict 값이 갈리면 RED(카디르 QA 요청) — 화면 쪽 낱말이
바뀌면 이 dict도 같이 바뀌어야 한다는 신호.

action 상태(open/done) 라벨은 화면에 대응하는 낱말이 없다(실측 확認 —
`retro/[id]/page.tsx`는 `isDone` boolean으로 체크박스만 토글하고 텍스트 라벨을
안 그린다, 집계 배지 `actionProgress`의 "완료"만 done 쪽에 재사용 가능했다).
"진행 중"/"In Progress"는 이 문서 전용으로 새로 짓는다 — 재사용할 화면 낱말
자체가 없는 자리(PO 判 AC2 "화면 낱말을 먼저 찾아 쓴다"는 done에는 적용했고,
open은 찾은 결과가 0건이라 신규가 불가피했다는 뜻으로 코드에 남긴다).
"""
from __future__ import annotations

_DEFAULT_LOCALE = "ko"
SUPPORTED_LOCALES = ("ko", "en")

# FE apps/web/messages/{ko,en}.json retro.stage* 그대로(2026-09-10 실측).
RETRO_PHASE_LABEL: dict[str, dict[str, str]] = {
    "collect": {"ko": "수집", "en": "Collect"},
    "vote": {"ko": "우선순위", "en": "Priority"},
    "action": {"ko": "액션", "en": "Action"},
    "closed": {"ko": "완료", "en": "Closed"},
}

# 화면에 대응 낱말 없음(체크박스뿐) — 이 문서 전용 신규.
ACTION_STATUS_LABEL: dict[str, dict[str, str]] = {
    "open": {"ko": "진행 중", "en": "In Progress"},
    "done": {"ko": "완료", "en": "Done"},
}

# story #3778 AC1(PO 決) — 병기 폐기, 문서 언어 하나로. Good/Bad/Improve는 원 소스의
# 한국어 절반(잘된 점/아쉬운 점/개선할 점)을 ko 쪽으로, 영어 절반(Good/Bad/Improve)을
# en 쪽으로 그대로 가져왔다(둘 다 원문에 이미 있던 말·신규 낱말 0). Action Items는
# 원문이 영어 전용이라 en은 그대로, ko는 화면 `actions`("🎯 액션 아이템")에서 이모지만
# 뺀 형(문서 톤은 나머지 셋과 맞춰 이모지 없음).
EXPORT_STRINGS: dict[str, dict[str, str]] = {
    "phase_prefix": {"ko": "**단계:**", "en": "**Phase:**"},
    "section_good": {"ko": "## 잘된 점", "en": "## Good"},
    "section_bad": {"ko": "## 아쉬운 점", "en": "## Bad"},
    "section_improve": {"ko": "## 개선할 점", "en": "## Improve"},
    "section_actions": {"ko": "## 액션 아이템", "en": "## Action Items"},
}


def resolve_export_locale(accept_language: str | None) -> str:
    """BFF(apps/web/.../retro-sessions/[id]/export/route.ts)가 next-intl `locale`
    쿠키 값을 그대로 Accept-Language에 실어 보낸다(브라우저 협상형 헤더 파싱 불필요
    — 이미 정규화된 단일 값). 미지원/누락은 ko 기본(화면 `src/i18n/request.ts`
    폴백과 동형 — 조직 기본값은 없는 개념이라 안 본다, PO 明示)."""
    if accept_language:
        normalized = accept_language.strip().lower()
        if normalized in SUPPORTED_LOCALES:
            return normalized
    return _DEFAULT_LOCALE


def phase_label(phase: str, locale: str) -> str:
    entry = RETRO_PHASE_LABEL.get(phase)
    if entry is None:
        return phase
    return entry.get(locale, entry[_DEFAULT_LOCALE])


def action_status_label(status: str, locale: str) -> str:
    entry = ACTION_STATUS_LABEL.get(status)
    if entry is None:
        return status
    return entry.get(locale, entry[_DEFAULT_LOCALE])


def export_string(key: str, locale: str) -> str:
    entry = EXPORT_STRINGS[key]
    return entry.get(locale, entry[_DEFAULT_LOCALE])


def votes_label(count: int, locale: str) -> str:
    """apps/web/messages/{ko,en}.json retro.votes 값 그대로(2026-09-10 실측:
    ko "{count}표"·en "{count} votes")."""
    if locale == "en":
        return f"{count} votes"
    return f"{count}표"
