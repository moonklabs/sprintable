"""story #4258 — 레시피 실패 통지의 «표에 있는 코드» 사유 문장이 발행물 목록 실패 배지(FE)와 같은 말인지 고정(유나 짝 테스트).

같은 사실(예: YouTube 사용량 소진)을 배지와 통지가 다른 말로 하지 않게 — FE `CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS`의
코드 집합과 BE `_RECIPE_PUBLISH_FAILED_MAPPED_REASONS`의 코드 집합이 같고, 각 코드의 문장이 «사유: » 머리만 빼고 ko · en 둘 다
같아야 한다. 한쪽만 바뀌면 RED.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_FE_MAP = _REPO / "apps/web/src/components/content/failure-action.ts"
_PREFIX = {"ko": "사유: ", "en": "Reason: "}


def _fe_reason_keys() -> dict[str, str]:
    source = _FE_MAP.read_text(encoding="utf-8")
    block = re.search(r"CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS[^=]*=\s*\{(.*?)\};", source, re.S)
    assert block is not None, "FE 사유 키 표를 못 찾았다"
    return dict(re.findall(r"([A-Z_]+):\s*'([A-Za-z0-9_]+)'", block.group(1)))


def test_mapped_reason_codes_are_the_same_set_as_the_fe_badge_table():
    from app.routers.events import _RECIPE_PUBLISH_FAILED_MAPPED_REASONS

    assert set(_RECIPE_PUBLISH_FAILED_MAPPED_REASONS) == set(_fe_reason_keys())


def test_mapped_reason_sentences_match_the_fe_badge_sentences_in_both_locales():
    from app.routers.events import _RECIPE_PUBLISH_FAILED_MAPPED_REASONS
    from app.services.i18n_catalog import t

    fe_keys = _fe_reason_keys()
    for locale in ("ko", "en"):
        messages = json.loads((_REPO / f"apps/web/messages/{locale}.json").read_text(encoding="utf-8"))["content"]
        for code, be_key in _RECIPE_PUBLISH_FAILED_MAPPED_REASONS.items():
            be_sentence = t(be_key, locale)
            assert be_sentence.startswith(_PREFIX[locale]), be_sentence
            assert be_sentence[len(_PREFIX[locale]):] == messages[fe_keys[code]], (locale, code)
