"""story #3724 — 2026-09-09 하루 3707(스키마 없어 버려짐)·3719(스키마 있는데 도구가 안
보냄)·3720(FE만 있고 뒤가 없음) 세 인스턴스가 같은 세 경계에서 조용히 샌 클래스를 봉쇄.

세 가드가 각각 정확히 무슨 모양을 잡고 무슨 모양은 못 잡는지(페드루 PO 지적 2026-09-09
05:15Z — 가드①·②만으로는 3719 모양을 못 잡는다는 게 맞았다, 도크스트링이 그걸 숨기면
다음 사람이 "그 축은 CI가 본다"로 잘못 읽는다):

가드①(MCP→BE): emit_event·update_run_status가 실제로 조립하는 body 필드 집합(forward
튜플) ⊆ CreateAgentRun/UpdateAgentRun 필드 집합. **잡는 것**: forward 튜플에 있는 필드를
BE 스키마가 아예 안 받아 Pydantic(extra=ignore)이 조용히 버리는 자리(3707류 — "보내는데
버려짐"). **못 잡는 것**: MCP Input 모델엔 선언돼 있는데 forward 튜플에서 빠진 필드(3719
모양 — "선언은 했는데 안 보냄". 이건 가드③의 몫).

가드②(BE→FE): AgentRunResponse 필드 집합 ⊇ FE `agent-run-detail.tsx`의 RunDetail 타입이
읽는 키. **잡는 것**: 화면은 읽는데 API가 절대 안 주는 phantom 필드(3720류). **못 잡는
것**: BE 응답에는 있는데 FE가 안 읽는 필드(그 자체로 버그가 아님 — 미사용 additive는 정상).

가드③(MCP Input→forward, 3719 모양 전용): EmitEventInput/UpdateRunStatusInput이 캐폴러에
노출하는 필드 집합(구조상 always-forwarded인 run_id·agent_id·trigger·status 4개는 body
조립 코드가 loop 밖에서 직접 넣거나 URL path로 쓰므로 대조 제외) ⊆ 실제 forward 튜플.
**잡는 것**: Input 모델(캐폴러가 부를 수 있는 인자)엔 선언했는데 forward 코드가 빠뜨려
캐폴러가 그 인자를 줘도 네트워크 바디에 절대 안 실리는 자리(3719류 — 이 스토리가 실제로
겪은 형: last_error_code가 UpdateAgentRun엔 있었는데 update_run_status가 body에 안
실었다). **못 잡는 것**: BE Create/UpdateAgentRun 스키마엔 있는데 MCP Input 모델 자체가
그 필드를 캐폴러 인자로 아예 안 만든 것(의도적 비노출 — 버그 아님, 예: duration_ms는
GENERATED라 어느 쪽 Input에도 없고 있어서도 안 된다). #4067(#3719) 착지 뒤 rebase한
지금(last_error_code가 이미 양쪽 다 배선됨) 가드③은 grandfather 0건으로 GREEN이어야
정상 — RED면 그게 새 발견.

이 가드들을 실제로 짜는 과정에서 라이브 위반 18건(①·②)이 나왔다(그 자체가 가드의 가치
증명) — 전부 grandfather로 담아 신규만 막는다. 각 항목은 후속 스토리가 있고, 그 스토리가
닫히면 이 grandfather에서도 빠져야 한다(카운트-핀이 그 삭제를 강제한다 — 늘어나면 리뷰,
줄어들면 카운트도 같이 줄여야 커밋된다).
"""
from __future__ import annotations

import re
from pathlib import Path

from app.schemas.agent_run import AgentRunResponse, CreateAgentRun, UpdateAgentRun
from sprintable_mcp.tools.agent_runs import (
    EMIT_EVENT_FORWARD_FIELDS,
    UPDATE_RUN_STATUS_FORWARD_FIELDS,
    EmitEventInput,
    UpdateRunStatusInput,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_FE_AGENT_RUN_DETAIL = _REPO_ROOT / "apps/web/src/components/agents/agent-run-detail.tsx"

# ── 가드① grandfather — story #3727(1pt·medium)이 셋 다 닫는다 ─────────────────────────
GUARD1_GRANDFATHER: dict[tuple[str, str], str] = {
    ("emit_event", "started_at"): "story #3727 — CreateAgentRun에 없어 생성 시 조용히 버려짐",
    ("emit_event", "finished_at"): "story #3727 — CreateAgentRun에 없어 생성 시 조용히 버려짐",
    ("update_run_status", "started_at"): "story #3727 — UpdateAgentRun에 없어 갱신 시 조용히 버려짐(finished_at은 #2161이 이미 고쳐 위반 아님)",
}


def test_mcp_forward_fields_are_subset_of_be_schema_fields():
    """가드① — MCP가 보내는 필드는 반드시 BE가 받는 필드여야 한다(신규 위반=RED)."""
    create_fields = set(CreateAgentRun.model_fields)
    update_fields = set(UpdateAgentRun.model_fields)

    violations: list[str] = []
    for field in EMIT_EVENT_FORWARD_FIELDS:
        if field in create_fields:
            continue
        if ("emit_event", field) in GUARD1_GRANDFATHER:
            continue
        violations.append(f"emit_event.{field}")
    for field in UPDATE_RUN_STATUS_FORWARD_FIELDS:
        if field in update_fields:
            continue
        if ("update_run_status", field) in GUARD1_GRANDFATHER:
            continue
        violations.append(f"update_run_status.{field}")

    assert not violations, (
        "MCP 도구가 보내는 필드가 BE Create/UpdateAgentRun 스키마에 없다(story #3707류 — "
        f"Pydantic extra=ignore가 조용히 버림): {violations}. grandfather 목록에 없는 새 "
        "위반이면 스키마에 그 필드를 추가하거나(값이 실재하면), MCP 도구 forward 목록에서 "
        "빼는(의도적 제외라면) 처방이 필요 — 이 테스트를 고쳐 통과시키지 말 것."
    )


def test_guard1_grandfather_count_pinned():
    """항목 수가 조용히 늘면(새 silent-drop) 리뷰 없이 못 지나가게, 줄면(#3727 착지) 이
    상수도 같이 줄이라는 신호."""
    assert len(GUARD1_GRANDFATHER) == 3, (
        f"GUARD1_GRANDFATHER 항목 수가 3이 아니라 {len(GUARD1_GRANDFATHER)} — 늘었으면 새 "
        "silent-drop이 또 생긴 것(원인 리뷰 필요), 줄었으면 story #3727이 그만큼 닫힌 것이니 "
        "이 상수·주석도 같이 정리할 것."
    )


# ── 가드③ — 3719 모양 전용(MCP Input 모델 ⊆ 실제 forward 튜플) ──────────────────────
# run_id·agent_id·trigger·status는 body 조립 코드가 loop 밖에서 직접 넣거나(emit_event의
# agent_id/trigger, update_run_status의 status) URL path로 쓴다(update_run_status의
# run_id) — forward 튜플에 없어도 정상이라 대조에서 뺀다. project_id는 SprintableInput
# 베이스 클래스 필드(모든 MCP 도구 공통, client.require_project_id()/헤더로 해소 —
# 이 도구만의 body 필드가 아니다)라 agent_runs 전용 forward 튜플엔 애초에 없는 게 맞다.
# (구조적 예외 — 신규 필드 추가 시 이 목록에 넣지 말 것. 여기 있다는 것 자체가 "루프 밖
# 다른 경로로 이미 실린다"는 뜻이라 늘면 안 됨.)
_EMIT_EVENT_STRUCTURAL_EXEMPT = {"agent_id", "trigger", "project_id"}
_UPDATE_RUN_STATUS_STRUCTURAL_EXEMPT = {"run_id", "status", "project_id"}

GUARD3_GRANDFATHER: dict[tuple[str, str], str] = {}


def test_mcp_input_fields_are_subset_of_forward_fields():
    """가드③ — Input 모델(캐폴러 인자)에 선언된 필드는 반드시 forward 튜플에 실려야
    한다(신규 위반=RED). #4067(#3719) 착지 뒤 rebase한 지금 last_error_code가 이미 양쪽
    다 배선돼 있어 grandfather 0건으로 GREEN이어야 정상 — 이 자리가 RED면 새 3719류 발견."""
    violations: list[str] = []

    emit_event_input_fields = set(EmitEventInput.model_fields) - _EMIT_EVENT_STRUCTURAL_EXEMPT
    for field in emit_event_input_fields:
        if field in EMIT_EVENT_FORWARD_FIELDS:
            continue
        if ("emit_event", field) in GUARD3_GRANDFATHER:
            continue
        violations.append(f"emit_event.{field}")

    update_run_status_input_fields = set(UpdateRunStatusInput.model_fields) - _UPDATE_RUN_STATUS_STRUCTURAL_EXEMPT
    for field in update_run_status_input_fields:
        if field in UPDATE_RUN_STATUS_FORWARD_FIELDS:
            continue
        if ("update_run_status", field) in GUARD3_GRANDFATHER:
            continue
        violations.append(f"update_run_status.{field}")

    assert not violations, (
        "MCP Input 모델이 캐폴러 인자로 선언한 필드가 실제 forward 튜플엔 없다(story #3719류 "
        f"— 캐폴러가 그 인자를 줘도 네트워크 바디에 절대 안 실림): {violations}. grandfather "
        "목록에 없는 새 위반이면 forward 튜플에 그 필드를 추가하거나(의도치 않은 누락이면), "
        "Input 모델에서 그 필드를 빼는(캐폴러에게 애초에 노출하면 안 되는 인자였다면) 처방이 "
        "필요 — 이 테스트를 고쳐 통과시키지 말 것."
    )


def test_guard3_grandfather_count_pinned():
    assert len(GUARD3_GRANDFATHER) == 0, (
        f"GUARD3_GRANDFATHER 항목 수가 0이 아니라 {len(GUARD3_GRANDFATHER)} — #3719가 이미 "
        "닫혀 있어야 할 클래스가 다시 열렸다는 뜻이니 원인부터 리뷰."
    )


# ── 가드② grandfather — story #3721(2)·#3725(5)·#3726(8, 2026-09-09 05:02Z 재계산 확定)
# 가 각각 닫는다. #3726 몫 8개는 처음 6개로 셌다가(continuity_debug·memory_compaction_policy
# 누락) 재검산으로 8개로 확정됐다(PO 확認 2026-09-09 05:02Z) — 이 재발이 이 가드 자체의
# 필요성을 다시 증명한다.
GUARD2_GRANDFATHER: dict[str, str] = {
    "tool_call_history": "story #3721 — 은퇴 대상(BE 도구 호출 기록 개념 자체가 0)",
    "tool_audit_trail": "story #3721 — 은퇴 대상(BE 도구 호출 기록 개념 자체가 0)",
    "deployment_id": "story #3725 — DB 컬럼 실재(agent_runs.deployment_id), 응답 스키마에만 없음",
    "failure_disposition": "story #3725 — DB 컬럼 실재, 응답 스키마에만 없음",
    "retry_count": "story #3725 — DB 컬럼 실재, 응답 스키마에만 없음",
    "max_retries": "story #3725 — DB 컬럼 실재, 응답 스키마에만 없음",
    "next_retry_at": "story #3725 — DB 컬럼 실재, 응답 스키마에만 없음",
    "session_id": "story #3726 — BE 전수 grep 0(모델·스키마·라우터 어디에도 없음), 그라운딩만",
    "llm_provider": "story #3726 — BE 전수 grep 0, 그라운딩만",
    "llm_provider_key": "story #3726 — BE 전수 grep 0, 그라운딩만",
    "computed_cost_cents": "story #3726 — BE 전수 grep 0, 그라운딩만(cost_usd와 「이름만 다른 같은 사실」인지 확인 대상)",
    "per_run_cap_cents": "story #3726 — BE 전수 grep 0, 그라운딩만",
    "billing_notes": "story #3726 — BE 전수 grep 0, 그라운딩만",
    "continuity_debug": "story #3726 — BE 전수 grep 0, 그라운딩만",
    "memory_compaction_policy": "story #3726 — BE 전수 grep 0, 그라운딩만",
}


def _extract_ts_interface_field_names(source: str, interface_name: str) -> list[str]:
    """단순 라인 스캔 전제 — RunDetail은 중첩 인라인 객체 타입 없이 `필드명: 타입;` 한 줄
    형태만 쓴다(그 전제가 깨지면(예: 인라인 `{ ... }` 다중행 타입 필드 추가) 이 함수가
    그 필드를 놓칠 수 있다 — i18n-template-key-coverage.test.ts의 "손으로 갱신" 관례와
    동형, 정적 스캔이 아니라 이 파서 자체가 하드코딩된 전제를 갖는다는 뜻)."""
    m = re.search(rf"interface {re.escape(interface_name)} \{{(.*?)\n\}}", source, re.DOTALL)
    assert m is not None, f"interface {interface_name} 블록을 {_FE_AGENT_RUN_DETAIL}에서 못 찾음"
    body = m.group(1)
    fields: list[str] = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith(("//", "/*", "*")):
            continue
        field_match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\??:", line)
        if field_match:
            fields.append(field_match.group(1))
    return fields


def test_be_response_fields_are_superset_of_fe_type_fields():
    """가드② — FE RunDetail이 읽는 필드는 반드시 BE AgentRunResponse가 실어야 한다(신규
    위반=RED)."""
    response_fields = set(AgentRunResponse.model_fields)
    fe_source = _FE_AGENT_RUN_DETAIL.read_text(encoding="utf-8")
    fe_fields = _extract_ts_interface_field_names(fe_source, "RunDetail")

    violations = [
        field for field in fe_fields
        if field not in response_fields and field not in GUARD2_GRANDFATHER
    ]

    assert not violations, (
        "FE RunDetail이 읽는 필드가 BE AgentRunResponse에 없다(story #3720류 — 화면은 있는데 "
        f"API가 절대 안 주는 phantom 필드): {violations}. grandfather 목록에 없는 새 위반이면 "
        "응답 스키마에 필드를 추가하거나(값이 실재하면) FE 타입에서 빼는(값이 아예 없으면) "
        "처방이 필요 — 이 테스트를 고쳐 통과시키지 말 것."
    )


def test_guard2_grandfather_count_pinned():
    assert len(GUARD2_GRANDFATHER) == 15, (
        f"GUARD2_GRANDFATHER 항목 수가 15가 아니라 {len(GUARD2_GRANDFATHER)} — 늘었으면 새 "
        "phantom 필드가 또 생긴 것(원인 리뷰 필요), 줄었으면 후속 스토리(#3721/#3725/#3726)가 "
        "그만큼 닫힌 것이니 이 상수·주석도 같이 정리할 것."
    )
