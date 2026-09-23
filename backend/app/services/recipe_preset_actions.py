"""story #4224 — 플랫폼 프리셋 stage action의 로케일 문안. 원천은 FE(`PLATFORM_PRESET_ACTION_KEY` + messages `recipePreset`)이고
이 모듈은 그 **생성 파생물** `app/i18n/recipe_preset_actions.json`만 읽는다. 생성·드리프트 가드는 FE 쪽 —
`apps/web/scripts/generate-recipe-preset-actions.ts`(`pnpm --filter web gen:recipe-preset-actions`) ·
`apps/web/scripts/recipe-preset-actions-backend.test.ts`(실제 표·문안을 import해 이 JSON과 대조 · 다르면 RED).

- 조직 커스텀 정의(org_id NOT NULL)·표에 없는 stage → 정의에 적힌 원문 그대로(FE `presetAction`과 같은 규칙).
- ko → 정의 원문 그대로(시드 action). FE ko 문안은 화면용으로 다듬은 말이라 16개가 시드와 다르고, 시드 쪽엔 에이전트에게
  필요한 도구 이름(loop_artifacts·doc_approval 등)이 들어 있다 — ko 에이전트 본문은 무변.
- en → 표의 en 문안(FE 화면과 같은 말).
"""
from __future__ import annotations

import json
from functools import cache
from pathlib import Path

_TABLE_PATH = Path(__file__).resolve().parents[1] / "i18n" / "recipe_preset_actions.json"

__all__ = ["localized_preset_action"]


@cache
def _table() -> dict[str, dict[str, str]]:
    return json.loads(_TABLE_PATH.read_text(encoding="utf-8"))


def localized_preset_action(*, definition_key: str, org_id: object, stage: str, raw_action: str, locale: str) -> str:
    if org_id is not None or locale == "ko":
        return raw_action
    entry = _table().get(f"{definition_key}:{stage}")
    return entry[locale] if entry and locale in entry else raw_action
