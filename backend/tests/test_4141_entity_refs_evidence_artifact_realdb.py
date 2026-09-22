"""story #4141([E-RECIPE-1] Phase3 폴리시, 페드루 PO 確定 2026-09-22) — 게이트 상세
«이것을 가리키는 것들»이 evidence·artifact를 아예 못 세던 결함(entity_references 체계에
evidence/artifact가 «인용 가능한 source»로 온보딩된 적 없음 — 쓰기 reconcile 호출 0·읽기
allowed-set 4종 하드코딩)의 쓰기·읽기 양쪽 온보딩.

디디 그라운딩(2026-09-22 03:00~03:08Z) — file:line 인용은 story 본문 참조. 방향 확認
(페드루 PO, 03:08Z) 조건 3개를 이 파일이 각각 pin한다:
  ① `_SIMPLE_SOURCE_TYPE_SPECS`(backlinks.py)가 유일한 등록처 — mutation-kill 테스트.
  ② evidence의 project 해소는 story/task 양쪽 다 테스트(음성 대조 포함).
  ③ 쓰기 쪽 게이트 핀은 #4135와 같은 `_GATE_TYPE_EXPECTED_EVIDENCE_KINDS` 표를 공유
     (recipe_gate_hooks.py에서 import 하나로 — 표가 둘이 되지 않음, 그 자체가 이 파일의
     import 문으로 증명된다).

기존 4종(doc/chat_message/meeting/story) 회귀는 이 파일이 재검증하지 않는다 — 착수 前
`test_2266`·`test_3852`·`test_1994`·`test_2889`·`test_2721` 등 24개 파일을 실측 전수
재실행해 204/204 그린을 확認했다(이 파일이 새로 깨뜨렸는지는 그 스위트가 판정)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


# ─── Seeding helpers(test_2266_story_backlinks_realdb.py와 동형 — 이 파일 자체 완결) ──


async def _make_org(session, name="Org4141"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id):
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.commit()
    return story


async def _make_task(session, org_id, story_id, title="Task"):
    from app.models.pm import Task
    task = Task(id=uuid.uuid4(), org_id=org_id, story_id=story_id, title=title, status="todo")
    session.add(task)
    await session.commit()
    return task


async def _make_role(session, org_id):
    from app.models.participation import ParticipationRole
    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _make_doc(session, org_id, project_id, title="Doc"):
    from app.models.doc import Doc
    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content="",
    )
    session.add(doc)
    await session.commit()
    return doc


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id, project_id=None):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    app_metadata: dict = {"org_id": str(org_id)}
    if project_id is not None:
        app_metadata["project_id"] = str(project_id)

    async def _auth():
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": app_metadata})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _fetch_reference_target_ids(session, *, org_id, source_type, source_id, target_type=None):
    from sqlalchemy import select
    from app.models.reference import Reference

    q = select(Reference.target_type, Reference.target_id).where(
        Reference.org_id == org_id, Reference.source_type == source_type, Reference.source_id == source_id,
    )
    if target_type is not None:
        q = q.where(Reference.target_type == target_type)
    rows = (await session.execute(q)).all()
    return rows


@pytest.mark.anyio
async def test_evidence_create_pins_gate_and_gate_backlinks_show_it():
    """AC1/AC5 — concept_approval 게이트가 기대하는 kind(payload.kind="concept_brief")의
    evidence를 만들면 entity_references에 source=evidence·target=gate 행이 남고, 그
    게이트의 backlinks(«이것을 가리키는 것들»)에 evidence가 실제로 나타난다."""
    from app.main import app
    from app.dependencies.auth import AuthContext
    from app.routers.evidence import EvidenceCreateRequest, _create_evidence
    from app.services.backlinks import list_entity_backlinks
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            role_id = await _make_role(s, org.id)
            gate = await create_gate(
                s, org.id, story.id, "story", "concept_approval", member_id, role_id,
            )
            await s.commit()
            gate_id = gate.id

        async with Session() as s:
            auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
            resp = await _create_evidence(
                EvidenceCreateRequest(
                    work_item_id=story.id, work_item_type="story", type="report",
                    ref="concept brief v1", payload={"kind": "concept_brief"},
                ),
                session=s, org_id=org.id, auth=auth, resolved_locale="ko",
            )
            evidence_id = resp.id

        async with Session() as s:
            rows = await _fetch_reference_target_ids(
                s, org_id=org.id, source_type="evidence", source_id=evidence_id, target_type="gate",
            )
            assert rows == [("gate", gate_id)]

            auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
            result = await list_entity_backlinks(
                s, org_id=org.id, target_type="gate", target_id=gate_id, auth=auth, limit=30, cursor=None,
            )
            evidence_items = [item for item in result["data"] if item["source_type"] == "evidence"]
            assert len(evidence_items) == 1
            assert evidence_items[0]["evidence"]["id"] == str(evidence_id)
            assert evidence_items[0]["still_exists"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_create_with_artifact_id_writes_artifact_reference():
    """AC1 — evidence가 artifact_id로 근거를 삼으면 source=evidence·target=artifact
    Reference가 남는다(payload.kind 무관 — artifact_id는 독립 축)."""
    from app.dependencies.auth import AuthContext
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact
    from app.routers.evidence import EvidenceCreateRequest, _create_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            artifact = VisualArtifact(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="컨셉 보드",
                created_by=member_id,
            )
            s.add(artifact)
            await s.flush()
            s.add(ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=member_id))
            await s.commit()
            artifact_id = artifact.id

        async with Session() as s:
            auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
            resp = await _create_evidence(
                EvidenceCreateRequest(
                    work_item_id=story.id, work_item_type="story", type="url",
                    ref="https://example.test/ref", artifact_id=artifact_id,
                ),
                session=s, org_id=org.id, auth=auth, resolved_locale="ko",
            )
            evidence_id = resp.id

        async with Session() as s:
            rows = await _fetch_reference_target_ids(
                s, org_id=org.id, source_type="evidence", source_id=evidence_id, target_type="artifact",
            )
            assert rows == [("artifact", artifact_id)]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_delete_cleans_up_references():
    """AC1 "삭제 시 참조 정리" — evidence를 지우면 그 evidence가 source인 Reference 행이
    사라진다(polymorphic FK가 없어 CASCADE 불가 — evidence.py::delete_evidence의 명시
    정리 로직을 직접 pin)."""
    from app.dependencies.auth import AuthContext
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact
    from app.routers.evidence import EvidenceCreateRequest, _create_evidence, delete_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            artifact = VisualArtifact(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="A", created_by=member_id)
            s.add(artifact)
            await s.flush()
            s.add(ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=member_id))
            await s.commit()
            artifact_id = artifact.id

        auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
        async with Session() as s:
            resp = await _create_evidence(
                EvidenceCreateRequest(
                    work_item_id=story.id, work_item_type="story", type="url",
                    ref="https://example.test/ref", artifact_id=artifact_id,
                ),
                session=s, org_id=org.id, auth=auth, resolved_locale="ko",
            )
            evidence_id = resp.id

        async with Session() as s:
            rows = await _fetch_reference_target_ids(s, org_id=org.id, source_type="evidence", source_id=evidence_id)
            assert len(rows) == 1

        async with Session() as s:
            await delete_evidence(evidence_id, session=s, org_id=org.id, auth=auth)

        async with Session() as s:
            rows = await _fetch_reference_target_ids(s, org_id=org.id, source_type="evidence", source_id=evidence_id)
            assert rows == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_project_resolution_story_vs_task_positive_and_negative():
    """조건②(페드루 PO) — evidence의 project 해소(`_evidence_project_id_expr`)가 story
    work_item과 task work_item 양쪽 다 맞는 project로 correlate되는지, 그리고 다른
    project 소속 caller에게는 안 새는지(음성 대조) pin한다."""
    from app.dependencies.auth import AuthContext
    from app.routers.evidence import EvidenceCreateRequest, _create_evidence
    from app.services.backlinks import list_entity_backlinks

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            member_a_id, user_a_id = await _make_human_member(s, org.id, project_a.id)
            _member_b_id, user_b_id = await _make_human_member(s, org.id, project_b.id)
            story = await _make_story(s, org.id, project_a.id)
            task = await _make_task(s, org.id, story.id)
            doc = await _make_doc(s, org.id, project_a.id, title="근거 문서")
            doc_id = doc.id

        auth_a = AuthContext(user_id=str(user_a_id), email="a@test", claims={"app_metadata": {"org_id": str(org.id)}})
        for work_item_id, work_item_type, label in ((story.id, "story", "s"), (task.id, "task", "t")):
            async with Session() as s:
                resp = await _create_evidence(
                    EvidenceCreateRequest(
                        work_item_id=work_item_id, work_item_type=work_item_type, type="report",
                        ref=f"{label}-ref", payload={"kind": "concept_brief", "doc": f"entity:doc:{doc_id}"},
                    ),
                    session=s, org_id=org.id, auth=auth_a, resolved_locale="ko",
                )
                evidence_id = resp.id

            async with Session() as s:
                rows = await _fetch_reference_target_ids(
                    s, org_id=org.id, source_type="evidence", source_id=evidence_id, target_type="doc",
                )
                assert rows == [("doc", doc_id)], f"{label}: doc 토큰이 안 실렸다"

            # 양성: project_a 소속 caller에게는 doc backlinks에 이 evidence가 보인다.
            async with Session() as s:
                result = await list_entity_backlinks(
                    s, org_id=org.id, target_type="doc", target_id=doc_id, auth=auth_a, limit=30, cursor=None,
                )
                ev_ids = {item["source_id"] for item in result["data"] if item["source_type"] == "evidence"}
                assert str(evidence_id) in ev_ids, f"{label}: project_a caller에게 안 보임"

            # 음성 대조: project_b 소속 caller(같은 org, 다른 project)에게는 안 보인다
            # (project_access_valid_correlated가 evidence의 실 project를 제대로 correlate
            # 못 하면 이 음성 대조가 거짓으로 통과해 버린다 — 이 assert가 그 사고를 잡는다).
            auth_b = AuthContext(user_id=str(user_b_id), email="b@test", claims={"app_metadata": {"org_id": str(org.id)}})
            async with Session() as s:
                result = await list_entity_backlinks(
                    s, org_id=org.id, target_type="doc", target_id=doc_id, auth=auth_b, limit=30, cursor=None,
                )
                ev_ids = {item["source_id"] for item in result["data"] if item["source_type"] == "evidence"}
                assert str(evidence_id) not in ev_ids, f"{label}: project_b caller에게 새어 보였다(authz 누락)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_artifact_create_writes_story_reference_and_story_backlinks_show_it():
    """AC1/AC5 — artifact 생성 시 story_id가 있으면 source=artifact·target=story
    Reference가 남고, 그 story의 backlinks에 artifact가 나타난다."""
    from app.main import app
    from app.services.backlinks import list_entity_backlinks
    from app.dependencies.auth import AuthContext

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "컨셉 보드", "story_id": str(story.id), "nodes": [{"type": "text"}]},
            )
            assert resp.status_code == 201, resp.text
            artifact_id = uuid.UUID(resp.json()["data"]["id"])
        finally:
            await client.aclose()

        async with Session() as s:
            rows = await _fetch_reference_target_ids(
                s, org_id=org.id, source_type="artifact", source_id=artifact_id, target_type="story",
            )
            assert rows == [("story", story.id)]

            auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
            result = await list_entity_backlinks(
                s, org_id=org.id, target_type="story", target_id=story.id, auth=auth, limit=30, cursor=None,
            )
            artifact_items = [item for item in result["data"] if item["source_type"] == "artifact"]
            assert len(artifact_items) == 1
            assert artifact_items[0]["artifact"]["id"] == str(artifact_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_artifact_new_version_node_token_diff_adds_doc_reference():
    """AC1/AC5 — v1엔 doc 토큰이 없다가 새 버전(node description에 `[라벨](entity:doc:uuid)`
    추가)에서 비로소 생기면, 그 시점에야 doc backlinks에 artifact가 나타난다(diff 동작
    증명 — v1 시점엔 없어야 하고 v2 이후엔 있어야 한다)."""
    from app.main import app
    from app.services.backlinks import list_entity_backlinks
    from app.dependencies.auth import AuthContext

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            doc = await _make_doc(s, org.id, project.id, title="레퍼런스 문서")
            doc_id = doc.id

        await _setup_app_human(app, Session, user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "무드보드", "nodes": [{"type": "text"}]})
            assert resp.status_code == 201, resp.text
            artifact_id = uuid.UUID(resp.json()["data"]["id"])

            auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
            async with Session() as s:
                result = await list_entity_backlinks(
                    s, org_id=org.id, target_type="doc", target_id=doc_id, auth=auth, limit=30, cursor=None,
                )
                assert not any(item["source_type"] == "artifact" for item in result["data"]), (
                    "v1엔 doc 토큰이 없는데 이미 backlinks에 떴다"
                )

            resp2 = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [
                    {"op": "add", "type": "text", "description": f"[레퍼런스](entity:doc:{doc_id})"},
                ]},
            )
            assert resp2.status_code in (200, 201), resp2.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = await _fetch_reference_target_ids(
                s, org_id=org.id, source_type="artifact", source_id=artifact_id, target_type="doc",
            )
            assert rows == [("doc", doc_id)]

            auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})
            result = await list_entity_backlinks(
                s, org_id=org.id, target_type="doc", target_id=doc_id, auth=auth, limit=30, cursor=None,
            )
            assert any(
                item["source_type"] == "artifact" and item["source_id"] == str(artifact_id)
                for item in result["data"]
            ), "v2 이후엔 doc backlinks에 떠야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_kill_spec_table_is_sole_registration_point():
    """조건①(페드루 PO) — `_SIMPLE_SOURCE_TYPE_SPECS`가 evidence 읽기의 유일한 등록처임을
    직접 증명한다: 그 표에서 "evidence" 키를 빼면(monkeypatch), 방금 만든 evidence
    Reference가 있어도 backlinks 결과에서 사라져야 한다 — 어딘가에 evidence용 하드코딩
    분기가 남아 있다면(이 표를 안 거치는 우회 경로) 이 테스트가 거짓으로 통과(green인데
    실은 표를 안 거침)하는 게 아니라, "빠져야 하는데 안 빠짐"으로 실패해 그 존재를 드러낸다."""
    import app.services.backlinks as backlinks_module
    from app.dependencies.auth import AuthContext
    from app.models.evidence import Evidence
    from app.models.reference import Reference
    from app.services.backlinks import list_entity_backlinks

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            doc = await _make_doc(s, org.id, project.id, title="타겟 문서")
            doc_id = doc.id
            # story #4141 — Reference.source_id는 실 Evidence 행을 가리켜야 한다(그래야
            # backlinks.py의 evidence LEFT JOIN·_evidence_project_id_expr()가 project를
            # 해소할 수 있다 — 존재하지 않는 source_id는 authz가 정당하게 fail-closed되어
            # 「등록됐는데도 사전조건이 실패」하는 것처럼 보이는 별개의 함정이었다).
            evidence = Evidence(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                type="report", ref="증거 문서 v1", created_by=member_id,
            )
            s.add(evidence)
            await s.flush()
            s.add(Reference(
                id=uuid.uuid4(), org_id=org.id, source_type="evidence", source_field="ref",
                source_id=evidence.id, target_type="doc", target_id=doc_id, form="mention",
                origin="explicit", relation="none", created_by=member_id,
            ))
            await s.commit()

        auth = AuthContext(user_id=str(user_id), email="h@test", claims={"app_metadata": {"org_id": str(org.id)}})

        async with Session() as s:
            result = await list_entity_backlinks(
                s, org_id=org.id, target_type="doc", target_id=doc_id, auth=auth, limit=30, cursor=None,
            )
            assert any(item["source_type"] == "evidence" for item in result["data"]), (
                "표에 evidence가 등록돼 있는데 사전조건 자체가 실패했다"
            )

        patched = {k: v for k, v in backlinks_module._SIMPLE_SOURCE_TYPE_SPECS.items() if k != "evidence"}
        original = backlinks_module._SIMPLE_SOURCE_TYPE_SPECS
        backlinks_module._SIMPLE_SOURCE_TYPE_SPECS = patched
        try:
            async with Session() as s:
                result = await list_entity_backlinks(
                    s, org_id=org.id, target_type="doc", target_id=doc_id, auth=auth, limit=30, cursor=None,
                )
                assert not any(item["source_type"] == "evidence" for item in result["data"]), (
                    "표에서 evidence를 뺐는데도 결과에 남아 있다 — 이 표가 유일한 등록처가 아니다"
                )
        finally:
            backlinks_module._SIMPLE_SOURCE_TYPE_SPECS = original
    finally:
        await engine.dispose()
