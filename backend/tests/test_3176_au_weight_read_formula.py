"""story #3176 선행조건②(설계 doc `au-metering-phase2-prereq-3176` §2) — 읽기 100개 초과
AU 계측 공식 pin. `X-Result-Count` 헤더 파싱(`_result_count`)과 그 값을 AU로 환산하는
`_au_weight_for` 읽기 분기(`1 + floor(max(0, N-100)/100)`, doc §2에 명시된 정확히 그 공식 —
floor이지 ceiling이 아니다)를 실 DB 없이 순수 함수로 고정한다.

경계값 표(floor 방식 — "100개 초과분 100개마다 +1", 부분블록은 다음 완주 전까지 카운트 안 함):
N∈[0,199] → 1AU 그대로(100 넘겨도 199까지는 아직 «완전한 추가 100블록»이 아님).
N∈[200,299] → 2AU(+1). N∈[300,399] → 3AU(+2). 경계 199/200이 이 파일의 핵심 pin.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.services.au_metering import AU_WEIGHTS, _au_weight_for, _result_count


def _response_with(headers: dict) -> MagicMock:
    resp = MagicMock()
    resp.headers = headers
    return resp


class TestResultCountParsing:
    def test_missing_header_returns_none(self):
        assert _result_count(_response_with({})) is None

    def test_empty_string_returns_none(self):
        assert _result_count(_response_with({"X-Result-Count": ""})) is None

    def test_non_numeric_returns_none(self):
        assert _result_count(_response_with({"X-Result-Count": "not-a-number"})) is None

    def test_negative_returns_none(self):
        """음수는 파싱 성공해도 안전측 폴백(None→flat 1AU) — 있을 수 없는 값을 신뢰하지 않는다."""
        assert _result_count(_response_with({"X-Result-Count": "-5"})) is None

    def test_zero_is_valid(self):
        assert _result_count(_response_with({"X-Result-Count": "0"})) == 0

    def test_positive_integer_parses(self):
        assert _result_count(_response_with({"X-Result-Count": "250"})) == 250


class TestReadWeightFormula:
    """헤더 없음(폴백) + 경계값 3구간(§4.5 100개 단위)을 전부 고정."""

    @pytest.mark.parametrize(
        "n,expected_au",
        [
            (0, 1),
            (1, 1),
            (99, 1),
            (100, 1),  # 정확히 100 — 아직 초과 아님.
            (101, 1),  # floor 방식: 100 넘겨도 199까지는 «완전한 추가 100블록»이 안 채워짐.
            (150, 1),
            (199, 1),  # 이 파일의 핵심 경계 — 여기까지는 여전히 1AU(ceiling이었으면 2AU였을 값).
            (200, 2),  # 200에서 정확히 +1 완주.
            (201, 2),
            (250, 2),
            (299, 2),
            (300, 3),  # 300에서 정확히 +1 더 완주.
            (301, 3),
            (400, 4),
        ],
    )
    def test_get_weight_with_result_count_header(self, n, expected_au):
        response = _response_with({"X-Result-Count": str(n)})
        assert _au_weight_for("GET", response) == expected_au

    def test_get_weight_without_header_falls_back_to_flat_read(self):
        response = _response_with({})
        assert _au_weight_for("GET", response) == AU_WEIGHTS["read"] == 1

    def test_head_method_also_uses_result_count(self):
        """§4.5 read 축은 GET·HEAD 공통 — HEAD도 동일 공식."""
        response = _response_with({"X-Result-Count": "250"})
        assert _au_weight_for("HEAD", response) == 2

    def test_malformed_header_falls_back_to_flat_read(self):
        response = _response_with({"X-Result-Count": "garbage"})
        assert _au_weight_for("GET", response) == 1

    def test_write_methods_unaffected_by_result_count_header(self):
        """X-Result-Count는 읽기 전용 축 — 쓰기 분기는 여전히 X-Affected-Entities만 본다."""
        response = _response_with({"X-Result-Count": "9999"})
        assert _au_weight_for("POST", response) == AU_WEIGHTS["write"] == 5
