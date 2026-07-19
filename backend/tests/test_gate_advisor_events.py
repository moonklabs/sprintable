"""Real PostgreSQL transaction tests for Advisor-origin Gate resolution."""
from __future__ import annotations

import os
import uuid
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="requires isolated migrated PostgreSQL")]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if _REAL_DB_URL.startswith(prefix):
            return "postgresql+asyncpg://" + _REAL_DB_URL[len(prefix):]
    return _REAL_DB_URL


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_advisor_gate(session):
    """Minimal canonical members + valid claim pointer on a unique org."""
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.services.advisor_context import RESERVED_EVIDENCE_SOURCE, canonical_claim

    org = Organization(id=uuid.uuid4(), name="Advisor Gate", slug=f"advisor-gate-{uuid.uuid4().hex[:16]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    human_user = User(id=uuid.uuid4(), email=f"advisor-{uuid.uuid4().hex}@test.invalid", hashed_password="x")
    session.add_all([project, human_user])
    await session.commit()
    human = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=human_user.id, name="Human")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    org_member = OrgMember(id=human.id, org_id=org.id, user_id=human_user.id, role="member")
    access = ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=org_member.id,
                           permission="granted", role="member")
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Advisor story", status="in-review")
    claim, claim_hash = canonical_claim({"summary": "done", "head_sha": None, "intent_hash": None,
                                         "self_review": {"schema_version": 1, "mode": "local", "verdict": "likely_pass"}})
    evidence = Evidence(id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                        type="report", source=RESERVED_EVIDENCE_SOURCE, ref=f"sha256:{claim_hash}",
                        note=claim, created_by=agent.id)
    gate = Gate(id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending", requires_human=True,
                neutral_facts={"advisor_origin": {"schema_version": 1, "story_id": str(story.id),
                    "project_id": str(project.id), "recipient_id": str(agent.id), "evidence_id": str(evidence.id),
                    "claim_hash": claim_hash}})
    session.add_all([human, agent, org_member])
    await session.commit()
    session.add_all([access, story])
    await session.commit()
    session.add_all([evidence, gate])
    await session.commit()
    return org.id, project.id, story.id, agent.id, human.id, gate.id


@pytest.mark.anyio
async def test_advisor_gate_service_rejects_system_and_agent_resolvers_before_mutation():
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_id, _project_id, _story_id, agent_id, _human_id, gate_id = await _seed_advisor_gate(session)
            for resolver_id in (None, agent_id, uuid.uuid4()):
                with pytest.raises(ValueError):
                    await transition_gate(session, org_id, gate_id, "approved", resolver_id=resolver_id)
                await session.rollback()
                gate = await session.get(Gate, gate_id)
                assert gate.status == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_advisor_gate_authorized_human_emits_one_system_event():
    from app.models.event import Event
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_id, _project_id, _story_id, agent_id, human_id, gate_id = await _seed_advisor_gate(session)
            gate = await transition_gate(session, org_id, gate_id, "approved", resolver_id=human_id, note="ok")
            assert gate.status == "approved"
            await session.commit()

        async with Session() as session:
            events = (await session.execute(select(Event).where(Event.org_id == org_id, Event.source_entity_id == gate_id))).scalars().all()
            assert len(events) == 1
            event = events[0]
            assert event.event_type == "gate.resolved"
            assert event.recipient_id == agent_id
            assert event.sender_id is None
            assert event.payload["next_stage"] == "done"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_advisor_gate_rejects_inactive_human_and_inactive_origin_agent():
    from app.models.gate import Gate
    from app.models.member import Member
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_id, _project_id, _story_id, agent_id, human_id, gate_id = await _seed_advisor_gate(session)
            human = await session.get(Member, human_id)
            human.is_active = False
            await session.commit()
            with pytest.raises(ValueError):
                await transition_gate(session, org_id, gate_id, "approved", resolver_id=human_id)
            await session.rollback()
            assert (await session.get(Gate, gate_id)).status == "pending"

            human = await session.get(Member, human_id)
            agent = await session.get(Member, agent_id)
            human.is_active = True
            agent.is_active = False
            await session.commit()
            with pytest.raises(ValueError):
                await transition_gate(session, org_id, gate_id, "approved", resolver_id=human_id)
            await session.rollback()
            assert (await session.get(Gate, gate_id)).status == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_advisor_gate_rejects_semantically_equal_noncanonical_evidence_note():
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_id, _project_id, story_id, _agent_id, human_id, gate_id = await _seed_advisor_gate(session)
            evidence = (await session.execute(select(Evidence).where(Evidence.work_item_id == story_id))).scalar_one()
            evidence.note = json.dumps(json.loads(evidence.note), ensure_ascii=False, indent=2, sort_keys=True)
            await session.commit()
            with pytest.raises(ValueError, match="Advisor-origin integrity error"):
                await transition_gate(session, org_id, gate_id, "approved", resolver_id=human_id)
            await session.rollback()
            assert (await session.get(Gate, gate_id)).status == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_sessions_resolve_once_and_create_exactly_one_event():
    """The Gate row lock is the idempotency boundary, not best-effort Event lookup."""
    from app.models.event import Event
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as seed:
            org_id, _project_id, _story_id, _agent_id, human_id, gate_id = await _seed_advisor_gate(seed)

        async def resolve(status: str) -> str:
            async with Session() as session:
                try:
                    await transition_gate(session, org_id, gate_id, status, resolver_id=human_id)
                    await session.commit()
                    return "resolved"
                except ValueError:
                    await session.rollback()
                    return "rejected_terminal"

        outcomes = await asyncio.gather(resolve("approved"), resolve("rejected"))
        assert sorted(outcomes) == ["rejected_terminal", "resolved"]

        async with Session() as session:
            gate = await session.get(Gate, gate_id)
            events = (await session.execute(select(Event).where(Event.org_id == org_id, Event.source_entity_id == gate_id))).scalars().all()
            assert gate.status in {"approved", "rejected"}
            assert len(events) == 1
            assert events[0].recipient_seq is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pending_linked_advisor_evidence_cannot_be_deleted_but_terminal_and_unlinked_can():
    """Evidence withdrawal uses the same pending-Gate lock as human resolution."""
    from fastapi import HTTPException
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.routers.evidence import delete_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_id, _project_id, story_id, agent_id, _human_id, gate_id = await _seed_advisor_gate(session)
            evidence = (await session.execute(select(Evidence).where(Evidence.work_item_id == story_id))).scalar_one()
            with patch("app.routers.evidence.resolve_member", new=AsyncMock(return_value=SimpleNamespace(id=agent_id))):
                with pytest.raises(HTTPException) as exc:
                    await delete_evidence(evidence.id, session=session, org_id=org_id, auth=SimpleNamespace())
            assert exc.value.status_code == 409
            assert (await session.get(Evidence, evidence.id)) is not None

            gate = await session.get(Gate, gate_id)
            gate.status = "approved"
            await session.commit()

        async with Session() as session:
            with patch("app.routers.evidence.resolve_member", new=AsyncMock(return_value=SimpleNamespace(id=agent_id))):
                await delete_evidence(evidence.id, session=session, org_id=org_id, auth=SimpleNamespace())
            assert await session.get(Evidence, evidence.id) is None
            gate = await session.get(Gate, gate_id)
            assert gate.neutral_facts["advisor_origin"]["evidence_id"] == str(evidence.id)

            # An unlinked reserved claim keeps the existing creator-withdrawal behavior.
            from app.services.advisor_context import RESERVED_EVIDENCE_SOURCE
            loose = Evidence(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                             type="report", source=RESERVED_EVIDENCE_SOURCE, ref="sha256:loose",
                             note="{}", created_by=agent_id)
            session.add(loose)
            await session.commit()
            with patch("app.routers.evidence.resolve_member", new=AsyncMock(return_value=SimpleNamespace(id=agent_id))):
                await delete_evidence(loose.id, session=session, org_id=org_id, auth=SimpleNamespace())
            assert await session.get(Evidence, loose.id) is None
    finally:
        await engine.dispose()


async def _blank_eligible_gate(session, org_id, story_id):
    from app.models.gate import Gate
    gate = Gate(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="advisor_test", status="pending", requires_human=True, neutral_facts={"keep": "fact"})
    session.add(gate)
    await session.commit()
    return gate.id


@pytest.mark.anyio
async def test_first_origin_wins_for_repeated_same_and_different_agent_stamps():
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.advisor_context import lock_and_stamp_advisor_origin

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_id, _project_id, story_id, agent_id, _human_id, _gate_id = await _seed_advisor_gate(session)
            gate_id = await _blank_eligible_gate(session, org_id, story_id)
            story = await session.get(Story, story_id)
            first_evidence, first_hash = uuid.uuid4(), "a" * 64
            assert await lock_and_stamp_advisor_origin(session, gate_id, story, agent_id, first_evidence, first_hash)
            await session.commit()

            assert not await lock_and_stamp_advisor_origin(session, gate_id, story, agent_id, uuid.uuid4(), "b" * 64)
            assert not await lock_and_stamp_advisor_origin(session, gate_id, story, uuid.uuid4(), uuid.uuid4(), "c" * 64)
            await session.commit()
            gate = await session.get(Gate, gate_id)
            assert gate.neutral_facts == {"keep": "fact", "advisor_origin": {
                "schema_version": 1, "story_id": str(story_id), "project_id": str(story.project_id),
                "recipient_id": str(agent_id), "evidence_id": str(first_evidence), "claim_hash": first_hash,
            }}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_sessions_concurrently_stamp_exactly_one_self_consistent_origin():
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.advisor_context import lock_and_stamp_advisor_origin

    engine, Session = await _session_factory()
    try:
        async with Session() as seed:
            org_id, _project_id, story_id, agent_id, _human_id, _gate_id = await _seed_advisor_gate(seed)
            gate_id = await _blank_eligible_gate(seed, org_id, story_id)

        candidate_a = (agent_id, uuid.uuid4(), "a" * 64)
        candidate_b = (uuid.uuid4(), uuid.uuid4(), "b" * 64)

        async def stamp(candidate):
            async with Session() as session:
                story = await session.get(Story, story_id)
                won = await lock_and_stamp_advisor_origin(session, gate_id, story, *candidate)
                await session.commit()
                return won

        outcomes = await asyncio.gather(stamp(candidate_a), stamp(candidate_b))
        assert sorted(outcomes) == [False, True]
        async with Session() as session:
            gate = await session.get(Gate, gate_id)
            origin = gate.neutral_facts["advisor_origin"]
            candidates = {(str(recipient), str(evidence), claim_hash) for recipient, evidence, claim_hash in (candidate_a, candidate_b)}
            assert (origin["recipient_id"], origin["evidence_id"], origin["claim_hash"]) in candidates
            assert origin["story_id"] == str(story_id)
            assert origin["schema_version"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_and_human_transition_serialize_without_pending_gate_losing_evidence():
    """Either lock winner is safe: delete blocks while pending or follows terminal commit."""
    from fastapi import HTTPException
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.routers.evidence import delete_evidence
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as seed:
            org_id, _project_id, story_id, agent_id, human_id, gate_id = await _seed_advisor_gate(seed)
            evidence = (await seed.execute(select(Evidence).where(Evidence.work_item_id == story_id))).scalar_one()
            evidence_id = evidence.id

        async def delete_claim() -> str:
            async with Session() as session:
                with patch("app.routers.evidence.resolve_member", new=AsyncMock(return_value=SimpleNamespace(id=agent_id))):
                    try:
                        await delete_evidence(evidence_id, session=session, org_id=org_id, auth=SimpleNamespace())
                        return "deleted_after_terminal"
                    except HTTPException as exc:
                        assert exc.status_code == 409
                        await session.rollback()
                        return "blocked_while_pending"

        async def resolve() -> str:
            async with Session() as session:
                await transition_gate(session, org_id, gate_id, "approved", resolver_id=human_id)
                await session.commit()
                return "resolved"

        delete_outcome, resolve_outcome = await asyncio.gather(delete_claim(), resolve())
        assert resolve_outcome == "resolved"
        assert delete_outcome in {"blocked_while_pending", "deleted_after_terminal"}
        async with Session() as session:
            gate = await session.get(Gate, gate_id)
            evidence = await session.get(Evidence, evidence_id)
            assert gate.status == "approved"
            # If deletion lost the lock it was rejected, not silently applied.
            assert evidence is not None or delete_outcome == "deleted_after_terminal"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_event_insert_failure_rolls_back_terminal_gate_transition():
    from app.models.event import Event
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as seed:
            org_id, _project_id, _story_id, _agent_id, human_id, gate_id = await _seed_advisor_gate(seed)
        async with Session() as session:
            with patch("app.services.gate_service._emit_advisor_resolution_event",
                       new=AsyncMock(side_effect=RuntimeError("event insert failed"))):
                with pytest.raises(RuntimeError, match="event insert failed"):
                    await transition_gate(session, org_id, gate_id, "approved", resolver_id=human_id)
            await session.rollback()
        async with Session() as session:
            gate = await session.get(Gate, gate_id)
            events = (await session.execute(select(Event).where(Event.org_id == org_id,
                                                                 Event.source_entity_id == gate_id))).scalars().all()
            assert gate.status == "pending"
            assert gate.resolver_id is None
            assert gate.resolved_at is None
            assert events == []
    finally:
        await engine.dispose()
