"""story #3778(페드루 PO 決 2026-09-10) — retro_export_i18n.py 단위 테스트 +
FE 카탈로그 대조(카디르 QA 요청, PO 判 AC2) — apps/web/messages/ko.json의
retro.stage*/retro.votes 값과 이 dict 값이 갈리면 RED. 화면 쪽 낱말이 바뀌었는데
이 dict를 안 고치면 「같은 것을 두 이름으로 부르는」 드리프트가 조용히 생긴다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.retro_export_i18n import (
    RETRO_PHASE_LABEL,
    action_status_label,
    export_string,
    phase_label,
    resolve_export_locale,
    votes_label,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KO_MESSAGES = _REPO_ROOT / "apps" / "web" / "messages" / "ko.json"
_EN_MESSAGES = _REPO_ROOT / "apps" / "web" / "messages" / "en.json"


class TestResolveExportLocale:
    def test_supported_values_pass_through(self) -> None:
        assert resolve_export_locale("ko") == "ko"
        assert resolve_export_locale("en") == "en"

    def test_case_and_whitespace_tolerant(self) -> None:
        assert resolve_export_locale(" EN ") == "en"

    def test_missing_or_unsupported_falls_back_to_ko(self) -> None:
        assert resolve_export_locale(None) == "ko"
        assert resolve_export_locale("") == "ko"
        assert resolve_export_locale("ja") == "ko"


class TestPhaseLabel:
    def test_known_phases_both_locales(self) -> None:
        assert phase_label("collect", "ko") == "수집"
        assert phase_label("collect", "en") == "Collect"
        # DB phase "vote" → 화면 stage "priority"(STAGE_TO_PHASE 맵핑, 3778 그라운딩).
        assert phase_label("vote", "ko") == "우선순위"
        assert phase_label("vote", "en") == "Priority"
        assert phase_label("action", "ko") == "액션"
        assert phase_label("closed", "en") == "Closed"

    def test_unknown_phase_passes_through_raw(self) -> None:
        """지어내지 않는다 — 모르는 값은 원문 그대로(resolveRoleLabel과 동형 방어)."""
        assert phase_label("mystery", "ko") == "mystery"


class TestActionStatusLabel:
    def test_known_statuses_both_locales(self) -> None:
        assert action_status_label("open", "ko") == "진행 중"
        assert action_status_label("open", "en") == "In Progress"
        assert action_status_label("done", "ko") == "완료"
        assert action_status_label("done", "en") == "Done"

    def test_unknown_status_passes_through_raw(self) -> None:
        assert action_status_label("archived", "en") == "archived"


class TestVotesLabel:
    def test_ko_en_forms(self) -> None:
        assert votes_label(3, "ko") == "3표"
        assert votes_label(3, "en") == "3 votes"

    def test_zero_votes(self) -> None:
        assert votes_label(0, "ko") == "0표"


class TestExportString:
    def test_section_headers_no_bilingual(self) -> None:
        """AC1(PO 決) — 병기 폐기, 언어당 한 낱말만."""
        assert export_string("section_good", "ko") == "## 잘된 점"
        assert export_string("section_good", "en") == "## Good"
        assert "Good" not in export_string("section_good", "ko")
        assert "잘된" not in export_string("section_good", "en")


# ── FE 카탈로그 대조(카디르 QA 요청) — 갈리면 RED ─────────────────────────────────

def _flat_messages(path: Path) -> dict[str, object]:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    out: dict[str, object] = {}

    def walk(obj: dict, prefix: str) -> None:
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                walk(v, key)
            else:
                out[key] = v

    walk(data, "")
    return out


_PHASE_TO_STAGE_KEY = {
    "collect": "stageCollect",
    "vote": "stagePriority",
    "action": "stageAction",
    "closed": "stageClosed",
}


@pytest.mark.parametrize("phase,stage_key", sorted(_PHASE_TO_STAGE_KEY.items()))
def test_phase_label_matches_fe_catalog_ko(phase: str, stage_key: str) -> None:
    ko = _flat_messages(_KO_MESSAGES)
    assert RETRO_PHASE_LABEL[phase]["ko"] == ko[f"retro.{stage_key}"], (
        f"backend/app/services/retro_export_i18n.py::RETRO_PHASE_LABEL['{phase}']['ko']가 "
        f"apps/web/messages/ko.json의 retro.{stage_key}와 갈렸다 — 화면 쪽이 바뀌면 "
        f"이 dict도 같이 고칠 것(정본은 화면)."
    )


@pytest.mark.parametrize("phase,stage_key", sorted(_PHASE_TO_STAGE_KEY.items()))
def test_phase_label_matches_fe_catalog_en(phase: str, stage_key: str) -> None:
    en = _flat_messages(_EN_MESSAGES)
    assert RETRO_PHASE_LABEL[phase]["en"] == en[f"retro.{stage_key}"]


def test_votes_label_matches_fe_catalog_shape() -> None:
    """정확한 문자열 비교는 {count} 보간이 있어 값 하나로는 안 되므로, count=1로
    두 정본이 같은 표현을 내는지로 대조한다."""
    ko = _flat_messages(_KO_MESSAGES)
    en = _flat_messages(_EN_MESSAGES)
    assert votes_label(1, "ko") == str(ko["retro.votes"]).replace("{count}", "1")
    assert votes_label(1, "en") == str(en["retro.votes"]).replace("{count}", "1")
