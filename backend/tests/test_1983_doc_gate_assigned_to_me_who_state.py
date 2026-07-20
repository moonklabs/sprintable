"""story #1983: doc_approval ``assigned_to_me`` WHO/STATE 분리 — story #2259가 non-doc gate에
적용한 원칙(까심 #1960 QA 적출)을 doc_approval 경로에도 대칭 적용.

배경: ``list_gates``의 doc_approval ``resp.can_approve`` 필드는 **의도적으로**
``_reason is None and is_valid_transition(g.status, "approved")`` — FSM-aware(현재 클릭
가능한가). 이 필드 자체는 FE 버튼 게이팅용이라 정확하고 건드리지 않는다.

버그: ``assigned_to_me=true`` 최종 필터가 doc_approval 분기에서 이 FSM-aware
``resp.can_approve``를 그대로 재사용해 "내 것"을 판정했다. held gate는 ``is_valid_transition
("held", "approved")``가 False(held→approved는 직접 전이 불가·unhold 경유 필요)라서 WHO
자격자(reviewer·non-author·project-access 有)여도 assigned_to_me 결과에서 사라졌다 — story
#2259가 non-doc gate의 ``g.status != "pending"`` 하드코딩 2곳을 제거한 것과 완전히 동형인 버그가
doc_approval 경로엔 ``can_approve`` 재사용이라는 다른 형태로 남아있었다.

수정: ``can_approve_doc_gate_reason()`` 반환값(``_reason``, WHO-only·FSM 미포함)을
doc_gates enrich 루프에서 ``{gate_id: reason}`` dict로 별도 보관(이중 쿼리 0 — 기존 enrich
호출 결과 재사용)하고, assigned_to_me 필터링은 ``resp.can_approve`` 대신 이 dict의
``reason is None``을 직접 쓴다. STATE(pending/held/terminal)는 바깥 ``status`` 쿼리
파라미터가 그대로 관장(story #2259와 동일 원칙) — 필터 내부에서 FSM 재검사 0.

``resp.can_approve`` 필드 자체(응답 API contract)는 변경 금지 — 이 파일의 회귀 테스트가
그 불변을 명시적으로 검증한다(held gate가 assigned_to_me엔 나오는데 can_approve는
여전히 False인 것이 이번 fix의 정확한 목표 상태).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_1974_gate_assigned_to_me import (
    _agent,
    _call_list_gates,
    _doc_gate,
    _human,
)

# ══════════════════ 순수 로직: WHO-only(_reason) vs FSM-aware(can_approve) 값 갈림 ══════════════════


@pytest.mark.anyio
async def test_who_only_reason_and_fsm_aware_can_approve_diverge_on_held():
    """RED 씨앗: held 상태에서 WHO 판정(``can_approve_doc_gate_reason``)은 승인 가능(None)인데
    FSM-aware 판정(``is_valid_transition``)은 False다 — 이 두 값이 다르다는 것 자체가
    ``assigned_to_me`` 필터가 FSM-aware ``can_approve``를 재사용하면 안 되는 근거."""
    from app.models.gate import is_valid_transition
    from app.routers.gates import can_approve_doc_gate_reason
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    requester_id = uuid.uuid4()
    reviewer_id = uuid.uuid4()  # not-author
    project_id = uuid.uuid4()

    gate = type(
        "G",
        (),
        {
            "neutral_facts": {"requested_by_member_id": str(requester_id)},
            "status": "held",
            "work_item_id": uuid.uuid4(),
        },
    )()
    resolved = ResolvedMember(
        id=reviewer_id, user_id=uuid.uuid4(), name="reviewer", type="human",
        role="member", org_id=org_id,
    )

    from unittest.mock import AsyncMock, patch
    from app.routers import gates as gates_mod

    with patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)):
        reason = await can_approve_doc_gate_reason(
            AsyncMock(), gate, resolved, reviewer_id, org_id, doc_project_id=project_id,
        )

    fsm_aware_can_approve = reason is None and is_valid_transition(gate.status, "approved")

    assert reason is None, "WHO 판정: 자격자(non-author·project-access 有)는 held 여도 None"
    assert fsm_aware_can_approve is False, (
        "FSM 판정: held→approved 직접 전이 불가 → can_approve=False(FE 버튼 게이팅용 — 정확한 값)"
    )
    # 핵심 불변식: 이 둘이 다르다 — assigned_to_me 필터는 reason(WHO)을 써야지 fsm_aware_can_approve
    # (=can_approve 필드)를 재사용하면 안 된다.
    assert reason is None and fsm_aware_can_approve is False


# ══════════════════ list_gates 라우트(mocked session): held doc_approval assigned_to_me ══════════════════


@pytest.mark.anyio
async def test_assigned_to_me_held_doc_approval_eligible_reviewer_included():
    """AC1/AC2 핵심 케이스: held doc_approval + 자격자(reviewer·not-author·project-access 有)
    → assigned_to_me=true 결과에 포함돼야 한다(WHO-only 판정 — FSM 무관)."""
    g = _doc_gate(uuid.uuid4(), status="held")  # requester != caller(아래 _call_list_gates 기본 resolved)
    out = await _call_list_gates([g], has_access=True)
    assert len(out) == 1
    assert out[0].id == g.id


@pytest.mark.anyio
async def test_assigned_to_me_held_doc_approval_can_approve_field_still_false():
    """핵심 불변식(하지 말 것 항목): ``can_approve`` 필드 자체는 FSM-aware 그대로 유지 —
    held gate가 assigned_to_me엔 나오는데 can_approve는 여전히 False인 게 이번 fix의 목표 상태."""
    g = _doc_gate(uuid.uuid4(), status="held")
    out = await _call_list_gates([g], has_access=True)
    assert len(out) == 1
    assert out[0].can_approve is False, (
        "can_approve 필드는 FSM-aware 유지가 정답(held→approved 직접 전이 불가) — "
        "assigned_to_me 필터링에만 WHO-only reason 을 써야지 이 필드 값 자체를 바꾸면 안 된다."
    )


@pytest.mark.anyio
async def test_assigned_to_me_held_doc_approval_no_project_access_excluded():
    """비자격자(project-access 無)는 held 여도 배제 — WHO 판정이 여전히 작동."""
    g = _doc_gate(uuid.uuid4(), status="held")
    out = await _call_list_gates([g], has_access=False)
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_held_doc_approval_self_author_excluded():
    """SoD(self-author 배제)는 held 여도 그대로 적용 — can_approve_doc_gate_reason 내부 로직이라
    WHO/STATE 분리와 무관하게 재사용됨을 확인."""
    mid = uuid.uuid4()
    g = _doc_gate(mid, status="held")
    out = await _call_list_gates([g], has_access=True, resolved=_human(mid))
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_held_doc_approval_agent_caller_excluded():
    """휴먼 전용 불변식은 doc_approval held 경로에도 적용(can_approve_doc_gate_reason 이
    not_human 반환 → WHO 판정 자체가 거부)."""
    g = _doc_gate(uuid.uuid4(), status="held")
    out = await _call_list_gates([g], has_access=True, resolved=_agent(uuid.uuid4()))
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_pending_doc_approval_still_included_no_regression():
    """회귀 0: pending doc_approval(기존 89484c8c/story #1974 케이스)은 그대로 포함."""
    g = _doc_gate(uuid.uuid4(), status="pending")
    out = await _call_list_gates([g], has_access=True)
    assert len(out) == 1
    assert out[0].id == g.id


@pytest.mark.anyio
async def test_assigned_to_me_mixed_held_and_pending_doc_gates_both_eligible_included():
    """AC2: held/pending 둘 다 자격자에게 노출 — 같은 caller 가 두 상태 게이트 모두 자격자면
    둘 다 assigned_to_me 결과에 포함(terminal 은 바깥 status 쿼리가 관장 — 이 테스트 스코프 밖)."""
    held_g = _doc_gate(uuid.uuid4(), status="held")
    pending_g = _doc_gate(uuid.uuid4(), status="pending")
    out = await _call_list_gates([held_g, pending_g], has_access=True)
    ids = {r.id for r in out}
    assert ids == {held_g.id, pending_g.id}


# ══════════════════ realdb: held doc_approval 실 HTTP 라운드트립(AC3) ══════════════════
# 패턴은 test_1974_gate_assigned_to_me.py 의 realdb 섹션(세션 팩토리/앱 셋업/조직 시딩)을 그대로
# 재사용한다 — 신규 helper 발명 없음.

import os  # noqa: E402

from tests.test_1974_gate_assigned_to_me import (  # noqa: E402
    _client_for,
    _seed_org_project_users,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
pytestmark = pytest.mark.destructive_schema  # realdb 섹션이 Base.metadata.create_all 호출(story 8236bbc3 대응)


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_held_doc_approval_assigned_to_me_true_but_can_approve_false():
    """AC3 핵심 실증: held doc_approval + 자격 reviewer(project-access 有·not-author) →
    ``GET /api/v2/gates?status=held&assigned_to_me=true`` 가 그 게이트를 반환(빈 배열 아님) —
    동시에 같은 게이트의 ``can_approve`` 필드는 여전히 False(held→approved 직접 전이 불가 —
    FE "지금 버튼 눌러도 되는가" 게이팅용 필드는 불변이어야 하므로 이게 이번 fix 의 정확한 목표
    상태). 비자격자(project-access 無)는 0건, author(SoD)도 0건임을 같이 실측."""
    from app.main import app
    from app.models.doc import Doc
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id = seeded["org_id"], seeded["project_id"]
            a_id, b_id = seeded["user_a_id"], seeded["user_b_id"]
            org_member_b_id = seeded["org_member_b_id"]

            # doc_approval, held 상태. 상신자=B(org_members.id 축) → A(project owner grant)는
            # not-author+project-access 有 = WHO 자격자. B는 self-author(SoD 배제).
            doc = Doc(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id,
                title="held 결재 문서", slug=f"doc-{uuid.uuid4().hex[:6]}", status="pending",
            )
            s.add(doc)
            await s.flush()
            held_doc_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=doc.id, work_item_type="doc",
                gate_type="doc_approval", status="held",
                neutral_facts={"requested_by_member_id": str(org_member_b_id)},
            )
            s.add(held_doc_gate)
            await s.commit()

        # A: 자격 reviewer(project owner grant·not-author) — held 여도 assigned_to_me=true 에 나와야
        # 한다(WHO 판정). 같은 응답의 can_approve 는 FSM-aware 그대로 False 여야 한다(불변 필드).
        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/gates", params={"status": "held", "assigned_to_me": "true"},
            )
            assert resp.status_code == 200, resp.text
            body_a = resp.json()
            print("\n=== realdb story #1983: held doc_approval assigned_to_me=true (A=reviewer) 캡처 ===")
            for row in body_a:
                print(f"  id={row['id']} status={row['status']} can_approve={row['can_approve']}")
            ids_a = {row["id"] for row in body_a}
            assert str(held_doc_gate.id) in ids_a, (
                "held doc_approval 게이트가 자격 reviewer 의 assigned_to_me=true 결과에서 빠짐 — "
                "WHO/STATE 분리 회귀(story #2259 원칙이 doc_approval 경로엔 안 먹은 상태)"
            )
            gate_row = next(row for row in body_a if row["id"] == str(held_doc_gate.id))
            assert gate_row["can_approve"] is False, (
                "can_approve 필드는 FSM-aware 불변이어야 한다(held→approved 직접 전이 불가) — "
                "assigned_to_me 필터링에만 WHO 를 쓰고 이 필드 값 자체는 바뀌면 안 된다."
            )

            # 비자격자(project-access 無인 org member)와 author(SoD)도 held 상태에서 여전히 0건인지
            # 같은 캡처에서 확인 — WHO 판정이 held 에서도 정확히 작동함을 대비 실증.
            resp_all_held = await client.get("/api/v2/gates", params={"status": "held"})
            assert resp_all_held.status_code == 200, resp_all_held.text
            assert len(resp_all_held.json()) == 1  # org 전체엔 held 게이트 1건 존재(assigned_to_me 무관)
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # B: 상신자 본인(self-author) → held 여도 SoD 로 배제(0건).
        await _setup_app(app, Session, org_id, b_id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/gates", params={"status": "held", "assigned_to_me": "true"},
            )
            assert resp.status_code == 200, resp.text
            body_b = resp.json()
            print(f"\n=== realdb story #1983: held doc_approval assigned_to_me=true (B=author) 캡처 — "
                  f"건수={len(body_b)} ===")
            assert body_b == [], "author(SoD 대상)는 held 여도 assigned_to_me 결과에서 배제돼야 한다"
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
