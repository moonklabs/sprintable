"""story #2446 — k6 ramping-arrival-rate 프로파일의 기대 iteration 개수 계산.

왜 필요한가(실측으로 발견, 2026-08-04): k6 summary export의 `iterations.rate` 는
**런 전체 시간**(램프업+hold+램프다운) 평균이다. ramping-arrival-rate 는 램프 구간
동안 rate를 선형 보간하므로 그 구간의 평균 실효 rate는 (시작+끝)/2 — hold 구간의
목표 rate보다 항상 낮다. 그래서 hold 구간에서 생성기가 목표를 «정확히» 달성해도
`iterations.rate`(전체평균)는 목표보다 20~30% 낮게 찍힌다 — 이걸 그대로
「생성기 기아」로 오판하면 정상 생성기를 잘못 kill한다(실측: TARGET=300 self-check,
achieved rate=308/s(전체평균) vs attempted=360/s → naive 비교로는 86%로 FAIL, 그러나
실제 iteration 개수는 기대치의 99.98%로 사실상 완벽했다).

⇒ rate 대 rate 비교 대신, achieved iteration **개수**를 이 함수가 계산한 «기대
개수»(램프 사다리꼴 적분)와 비교한다.
"""
from __future__ import annotations

import sys


def parse_duration_seconds(s: str) -> float:
    s = s.strip()
    if s.endswith("ms"):
        return float(s[:-2]) / 1000
    if s.endswith("s"):
        return float(s[:-1])
    if s.endswith("m"):
        return float(s[:-1]) * 60
    if s.endswith("h"):
        return float(s[:-1]) * 3600
    return float(s)


def expected_iterations(ramp_up_s: float, hold_s: float, ramp_down_s: float, rate: float) -> float:
    """0→rate(램프업) + rate 상수(hold) + rate→0(램프다운) 사다리꼴 적분."""
    return rate * (0.5 * ramp_up_s + hold_s + 0.5 * ramp_down_s)


if __name__ == "__main__":
    ramp_up, hold, ramp_down, rate = sys.argv[1:5]
    print(
        expected_iterations(
            parse_duration_seconds(ramp_up),
            parse_duration_seconds(hold),
            parse_duration_seconds(ramp_down),
            float(rate),
        )
    )
