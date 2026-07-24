"""story #2178(2026-07-24): sprintable-realtime-dev가 backend-dev와 다른 Redis 플래그 세트로
돌고 있었는데 그 차이가 어디에도 선언된 적이 없었다 — #2158 회귀검증이 그 자리에서 막혔다
(record()는 backend-dev에서 정상이었는데, 실제 브라우저 SSE를 서빙하는 realtime-dev엔
SSE_TRANSIENT_REPLAY_ENABLED가 아예 없어 replay()가 그 서비스에서 한 번도 안 돎).

5종 전수를 코드 경로로 판정(값보다 "왜 다른지" 선언이 본체):
- SSE_TRANSIENT_REPLAY_ENABLED·SSE_LEASE_REDIS_ENABLED: 진짜 누락 → deploy-realtime 배선
- PRESENCE_REDIS_ENABLED·PRESENCE_ONLINE_REDIS_ENABLED·FANOUT_WAKE_REDIS_ENABLED: 의도적 off
  (해당 로직이 events.py의 agent_event_stream 어디에도 없음 — REST 라우트/agent_gateway.py
  전용이라 realtime-dev 프로세스에서 구조적으로 실행되지 않음)

이 테스트는 그 판정 결과가 cloudbuild.yaml에 실제로 반영돼 있는지 고정한다 — 다음에 누가
"다 켜자"로 뭉개거나, 반대로 누락분이 다시 빠지는 것을 막는다.
"""
from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"


def _deploy_realtime_step_script() -> str:
    import yaml

    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-realtime")
    assert step["entrypoint"] == "bash"
    return step["args"][1]


def _update_env_vars_line(script: str) -> str:
    line = next(l for l in script.splitlines() if "--update-env-vars=" in l)
    return line.strip()


def test_realtime_step_enables_confirmed_missing_flags():
    """#2158(replay)·#2178 AC1(sse_lease) — 코드 경로 실증으로 "진짜 누락" 판정된 둘만 켠다."""
    line = _update_env_vars_line(_deploy_realtime_step_script())
    assert "SSE_TRANSIENT_REPLAY_ENABLED=true" in line, (
        "SSE_TRANSIENT_REPLAY_ENABLED 누락 — 브라우저 SSE를 실제로 서빙하는 서비스에서 "
        "replay()가 안 돎(#2158 회귀검증이 막힌 그 자리)"
    )
    assert "SSE_LEASE_REDIS_ENABLED=true" in line, (
        "SSE_LEASE_REDIS_ENABLED 누락 — events.py의 sse_lease.acquire/refresh/release가 "
        "agent_event_stream 안에서 직접 호출되는데(연결·30초 하트비트·해제), realtime-dev가 "
        "다인스턴스(2~8)라 이게 꺼지면 #2121이 고치려던 전역 429/503 캡이 인스턴스별로 쪼개진다"
    )


def test_realtime_step_intentionally_leaves_three_flags_off():
    """의도적 off 3종 — 해당 로직이 events.py(agent_event_stream)에 존재하지 않아 이 서비스
    에선 구조적으로 무해(REST 라우트/agent_gateway.py 전용). 값이 실수로 켜지면 이 판정
    자체가 재검토 대상이므로 실패시켜 눈에 띄게 한다."""
    line = _update_env_vars_line(_deploy_realtime_step_script())
    assert "PRESENCE_REDIS_ENABLED=" not in line, (
        "chat_presence는 conversations.py/team_presence.py 전용(REST) — events.py엔 "
        "import/호출 자체가 없다. 켜야 한다는 새 근거가 생겼으면 이 assert와 함께 cloudbuild.yaml "
        "주석의 '의도적 off' 판정도 같이 갱신할 것"
    )
    assert "PRESENCE_ONLINE_REDIS_ENABLED=" not in line, (
        "30초 SSE-틱 hot-path 기록은 agent_gateway.py의 /agent/stream(에이전트 전용)에만 "
        "있다 — events.py(브라우저 전용)엔 presence_online 참조가 없다"
    )
    assert "FANOUT_WAKE_REDIS_ENABLED=" not in line, (
        "wake_agent()의 대상 큐는 에이전트 키인데 에이전트는 backend-dev에만 붙는다 — "
        "realtime-dev엔 그 큐가 존재한 적이 없어 이 플래그가 무의미하다"
    )


def test_realtime_step_source_declares_why_flags_differ():
    """AC3(이 스토리의 본체) — 값이 아니라 "왜 다른지"가 코드에 선언돼 있는지 소스 검사로 고정.
    다음에 누가 값만 보고 "다 켜자"로 판단하지 않도록, 각 플래그의 판정 근거가 남아있어야 한다."""
    script = _deploy_realtime_step_script()
    assert "story #2178" in script
    for flag in (
        "PRESENCE_REDIS_ENABLED", "PRESENCE_ONLINE_REDIS_ENABLED", "FANOUT_WAKE_REDIS_ENABLED",
    ):
        assert flag in script, f"{flag}의 '의도적 off' 판정 근거가 스텝 주석에서 사라졌다"


def test_realtime_step_declares_the_assumption_the_judgment_rests_on():
    """오르테가군 PR 리뷰(2026-07-24): "의도적 off" 판정 근거뿐 아니라 그 판정이 **무너지는
    조건**까지 선언돼야 한다 — 오늘 #2178 사달의 근본원인이 정확히 "전제가 어디에도 안
    적혀 있던 것"이었다. realtime-dev가 backend와 같은 풀 이미지를 돌려 /agent/stream
    라우트 자체는 살아있으므로, "브라우저만 붙는다"는 전제가 라우팅 변경으로 깨지면 이
    판정 전체가 재검토 대상이 된다는 것을 명시해야 한다."""
    script = _deploy_realtime_step_script()
    assert "브라우저만 붙는다" in script
    assert "재검토" in script or "재판정" in script
