"""story #3786(3779 3층 ①, 페드루 PO 判 2026-09-10 10:00Z) — BE 사용자 문장 공용 카탈로그.

story #3778의 `retro_export_i18n.py`(회고 내보내기 전용 미니 카탈로그)와 같은 형(dict 카탈로그 +
`resolve_locale`)을 **범용 모듈로 승격**한 것 — 새 기전 발명 금지, 이 위에 얹는다. 로케일
해석 자체는 재구현하지 않는다: E-I18N Phase C(story 11f1087c) `resolve_locale`/
`resolve_locale_from_request`(`app/services/agent_onboarding_config.py`)를 그대로 재사용한다.

## 사용 패턴 — Header DI는 라우트 경계에서만(까심 QA CI FAILURE 2026-07-08 원칙, `agents.py`
`get_agent_connection_artifact`/`_connection_artifact` 선례 그대로)
`Header()` DI 마커는 FastAPI ASGI 파이프라인을 통해서만 plain str/None으로 풀린다 — realdb/유닛
테스트처럼 라우터 함수를 **직접 호출**하면 `Header` 객체가 그대로 남아 크래시한다(HTTP 경로만
타는 QA로는 안 잡히는 클래스, 이 레포에서 이미 한 번 실사고). 그래서:
  - `@router.xxx` 데코레이터가 붙은 라우트 함수만 `locale: str | None = None` +
    `accept_language: str | None = Header(None, alias="Accept-Language")`를 받고,
    `resolve_locale_from_request(locale, accept_language)`로 즉시 풀어 plain str로 만든다.
  - 그 plain str만 서비스/헬퍼 함수로 내려보낸다(`Header()` 마커가 라우트 경계를 못 넘는다).

## 가드 2종(카드 明示)
  - 가드 1: ko/en 키 집합이 어긋나면(한쪽만 채워진 키) 테스트 RED — `test_3786_i18n_catalog.py`
    참조. 죽은 키(story #3765류) 재발 예방.
  - 가드 2: 카탈로그에 없는 키로 `t()`를 부르면 조용한 폴백 없이 즉시 예외 — 오타 키가
    "그냥 en으로 보인다"처럼 조용히 넘어가는 것을 막는다.
"""
from __future__ import annotations

from app.services.agent_onboarding_config import SUPPORTED_LOCALES, resolve_locale

__all__ = ["MessageCatalog", "UnknownMessageKeyError", "t"]


class UnknownMessageKeyError(KeyError):
    """카탈로그에 없는 key로 t()를 호출했다 — 가드 2. 조용한 폴백 대신 즉시 예외."""


# key → {locale: template}. `.format(**params)`로 렌더 — 지금 슬라이스 1의 모든 문자열은
# 파라미터가 없는 plain literal이라 params 없이도 그대로 반환된다(향후 슬라이스가 f-string
# 동적 값이 섞인 문장을 옮길 때 이 메커니즘을 그대로 재사용).
## ⛔en 문장 = 유나 定(PO 判, PO 뻐꾸기 금지) — 카드에 ko 원문 목록(키·ko·자리)을 올려
## 유나 답을 기다린다. en이 실 문장으로 채워지기 전까지 이 dict는 PENDING 마커로 남긴다.
## **PENDING_EN인 채로 머지 금지**(카드 明示) — 이 파일이 그 상태면 아직 미완성.
_PENDING_EN = "⛔PENDING_EN(유나 定 대기 — story #3786)"

_CATALOG: dict[str, dict[str, str]] = {
    # story #3786 슬라이스 1 — dependencies.py(8건, 고유 키 5개: "의존성을 찾을 수 없음"이
    # 4개 호출부에서 재사용됨).
    "dependencies.item_not_found": {
        "ko": "의존성 대상 아이템을 찾을 수 없음",
        "en": _PENDING_EN,
    },
    "dependencies.self_reference_not_allowed": {
        "ko": "자기참조 의존성은 허용되지 않음",
        "en": _PENDING_EN,
    },
    "dependencies.already_exists": {
        "ko": "이미 존재하는 의존성",
        "en": _PENDING_EN,
    },
    "dependencies.cycle_not_allowed": {
        "ko": "사이클이 발생하는 의존성은 허용되지 않음",
        "en": _PENDING_EN,
    },
    "dependencies.not_found": {
        "ko": "의존성을 찾을 수 없음",
        "en": _PENDING_EN,
    },
}


def t(key: str, locale: str, **params: object) -> str:
    """카탈로그 조회 + 렌더. `locale`은 이미 resolve_locale_from_request()를 거친 plain str이어야
    한다(이 함수 자신은 로케일을 재해석하지 않음 — 이중 해석 금지, SSOT는 Phase C 쪽 하나)."""
    entry = _CATALOG.get(key)
    if entry is None:
        # 개발자 대상 내부 에러(사용자 비노출) — 영문 고정: 1층 가드(verify_no_new_korean_
        # user_strings.py)가 app/ 전체를 한글 리터럴로 스캔하므로, 이 모듈 자신의 진단
        # 메시지에 한글을 쓰면 그 가드에 스스로 걸린다(2026-09-10 실측으로 발견).
        raise UnknownMessageKeyError(
            f"i18n_catalog: unregistered key {key!r} — register both ko/en in _CATALOG first."
        )
    resolved_locale = resolve_locale(locale)
    template = entry.get(resolved_locale, entry[resolved_locale])  # KeyError면 가드1 위반 신호
    return template.format(**params) if params else template


class MessageCatalog:
    """테스트 전용 접근자 — `_CATALOG`를 직접 import하지 않고 가드 테스트가 이 클래스를 통해서만
    검사하게 해, 카탈로그 내부 구조가 바뀌어도 가드 테스트 파일이 안 흔들리게 한다."""

    @staticmethod
    def keys() -> frozenset[str]:
        return frozenset(_CATALOG.keys())

    @staticmethod
    def locales_for(key: str) -> frozenset[str]:
        return frozenset(_CATALOG[key].keys())

    @staticmethod
    def all_entries() -> dict[str, dict[str, str]]:
        return {k: dict(v) for k, v in _CATALOG.items()}


assert set(SUPPORTED_LOCALES) == {"ko", "en"}, (
    "i18n_catalog assumes SUPPORTED_LOCALES is exactly {ko,en} — if Phase C ever adds a "
    "locale, this module's guard-1 logic must be updated too (would silently drift otherwise)."
)
