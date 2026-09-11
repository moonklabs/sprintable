"""story #3697(Phase2·FE, 유나 design CHANGES 격상 2026-09-08 10:11Z · 페드루 PO 確定) —
apps/web/src/components/insights-board/channel-declared-metrics.ts(FE 미러)가
backend/app/services/channel_adapters.py::CHANNEL_ADAPTERS[*].insight_metrics(BE 정본)의
수동 사본이다. 딸린 FE 단위테스트(channel-declared-metrics.test.ts)는 "TS 파일이 스스로
말하는 값"만 재는 사본↔사본 테스트라 BE가 갈려도 못 잡는다 — business-info.ts↔email.py
드리프트(story #3216)와 같은 클래스. 실제로 이 값들은 바뀌어 왔다(#3550 instagram
impressions→views 폐기 등) — "지금은 맞다"가 "계속 맞는다"를 보장하지 않는다.

⛔이 가드가 잡는 것: CHANNEL_ADAPTERS의 각 채널 insight_metrics 튜플(자구, 집합 비교 —
선언 순서는 우연이라 순서 차이는 드리프트가 아니다)과 FE CHANNEL_DECLARED_METRICS의
대응 배열이 다를 때만.

⛔이 가드가 **못 잡는 것**(자인):
1. 같은 채널 키가 (예: 주석 안에서) 두 번 이상 매치되면 dict 갱신 순서상 마지막 매치가
   조용히 채택된다(business-info.ts↔email.py 가드의 decoy 방어와 달리 이 축은 방어
   안 함) — 두 파일 모두 실제 타입(Python dict 리터럴·TS Record 리터럴)이라 진짜 중복
   키는 각 언어 자체 lint/타입체커가 이미 막는 자리이고, 주석 안에 우연히 똑같은 모양
   (`"key": ChannelAdapterConfig(` 또는 `key: ['...']`)이 나올 개연성은 낮다고 판단해
   scope를 좁혔다(과잉 방어 지양).
2. GA4 유입 지표(inflow_sessions/inflow_users)는 대조 대상이 아니다 — 어댑터 고정 선언이
   아니라 org GA4 연결 여부에 따른 런타임 값이라(channel-declared-metrics.ts 자체 주석
   참고) 두 파일 어느 쪽 튜플에도 그 이름이 안 나온다.

⭐카디르 QA 실측 정정(2026-09-08, PR#4049) — ①의 "추출실패=보수적 처리"는 처음엔 fails-
loud로 여겼으나 실은 **fails-silent 구멍**이었다: `find_drift`가 `backend.items()`로
«실제로 뽑힌 채널만» 순회하는 구조라, 파서가 채널 하나를 통째로 못 뽑으면(정규식이 그
채널의 선언 형태를 못 읽는 형태로 바뀜) 그 채널이 backend dict에 아예 없어 **비교 자체를
건너뛰고 조용히 green**이 났다 — 그 채널이 실제로 드리프트해도 파서가 못 보는 한 영원히
못 잡는다. `_assert_extraction_complete`가 이 구멍을 막는다: 파서가 뽑은 채널 집합이
`EXPECTED_BACKEND_CHANNELS`(9개, 아래) 전부를 커버하는지 매 호출마다 확認하고, 하나라도
빠지면 "채널 N개 중 M개만 봄=파싱 실패"로 즉시 예외(fail-loud) — fails-silent를
fails-closed로 바꾼다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CHANNEL_ADAPTERS_PY_PATH = Path(__file__).resolve().parent.parent / "app/services/channel_adapters.py"
CHANNEL_DECLARED_METRICS_TS_PATH = REPO_ROOT / "apps/web/src/components/insights-board/channel-declared-metrics.ts"

# 채널 등록 두 형태 — ①dict 리터럴(`"threads": ChannelAdapterConfig(`) ②조건부 런타임
# 등재(`CHANNEL_ADAPTERS["sandbox"] = ChannelAdapterConfig(`, dev 전용 SANDBOX_CHANNEL_
# ENABLED 블록). 둘 다 정적 텍스트 스캔이라 조건부 여부와 무관하게 잡힌다.
_CHANNEL_BLOCK_START_RE = re.compile(
    r'(?:^\s{4}"([a-z_]+)":\s*ChannelAdapterConfig\('
    r'|CHANNEL_ADAPTERS\["([a-z_]+)"\]\s*=\s*ChannelAdapterConfig\()',
    re.MULTILINE,
)


# channel_adapters.py에 실제로 등록된 채널 9개(2026-09-08 실측 — grep으로 재확認 가능:
# `grep -c 'ChannelAdapterConfig(' backend/app/services/channel_adapters.py`). 이 집합
# 자체가 바뀌면(새 채널 추가·기존 채널 삭제) 여기도 같이 고쳐야 한다 — 그 자체가
# "채널 목록이 바뀌었다"는 사실을 코드로 드러내는 지점이다(조용히 안 넘어간다).
EXPECTED_BACKEND_CHANNELS = frozenset({
    "threads", "instagram", "facebook", "facebook_sandbox", "hosted_site",
    "wordpress", "webhook", "sandbox", "instagram_sandbox",
    # story #3806(Phase3·3-2 PR1) — meta_ads/ads_sandbox 둘 다 insight_metrics
    # 미선언(빈 튜플 기본값·콘텐츠 발행 채널이 아니라 이 지표 축 자체가 안 맞음,
    # channel_adapters.py 항목 주석 참고) — extract_backend_declared_metrics가
    # []로 등재하고 find_drift도 FE 부재=[] 폴백이라 drift 0(신규 FE 등재 불요).
    "meta_ads", "ads_sandbox",
})


class ChannelExtractionIncompleteError(Exception):
    """파서가 EXPECTED_BACKEND_CHANNELS 중 일부를 못 뽑았다 — fails-silent 대신 fail-loud
    (카디르 QA, PR#4049)."""


def _assert_extraction_complete(backend_channels: dict[str, list[str]], expected: frozenset[str]) -> None:
    missing = expected - backend_channels.keys()
    if missing:
        raise ChannelExtractionIncompleteError(
            f"파서가 채널 {len(expected)}개 중 {len(expected) - len(missing)}개만 봤다"
            f"(놓친 채널: {sorted(missing)}) — 정규식이 그 채널의 선언 형태를 못 읽게 됐을 "
            "가능성이 높다(따옴표 스타일 변경 등). 이 상태로 드리프트 비교를 계속하면 놓친 "
            "채널은 검사 대상에서 조용히 빠진다(fails-silent) — 파서를 먼저 고칠 것."
        )


def _extract_paren_block(text: str, open_paren_pos: int) -> str:
    """open_paren_pos가 가리키는 '(' 부터 짝 맞는 ')' 까지(포함) 부분문자열(괄호 깊이 추적 —
    ChannelAdapterConfig(...) 안에 tuple 리터럴 등 중첩 괄호가 있어 "다음 채널까지"로
    자르면 안 된다)."""
    depth = 0
    for i in range(open_paren_pos, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren_pos : i + 1]
    return text[open_paren_pos:]


def extract_backend_declared_metrics(text: str) -> dict[str, list[str]]:
    """channel_adapters.py의 채널별 insight_metrics 튜플. insight_metrics= 자체가 없는
    채널(wordpress·webhook — dataclass 기본값 빈 튜플)은 빈 리스트로 등재한다(FE "모르는
    채널=빈 배열" 폴백과 대칭 — declaredMetricsForChannel 참고)."""
    result: dict[str, list[str]] = {}
    for m in _CHANNEL_BLOCK_START_RE.finditer(text):
        channel = m.group(1) or m.group(2)
        open_paren_pos = m.end() - 1  # 정규식이 매치를 '(' 로 끝맺는다
        block = _extract_paren_block(text, open_paren_pos)
        metric_match = re.search(r"insight_metrics\s*=\s*\(((?:[^()]|\([^()]*\))*)\)", block, re.DOTALL)
        result[channel] = [] if metric_match is None else re.findall(r'"([a-z_]+)"', metric_match.group(1))
    return result


def extract_frontend_declared_metrics(text: str) -> dict[str, list[str]]:
    """channel-declared-metrics.ts의 CHANNEL_DECLARED_METRICS 맵 자구를 그대로 뽑는다.
    맵에 아예 없는 채널은 이 함수 반환에도 없다 — find_drift가 BE 채널 목록을 기준으로
    순회하며 없으면 빈 리스트로 취급한다(declaredMetricsForChannel의 실제 폴백과 동형)."""
    result: dict[str, list[str]] = {}
    for m in re.finditer(r"^\s{2}([a-z_]+):\s*\[([^\]]*)\]", text, re.MULTILINE):
        channel, items = m.group(1), m.group(2)
        result[channel] = re.findall(r"'([a-z_]+)'", items)
    return result


def find_drift(
    backend_text: str, frontend_text: str, *, expected_channels: frozenset[str] = EXPECTED_BACKEND_CHANNELS,
) -> list[tuple[str, list[str], list[str]]]:
    """(channel, backend_metrics, frontend_metrics) 불일치 목록 — BE 채널 전수를 기준으로
    순회한다(BE가 정본이라 BE에 새 채널이 생기면 FE가 그걸 안 따라온 것도 이 순회가
    자동으로 잡는다). 비교 前 _assert_extraction_complete가 파서 자체의 완전성부터
    확認한다(fails-silent 백스톱, 카디르 QA) — expected_channels는 실물 호출(main())
    에선 EXPECTED_BACKEND_CHANNELS(9개) 기본값을 쓰고, 합성 fixture 테스트는 그 fixture가
    실제로 선언한 채널 집합을 넘겨 좁힌다(9개 전부를 요구하면 모든 합성 테스트가 매번
    9채널을 다 적어야 해 테스트 자체가 무거워진다)."""
    backend = extract_backend_declared_metrics(backend_text)
    _assert_extraction_complete(backend, expected_channels)
    frontend = extract_frontend_declared_metrics(frontend_text)
    drifted: list[tuple[str, list[str], list[str]]] = []
    for channel, be_metrics in backend.items():
        fe_metrics = frontend.get(channel, [])
        if set(be_metrics) != set(fe_metrics):
            drifted.append((channel, be_metrics, fe_metrics))
    return drifted


def main() -> int:
    backend_text = CHANNEL_ADAPTERS_PY_PATH.read_text(encoding="utf-8")
    frontend_text = CHANNEL_DECLARED_METRICS_TS_PATH.read_text(encoding="utf-8")
    try:
        drifted = find_drift(backend_text, frontend_text)
    except ChannelExtractionIncompleteError as exc:
        print(f"FAIL: {exc}")
        return 1
    if drifted:
        print(f"FAIL: channel_adapters.py ↔ channel-declared-metrics.ts insight_metrics 드리프트 {len(drifted)}건")
        for channel, be, fe in drifted:
            print(f"  {channel}: BE={sorted(be)} != FE={sorted(fe)}")
        print(
            "channel_adapters.py(insight_metrics)가 정본 — channel-declared-metrics.ts의 "
            "CHANNEL_DECLARED_METRICS를 거기 맞춰 정정할 것(story #3697)."
        )
        return 1
    print(f"OK: insight_metrics {len(extract_backend_declared_metrics(backend_text))}개 채널 전부 BE↔FE 일치")
    return 0


if __name__ == "__main__":
    sys.exit(main())
