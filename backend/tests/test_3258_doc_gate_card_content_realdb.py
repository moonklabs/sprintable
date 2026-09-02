"""story #3258(customer-zero 2차, 2026-08-31) — 결재 카드가 채팅에 «스텁»으로만 게시되던
결함의 BE 절반 pin. 상신 시 gate.neutral_facts에 doc_summary(AC1 — 본문 없이 결정 가능한
요약)를, 재상신(반려→개정) 시 doc_diff(AC4 — 「무엇이 바뀌었나」 add/del 라인 카운트)를
싣는다(transition_doc, backend/app/services/doc.py). create_all로 자체 스키마를 직접 다루는
격리 DB 전용(test_edg_s28_doc_resubmit.py와 동일 규율)."""
from __future__ import annotations

import os
import uuid

import pytest

from app.services.doc import transition_doc

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — story #2662류: 벌크 import에 안 걸리는 모듈.
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_and_project(s, org_id):
    from app.models.organization import Organization
    from app.models.project import Project
    s.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
    await s.flush()
    project_id = uuid.uuid4()
    s.add(Project(id=project_id, org_id=org_id, name="p"))
    await s.flush()
    return project_id


async def _seed_team_member(s, org_id, project_id, member_id, *, name):
    """approval_delivery.py의 DM 생성이 conversation_participants.member_id→team_members.id FK를
    요구한다 — 승인자·요청자 둘 다 실 TeamMember 행이 있어야 상신 알림 경로가 안 죽는다."""
    from app.models.team import TeamMember
    s.add(TeamMember(id=member_id, org_id=org_id, project_id=project_id, type="human", name=name, role="member"))
    await s.flush()


async def _seed_admin(s, org_id, project_id):
    """상신(draft→pending)은 designated_approver_id가 owner/admin OrgMember여야 한다(story
    #3004) — 그 자격 검증(OrgMember)과 대화 참여자 FK(TeamMember)를 같은 id로 겸하게 한다
    (프로덕션의 실 member 신원 통합 관례와 동형, member_id 하나가 두 테이블 모두에 존재)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User
    user_id = uuid.uuid4()
    s.add(User(
        id=user_id, email=f"admin-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await s.flush()
    admin_id = uuid.uuid4()
    s.add(OrgMember(id=admin_id, org_id=org_id, user_id=user_id, role="admin"))
    await s.flush()
    await _seed_team_member(s, org_id, project_id, admin_id, name="admin")
    return admin_id


async def _seed_doc(s, org, project_id, status, content="v1 content"):
    from app.models.doc import Doc
    doc = Doc(org_id=org, project_id=project_id, title="d", slug=f"d-{uuid.uuid4().hex[:8]}",
              content=content, status=status)
    s.add(doc)
    await s.flush()
    return doc


def _caller(org, member_id):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=member_id, user_id=uuid.uuid4(), name="author",
                           type="human", role="member", org_id=org)


@pytest.mark.anyio
async def test_first_submission_embeds_doc_summary():
    """AC1 — 최초 상신(draft→pending)만으로도 카드가 결정 가능한 요약을 실어야 한다. 마크다운
    크롬(헤딩·강조·링크)이 벗겨진 평문이 gate.neutral_facts.doc_summary에 실린다."""
    from app.models.gate import Gate
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        project_id = await _seed_org_and_project(s, org)
        admin_id = await _seed_admin(s, org, project_id)
        author_id = uuid.uuid4()
        await _seed_team_member(s, org, project_id, author_id, name="author")
        doc = await _seed_doc(
            s, org, project_id, status="draft",
            content="# 제목\n\n본문은 **굵게**와 [링크](https://x)를 포함한다.",
        )
        await s.commit()
        await transition_doc(s, org, _caller(org, author_id), doc.id, "pending", designated_approver_id=admin_id)
        await s.commit()
        gate = (await s.execute(
            select(Gate).where(Gate.work_item_id == doc.id)
        )).scalar_one()
        assert gate.neutral_facts["doc_summary"] == "제목 본문은 굵게와 링크를 포함한다."
        assert "doc_diff" not in gate.neutral_facts  # 최초 상신엔 대조할 이전 버전이 없다.
    await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_after_rejection_embeds_line_diff():
    """AC4 — 반려→개정→재상신 시 카드에 「무엇이 바뀌었나」(add/del 라인 카운트)가 실린다.
    denied→draft 전이가 반려본 content를 DocRevision에 스냅샷해두므로(story #3028), 재상신
    시점의 새 content와 diff한다.

    ⚠️gate_service.transition_gate()의 실 승인/반려 경로(알림·SSE·conversation dispatch)는
    이 테스트의 관심사가 아니고(다른 realdb 테스트가 이미 핀) — 여기서는 반려 "결과 상태"
    (gate.status='rejected'+해소필드·doc.status='denied')만 직접 만들어 transition_doc()의
    재상신 분기(내가 이번에 추가한 doc_diff 계산)만 좁게 검증한다."""
    from datetime import datetime, timezone
    from app.models.doc import Doc
    from app.models.gate import Gate
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        project_id = await _seed_org_and_project(s, org)
        admin_id = await _seed_admin(s, org, project_id)
        author_id = uuid.uuid4()
        await _seed_team_member(s, org, project_id, author_id, name="author")
        doc = await _seed_doc(s, org, project_id, status="draft", content="line1\nline2\nline3")
        await s.commit()
        caller = _caller(org, author_id)
        await transition_doc(s, org, caller, doc.id, "pending", designated_approver_id=admin_id)
        await s.commit()
        gate = (await s.execute(select(Gate).where(Gate.work_item_id == doc.id))).scalar_one()
        gate.status = "rejected"
        gate.resolver_id = admin_id
        gate.resolved_at = datetime.now(timezone.utc)
        gate.resolution_note = "반려"
        doc.status = "denied"
        await s.flush()
        await s.commit()
        await transition_doc(s, org, caller, doc.id, "draft")  # denied→draft: 반려본 스냅샷
        d = (await s.execute(select(Doc).where(Doc.id == doc.id))).scalar_one()
        d.content = "line1\nline2-edited\nline3\nline4"  # 2줄 변경/추가
        await s.flush()
        await s.commit()
        await transition_doc(s, org, caller, doc.id, "pending", designated_approver_id=admin_id)
        await s.commit()
        gate2 = (await s.execute(select(Gate).where(Gate.work_item_id == doc.id))).scalar_one()
        assert gate2.neutral_facts["doc_diff"] == {"add": 2, "del": 1}
        assert gate2.neutral_facts["doc_summary"] == "line1 line2-edited line3 line4"
    await engine.dispose()
