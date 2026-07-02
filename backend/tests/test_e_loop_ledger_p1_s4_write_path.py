"""E-LOOP-LEDGER P1-S4(story dadd1857): write-path embedding 큐잉 검증.

4개 write-path 지점(hypothesis create/update·loop create·loop_artifact create·S5 decide)이
실제로 embeddings row를 pending으로 큐잉하는지, content_hash 무변경 시 no-op(재큐잉 방지)인지,
S5 decide 시 choose/rejection_reason 포함 텍스트로 재큐잉되는지를 실 DB로 검증한다.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("25000000-0000-0000-0000-000000000001")
USER = uuid.UUID("25000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("25000000-0000-0000-0000-0000000000b1")
PROJ = uuid.UUID("25000000-0000-0000-0000-000000000002")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s):
    for sql in [
        f"DELETE FROM embeddings WHERE org_id='{ORG}'",
        f"DELETE FROM loop_artifacts WHERE org_id='{ORG}'",
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C25','c25org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c25.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _fetch_embedding(s, entity_type, entity_id):
    from app.models.embedding import Embedding
    return (await s.execute(
        select(Embedding).where(Embedding.entity_type == entity_type, Embedding.entity_id == entity_id)
    )).scalar_one_or_none()


# ── hypothesis create/update ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_hypothesis_enqueues_pending_embedding():
    from app.schemas.hypothesis import HypothesisCreate
    from app.services.hypothesis import create_hypothesis
    from app.services.member_resolver import resolve_member

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            caller = await resolve_member(_auth(), ORG, s, project_id=PROJ)
            out = await create_hypothesis(s, ORG, caller, HypothesisCreate(
                project_id=PROJ, statement="loops should improve retention",
                metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc),
            ))
            await s.commit()

            emb = await _fetch_embedding(s, "hypothesis", out.id)
            assert emb is not None
            assert emb.status == "pending"
            assert emb.embedding_text == "loops should improve retention"
            assert emb.embedding is None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_update_hypothesis_statement_reenqueues_only_when_changed():
    from app.schemas.hypothesis import HypothesisCreate, HypothesisUpdate
    from app.services.hypothesis import create_hypothesis, update_hypothesis
    from app.services.member_resolver import resolve_member

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            caller = await resolve_member(_auth(), ORG, s, project_id=PROJ)
            out = await create_hypothesis(s, ORG, caller, HypothesisCreate(
                project_id=PROJ, statement="v1",
                metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc),
            ))
            await s.commit()
            emb_v1 = await _fetch_embedding(s, "hypothesis", out.id)
            hash_v1 = emb_v1.content_hash

        # 무변경 필드(confidence)만 업데이트 — content_hash 그대로여야(no-op).
        async with Session() as s:
            await update_hypothesis(s, ORG, caller, out.id, HypothesisUpdate(confidence=0.5))
            await s.commit()
            emb_after_noop = await _fetch_embedding(s, "hypothesis", out.id)
            assert emb_after_noop.content_hash == hash_v1

        # statement 변경 — content_hash 갱신+status pending 재큐잉.
        async with Session() as s:
            await update_hypothesis(s, ORG, caller, out.id, HypothesisUpdate(statement="v2 changed"))
            await s.commit()
            emb_v2 = await _fetch_embedding(s, "hypothesis", out.id)
            assert emb_v2.content_hash != hash_v1
            assert emb_v2.embedding_text == "v2 changed"
            assert emb_v2.status == "pending"
    finally:
        await eng.dispose()


# ── loop create ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_loop_enqueues_title_and_goal_tags():
    from app.schemas.loop import LoopCreate
    from app.services.loop import create_loop
    from app.services.member_resolver import resolve_member

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            # S14: hypothesis_id 필수화됐으므로(이 테스트의 관심사는 embedding enqueue) 시드해서 우회.
            from app.models.hypothesis import Hypothesis
            hyp = Hypothesis(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=uuid.uuid4(),
                statement="s", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), status="proposed",
            )
            s.add(hyp)
            await s.commit()
            caller = await resolve_member(_auth(), ORG, s, project_id=PROJ)
            out = await create_loop(s, ORG, caller, LoopCreate(
                project_id=PROJ, title="Improve onboarding", goal_tags=["retention", "activation"],
                hypothesis_id=hyp.id,
            ))
            await s.commit()

            emb = await _fetch_embedding(s, "loop", out.id)
            assert emb is not None
            assert emb.status == "pending"
            assert emb.embedding_text == "Improve onboarding\nretention activation"
    finally:
        await eng.dispose()


# ── loop_artifact create + S5 decide 재큐잉 ─────────────────────────────────

async def _seed_asset(s):
    from app.models.asset import Asset
    a = Asset(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ, container="uploads",
        object_path=f"org/{ORG}/asset-{uuid.uuid4().hex[:8]}.png", name="a.png", size_bytes=1,
    )
    s.add(a)
    await s.commit()
    return a.id


@pytest.mark.anyio
async def test_create_loop_artifact_enqueues_variant_label_only():
    from app.repositories.loop import LoopRunRepository
    from app.schemas.loop import LoopArtifactCreate
    from app.services.loop import create_loop_artifact
    from app.services.member_resolver import resolve_member

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            asset_id = await _seed_asset(s)
            loop = await LoopRunRepository(s, ORG).create(
                project_id=PROJ, title="L", goal_tags=[], status="deciding",
                created_by_member_id=uuid.uuid4(),
            )
            await s.commit()
            caller = await resolve_member(_auth(), ORG, s, project_id=PROJ)
            out = await create_loop_artifact(s, ORG, caller, loop, LoopArtifactCreate(
                variant_group="headline", variant_label="Variant A: bold CTA", asset_id=asset_id,
            ))
            await s.commit()

            emb = await _fetch_embedding(s, "loop_artifact", out.id)
            assert emb is not None
            assert emb.embedding_text == "Variant A: bold CTA"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_decide_reenqueues_artifact_with_reason_included():
    """S5 decide 시 choose_reason/rejection_reason이 포함된 온전한 텍스트로 재큐잉되는지 —
    create 시점(variant_label만)과 다른 content_hash로 갱신되는지까지 실증."""
    from app.repositories.loop import LoopArtifactRepository, LoopRunRepository
    from app.schemas.loop import LoopArtifactCreate, LoopArtifactRejection, LoopDecisionRequest, VariantGroupDecision
    from app.services.loop import create_loop_artifact, decide_loop_artifacts
    from app.services.member_resolver import resolve_member

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            asset1 = await _seed_asset(s)
            asset2 = await _seed_asset(s)
            loop = await LoopRunRepository(s, ORG).create(
                project_id=PROJ, title="L", goal_tags=[], status="deciding",
                created_by_member_id=uuid.uuid4(),
            )
            await s.commit()
            caller = await resolve_member(_auth(), ORG, s, project_id=PROJ)
            a1 = await create_loop_artifact(s, ORG, caller, loop, LoopArtifactCreate(
                variant_group="headline", variant_label="A", asset_id=asset1,
            ))
            a2 = await create_loop_artifact(s, ORG, caller, loop, LoopArtifactCreate(
                variant_group="headline", variant_label="B", asset_id=asset2,
            ))
            await s.commit()
            emb_a1_before = await _fetch_embedding(s, "loop_artifact", a1.id)
            hash_before = emb_a1_before.content_hash

        async with Session() as s:
            await decide_loop_artifacts(s, ORG, caller, loop, LoopDecisionRequest(decisions=[
                VariantGroupDecision(
                    variant_group="headline", chosen_artifact_id=a1.id,
                    choose_reason="Higher click-through in A/B test",
                    rejections=[LoopArtifactRejection(artifact_id=a2.id, rejection_reason="Confusing copy")],
                ),
            ]))
            await s.commit()

            emb_a1_after = await _fetch_embedding(s, "loop_artifact", a1.id)
            assert emb_a1_after.content_hash != hash_before
            assert emb_a1_after.embedding_text == "A\nHigher click-through in A/B test"
            assert emb_a1_after.status == "pending"

            emb_a2_after = await _fetch_embedding(s, "loop_artifact", a2.id)
            assert emb_a2_after.embedding_text == "B\nConfusing copy"
    finally:
        await eng.dispose()
