"""story #3387 — 반려 사유 텍스트에서 «폐기/중단» 신호를 가리는 공용 판정 함수.

⛔단일 SSOT — story 5b00f0bc(넛지 억제, 아직 코드 없음)가 나중에 이 함수를 그대로
재사용한다(PO 2026-09-03 13:33Z). 두 벌로 나뉘면 같은 사유가 한쪽에서만 신호로 잡히는
순간이 온다 — 새로 짤 때 이 함수를 import하고, 여기 없는 새 판정을 그쪽에서 따로 만들지
않는다.

키워드 목록은 의도적으로 좁다(과탐 방지) — "폐기 대상"·"중단"·"금지"·"삭제" 계열만.
"수정 후 재상신 바랍니다" 같은 정상 반려 사유를 이 신호로 오분류하면 정반대 결함(침묵해야
할 곳에서 재상신을 권함)이 된다."""
from __future__ import annotations

import re

_DISCONTINUE_SIGNAL_RE = re.compile(r"폐기|중단|금지|삭제")


def has_discontinue_signal(reason_text: str | None) -> bool:
    """반려 사유에 «끝내라»는 신호가 있는가. None/빈 문자열은 신호 없음(False) — 사유가
    없으면 판정할 근거도 없다(지어내지 않는다)."""
    if not reason_text:
        return False
    return bool(_DISCONTINUE_SIGNAL_RE.search(reason_text))
