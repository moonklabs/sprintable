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

_DEFAULT_LOCALE = "en"  # story #3778 CHANGES(유나 design:changes) — 화면 정본(src/i18n/
# request.ts::getLocale()) DEFAULT_LOCALE과 동형. BE는 이 값에 도달할 일이 사실상 없다
# (BFF가 이제 getLocale() 결과를 항상 Accept-Language로 실어 보낸다 — route.ts 참고) —
# 그래도 BFF를 안 거치는 직접 호출(API 키 등)이 있을 수 있어 방어값 자체는 남긴다.
SUPPORTED_LOCALES = ("ko", "en")

# FE apps/web/messages/{ko,en}.json retro.stage* 그대로(2026-09-10 실측).
RETRO_PHASE_LABEL: dict[str, dict[str, str]] = {
    "collect": {"ko": "수집", "en": "Collect"},
    "vote": {"ko": "우선순위", "en": "Priority"},
    "action": {"ko": "액션", "en": "Action"},
    "closed": {"ko": "완료", "en": "Closed"},
}

# 화면에 대응 낱말 없음(체크박스뿐) — 이 문서 전용 신규.
#
# 유나 적기만(2026-09-10) — "완료"가 RETRO_PHASE_LABEL["closed"]["ko"]와 여기
# ["done"]["ko"] 둘 다에 나온다. 같은 글자지만 서로 다른 축(phase vs action status)의
# 각자 정본이 우연히 같은 낱말을 골랐을 뿐 — 한쪽이 바뀌어도 다른 쪽은 무변이다(예:
# phase closed를 "종료"로 바꿔도 action done="완료"는 그대로). 통합/치환 대상 아님.
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
    """BFF(apps/web/.../retro-sessions/[id]/export/route.ts)가 `src/i18n/
    request.ts::getLocale()`(화면과 동일 함수, 쿠키→Accept-Language 헤더→기본값 en
    순으로 해석하는 그 하나)의 결과 문자열을 그대로 Accept-Language에 실어 보낸다
    (브라우저 협상형 헤더 파싱이 이 함수의 일이 아니다 — 이미 정규화된 단일 값을
    받는다). 미지원/누락은 en 기본(화면과 동일 기본값 — 조직 기본값은 없는 개념이라
    안 본다, PO 明示). 유나 design:changes(2026-09-10) — 최초본은 "화면 폴백과
    동형"이라 적었으나 거짓이었다(BFF가 쿠키만 읽고 헤더 폴백을 안 태워 기본값이
    실제로 갈렸다·이 함수 docstring도 함께 정정)."""
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
