"""story #2198(까심 QA 적출·오르테가 확定): non-doc 게이트(merge/pr_review/qa/deploy/
artifact_canonicalize 등) 인가 갭 — 세 증상이 하나의 뿌리(rule B 미배선)였다.

```
① 큐 필터        _non_doc_gate_approvable (story #1974)                ← 이미 옳게 좁았음
② can_approve    list_gates·get_gate_endpoint 둘 다 non-doc 은 계산 자체를 안 해 기본값 False  ← 없음
③ 승인 엔드포인트 transition_gate_endpoint = 휴먼 org 멤버이기만 하면 통과                    ← 가장 넓음
```

처방 = 새 규칙 발명 없이 이미 있던 rule B(``_non_doc_gate_approvable``)를 ②③에 마저 배선.

⛔SoD(self-approval) 는 의도적으로 안 넣는다(오르테가 PO 판정, 2026-07-27) — 근거는 gates.py
transition_gate_endpoint 의 non-doc elif 분기 주석에 그대로 남겨 뒀다(저자성 없음·상신자=에이전트라
사람 대 사람 SoD 자리가 거의 없음·1인 org 교착 재발 위험·추적은 resolver_id 강제 기록으로 이미 확보).

⛔라이브 승인 POST 로 검증하지 않는다(오르테가 지시) — 이 파일은 격리된 로컬 throwaway realdb만
쓴다(#2027 test_2027_gate_approval_reason_enforce.py 와 동일 정신 — 실제 배포된 시스템에 손대지
않는 disposable 테스트 DB). 회귀 가드 = "무자격 휴먼이 시도하면 서버가 403"을 직접 함수호출로 고정.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2198000-0000-0000-0000-000000000001")
OWNER_USER = uuid.UUID("d2198000-0000-0000-0000-0000000000a1")  # PROJ_A project_access role=owner
OWNER_OM = uuid.UUID("d2198000-0000-0000-0000-0000000000b1")
MEMBER_USER = uuid.UUID("d2198000-0000-0000-0000-0000000000a2")  # PROJ_A project_access role=member
MEMBER_OM = uuid.UUID("d2198000-0000-0000-0000-0000000000b2")
PROJ_A = uuid.UUID("d2198000-0000-0000-0000-0000000000c1")
STORY_A = uuid.UUID("d2198000-0000-0000-0000-0000000000d1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    """ORG · STORY_A(gate 의 work_item) · OWNER_USER(project_access role=owner) ·
    MEMBER_USER(project_access role=member — 열람은 되나 승인 자격은 없음) · merge 게이트 1건."""
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{MEMBER_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2198','d2198-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d2198.test','x','Owner',true,true,0,false,0),"
        f"('{MEMBER_USER}','member@d2198.test','x','Member',true,true,0,false,0)",
        # 둘 다 org-level role='member'(org owner/admin 아님) — project_access 만으로 갈린다.
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{OWNER_OM}','{ORG}','{OWNER_USER}','member'),"
        f"('{MEMBER_OM}','{ORG}','{MEMBER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{PROJ_A}','{ORG}','A','proj-a')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ_A}','{OWNER_OM}','granted','owner'),"
        f"(gen_random_uuid(),'{PROJ_A}','{MEMBER_OM}','granted','member')",
        f"INSERT INTO stories (id,org_id,project_id,title,status) VALUES "
        f"('{STORY_A}','{ORG}','{PROJ_A}','S','backlog')",
    ]:
        await s.execute(text(sql))
    from app.models.gate import Gate
    gate = Gate(
        id=uuid.uuid4(), org_id=ORG, work_item_id=STORY_A, work_item_type="story",
        gate_type="merge", status="pending", neutral_facts={},
    )
    s.add(gate)
    await s.commit()
    return gate.id


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ───────────────────────── list_gates: can_approve ─────────────────────────

@pytest.mark.anyio
async def test_list_gates_can_approve_true_for_project_owner_false_for_member():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_id = await _seed(s)
        async with Session() as s:
            out = await list_gates(
                work_item_id=None, work_item_type=None, status=None, assigned_to_me=False,
                session=s, org_id=ORG, auth=_auth(OWNER_USER),
            )
        assert next(g for g in out if g.id == gate_id).can_approve is True
        async with Session() as s:
            out = await list_gates(
                work_item_id=None, work_item_type=None, status=None, assigned_to_me=False,
                session=s, org_id=ORG, auth=_auth(MEMBER_USER),
            )
        assert next(g for g in out if g.id == gate_id).can_approve is False
    finally:
        await eng.dispose()


# ───────────────────────── get_gate_endpoint: can_approve ─────────────────────────

@pytest.mark.anyio
async def test_get_gate_can_approve_true_for_project_owner_false_for_member():
    from app.routers.gates import get_gate_endpoint
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_id = await _seed(s)
        async with Session() as s:
            resp = await get_gate_endpoint(id=gate_id, session=s, org_id=ORG, auth=_auth(OWNER_USER))
        assert resp.can_approve is True
        async with Session() as s:
            resp = await get_gate_endpoint(id=gate_id, session=s, org_id=ORG, auth=_auth(MEMBER_USER))
        assert resp.can_approve is False
    finally:
        await eng.dispose()


# ───────────────────────── transition_gate_endpoint: 실 인가 강제 ─────────────────────────

@pytest.mark.anyio
async def test_transition_non_doc_gate_forbidden_for_member_allowed_for_owner():
    """#2198 의 본체 — ③(가장 넓던 자리)이 실제로 좁아졌는지. 격리 로컬 throwaway DB 에서 실제
    transition 을 수행(라이브 배포 시스템 무접촉) — #2027 과 동일한 검증 방식."""
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_id = await _seed(s)
        # 무자격(project member, owner/admin 아님) → 403·상태 미변경.
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await transition_gate_endpoint(
                    id=gate_id, body=GateTransitionRequest(status="approved", note="시도"),
                    background_tasks=BackgroundTasks(), session=s, org_id=ORG, auth=_auth(MEMBER_USER),
                )
            assert ei.value.status_code == 403
        async with Session() as s:
            from app.models.gate import Gate
            g = (await s.execute(text(f"SELECT status FROM gate WHERE id='{gate_id}'"))).scalar_one()
            assert g == "pending"  # 403 이 실제로 상태변경을 막았는지(뮤테이션 0) 재조회로 확認.
        # 자격자(project owner) → 승인 성공.
        async with Session() as s:
            resp = await transition_gate_endpoint(
                # story #2027 AC2: note+evidence_viewed 동봉 — 이 파일의 관심사(#2198 인가)와
                # 무관한 고위험 사유-강제 가드를 우회.
                id=gate_id, body=GateTransitionRequest(status="approved", note="승인 사유", evidence_viewed=True),
                background_tasks=BackgroundTasks(), session=s, org_id=ORG, auth=_auth(OWNER_USER),
            )
        assert resp.status == "approved"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_transition_doc_approval_gate_still_unaffected():
    """#2198 이 doc_approval 분기(elif 이전 if)를 안 건드렸는지 회귀 확認 — 무관 gate_type 은
    non-doc elif 에 아예 안 들어간다(SimpleNamespace work_item_type 몰라도 무관)."""
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    eng, Session = await _engine()
    try:
        async with Session() as s:
            for sql in [
                f"DELETE FROM gate WHERE org_id='{ORG}'",
                f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
                f"DELETE FROM org_members WHERE org_id='{ORG}'",
                f"DELETE FROM stories WHERE org_id='{ORG}'",
                f"DELETE FROM projects WHERE org_id='{ORG}'",
                f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{MEMBER_USER}')",
                f"DELETE FROM organizations WHERE id='{ORG}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2198','d2198-org2','free')",
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
                f"('{OWNER_USER}','owner2@d2198.test','x','Owner',true,true,0,false,0)",
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OWNER_OM}','{ORG}','{OWNER_USER}','member')",
                f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{PROJ_A}','{ORG}','A','proj-a2')",
                f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
                f"(gen_random_uuid(),'{PROJ_A}','{OWNER_OM}','granted','owner')",
            ]:
                await s.execute(text(sql))
            from app.models.doc import Doc
            doc = Doc(id=uuid.uuid4(), org_id=ORG, project_id=PROJ_A, title="d", slug=f"s-{uuid.uuid4().hex[:8]}", content="")
            s.add(doc)
            await s.flush()
            from app.models.gate import Gate
            gate = Gate(
                id=uuid.uuid4(), org_id=ORG, work_item_id=doc.id, work_item_type="doc",
                gate_type="doc_approval", status="pending",
                neutral_facts={"requested_by_member_id": str(uuid.uuid4())},  # requester ≠ OWNER_USER
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id
        async with Session() as s:
            resp = await transition_gate_endpoint(
                # story #2027 AC2: note+evidence_viewed 동봉 — 이 파일의 관심사(#2198 인가)와
                # 무관한 고위험 사유-강제 가드를 우회.
                id=gate_id, body=GateTransitionRequest(status="approved", note="doc 승인", evidence_viewed=True),
                background_tasks=BackgroundTasks(), session=s, org_id=ORG, auth=_auth(OWNER_USER),
            )
        assert resp.status == "approved"  # doc_approval 경로는 #2198 변경으로 인한 영향 0.
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_transition_artifact_canonicalize_gate_human_only_not_project_owner_required():
    """PO 판정(2026-07-27, CI 회귀로 갈림): artifact_canonicalize 는 rule B(project owner/admin)
    가 아니라 휴먼 전용(E-CANVAS C4-S8 설계)이다 — MEMBER_USER(project_access grant 자체가
    없는, merge 게이트라면 위 테스트에서 403 나는 바로 그 사용자)로도 승인이 통과해야 한다.
    이 테스트가 없으면 다음 사람이 #2198 의 rule B 를 "전 타입 균일"로 되돌려 이 회귀를
    재현할 수 있다 — _non_doc_can_approve 표를 직접 겨냥해 고정."""
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_id_holder = {}
            for sql in [
                f"DELETE FROM gate WHERE org_id='{ORG}'",
                f"DELETE FROM visual_artifacts WHERE org_id='{ORG}'",
                f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
                f"DELETE FROM org_members WHERE org_id='{ORG}'",
                f"DELETE FROM stories WHERE org_id='{ORG}'",
                f"DELETE FROM projects WHERE org_id='{ORG}'",
                f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{MEMBER_USER}')",
                f"DELETE FROM organizations WHERE id='{ORG}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2198','d2198-org3','free')",
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
                f"('{MEMBER_USER}','member3@d2198.test','x','Member',true,true,0,false,0)",
                # org-level role='member'(owner/admin 아님) + PROJ_A 에 project_access grant 자체 없음
                # — merge 게이트였다면 위 test_transition_non_doc_gate_forbidden... 과 동일하게 403 날 사용자.
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{MEMBER_OM}','{ORG}','{MEMBER_USER}','member')",
                f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{PROJ_A}','{ORG}','A','proj-a4')",
            ]:
                await s.execute(text(sql))
            from app.models.visual_artifact import VisualArtifact
            artifact = VisualArtifact(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ_A, title="Canon",
                source="created", latest_version_number=1,
            )
            s.add(artifact)
            await s.flush()
            from app.models.gate import Gate
            gate = Gate(
                id=uuid.uuid4(), org_id=ORG, work_item_id=artifact.id, work_item_type="visual_artifact",
                gate_type="artifact_canonicalize", status="pending",
                neutral_facts={"version_number": 1, "requested_by_member_id": str(uuid.uuid4())},
            )
            s.add(gate)
            await s.commit()
            gate_id_holder["id"] = gate.id
        async with Session() as s:
            resp = await transition_gate_endpoint(
                # story #2027 AC2: note+evidence_viewed 동봉 — 이 파일의 관심사(#2198 인가)와
                # 무관한 고위험 사유-강제 가드를 우회.
                id=gate_id_holder["id"], body=GateTransitionRequest(status="approved", note="정본화 승인", evidence_viewed=True),
                background_tasks=BackgroundTasks(), session=s, org_id=ORG, auth=_auth(MEMBER_USER),
            )
        assert resp.status == "approved"
    finally:
        await eng.dispose()
