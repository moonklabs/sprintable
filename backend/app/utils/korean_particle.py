"""story #4120(PO 실측, 2026-09-21) — gate_service.py:2093의 `f"v{version_number}이/가 ..."`
꼴이 raw 조사 플레이스홀더를 그대로 화면에 흘렸다(BE에는 이 헬퍼가 없었다, grep 0). FE
`apps/web/src/lib/korean-particle.ts`의 pickIGaJosa와 동일 근거(완성형 한글 종성 유무는
예외 없는 기계적 규칙) · 동일 숫자 읽기 표(마지막 자리 숫자의 고유한 소리 — 자릿수가
아니다) — 새 원천을 만들지 않고 FE 정본을 BE로 그대로 미러한다.
"""
from __future__ import annotations

_HANGUL_BASE = 0xAC00
_HANGUL_LAST = 0xD7A3
_JONGSEONG_COUNT = 28

# 한글 숫자 읽기(마지막 자리): 영=ㅇ받침·일=ㄹ받침·이=받침없음·삼=ㅁ받침·사=받침없음·
# 오=받침없음·육=ㄱ받침·칠=ㄹ받침·팔=ㄹ받침·구=받침없음 — FE korean-particle.ts
# DIGIT_HAS_BATCHIM과 동일 표(발명 0).
_DIGIT_HAS_BATCHIM = {
    "0": True, "1": True, "2": False, "3": True, "4": False,
    "5": False, "6": True, "7": True, "8": True, "9": False,
}


def _has_batchim(word: str) -> bool:
    """완성형 한글 종성(예외 없는 기계 규칙) → 숫자 마지막 자리 읽기(위 표) → 그 외
    (영문 등) 받침 없음으로 안전 폴백, 순서로 받침 유무를 판정한다."""
    trimmed = word.strip()
    if not trimmed:
        return False
    last_char = trimmed[-1]
    code = ord(last_char)
    if _HANGUL_BASE <= code <= _HANGUL_LAST:
        offset = code - _HANGUL_BASE
        return offset % _JONGSEONG_COUNT != 0
    if last_char in _DIGIT_HAS_BATCHIM:
        return _DIGIT_HAS_BATCHIM[last_char]
    return False


def pick_i_ga_josa(word: str) -> str:
    """받침 유무에 따른 "이"/"가". 완성형 한글이 아니고 숫자도 아니면(영문 등) 받침 없는
    것과 동일하게 "가"를 반환한다(모르면 안전한 쪽, FE pickIGaJosa와 동형 원칙)."""
    return "이" if _has_batchim(word) else "가"
