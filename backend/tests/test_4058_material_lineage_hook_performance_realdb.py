"""story #4058(E-RECIPE-1 성공기준 4) — `material_lineage` 모델·`compute_hook_performance`
집계 realdb 검증. doc(entity:doc:c7991109-4349-485b-8599-d7b886c7a951) v3 §3①③ 계약대로:
마스터(evidence.id) → 변주(channel_post_draft/publication, derived_kind로 다형) → hook_key
→ insight_snapshots 합산.

⚠️조인 축 — `compute_hook_performance` docstring 참조: work_item_id 공유가 아니라
**derived_id == insight_snapshots.publication_id** 직접 매치(둘 다 channel_publication.id).
work_item_id로 묶으면 같은 스토리의 다른 훅 변주 성과까지 섞이는 과다집계가 된다 — 이
테스트 작성 중 실측으로 발견해 서비스 함수 자체를 고쳤다(최초 구현은 work_item_id 조인).

세팅 헬퍼는 test_3471_org_content_rules_lint.py에서 재사용(test_3498 분리 선례와 동형
관례) — HTTP 라우팅/게이트가 필요 없는 순수 서비스 함수 테스트라 `_session_factory`
(Base.metadata.create_all, MaterialLineage 포함 — app/models/__init__.py 등재 확認됨)·
`_seed_org`·`_seed_story`만으로 충분하다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3471_org_content_rules_lint import _seed_org, _seed_story, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_master_evidence(session, *, org_id, work_item_id):
    from app.models.evidence import Evidence

    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="url", ref="live-run:master-cut",
    )
    session.add(ev)
    await session.commit()
    return ev.id


async def _seed_lineage(
    session, *, org_id, source_evidence_id, work_item_id, derived_id,
    derived_kind="channel_publication", hook_key="hook_a", relation_kind="platform_cut",
    variant_axis="reels",
):
    from app.models.material_lineage import MaterialLineage

    row = MaterialLineage(
        id=uuid.uuid4(), org_id=org_id, source_evidence_id=source_evidence_id,
        derived_kind=derived_kind, derived_id=derived_id, relation_kind=relation_kind,
        variant_axis=variant_axis, hook_key=hook_key, work_item_id=work_item_id,
    )
    session.add(row)
    await session.commit()
    return row.id


async def _seed_snapshot(
    session, *, org_id, work_item_id, publication_id, status="captured", normalized=None,
    publication_kind="channel_publication",
):
    from app.models.insight_snapshot import InsightSnapshot

    snap = InsightSnapshot(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, publication_kind=publication_kind,
        work_item_id=work_item_id, channel="threads", due_at=datetime.now(timezone.utc) + timedelta(days=1),
        status=status, normalized=normalized,
    )
    session.add(snap)
    await session.commit()
    return snap.id


@pytest.mark.anyio
async def test_material_lineage_check_constraints_reject_unknown_values():
    """migration 0380의 CHECK 2개가 model 미러(evidence.py ck_evidence_type 관례)로도
    실제로 걸린다 — create_all() 기반 테스트가 그 제약을 못 보는 「재료 불일치」 회귀 방지."""
    engine, factory = await _session_factory()
    try:
        from sqlalchemy.exc import IntegrityError

        async with factory() as session:
            org_id, _ = await _seed_org(session)
            work_item_id = uuid.uuid4()
            source_evidence_id = await _seed_master_evidence(session, org_id=org_id, work_item_id=work_item_id)

            with pytest.raises(IntegrityError):
                await _seed_lineage(
                    session, org_id=org_id, source_evidence_id=source_evidence_id,
                    work_item_id=work_item_id, derived_id=uuid.uuid4(), derived_kind="not_a_real_kind",
                )
        async with factory() as session2:
            with pytest.raises(IntegrityError):
                await _seed_lineage(
                    session2, org_id=org_id, source_evidence_id=source_evidence_id,
                    work_item_id=work_item_id, derived_id=uuid.uuid4(), relation_kind="not_a_real_relation",
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_material_lineage_unique_constraint_rejects_duplicate_edge():
    """같은 (source_evidence_id, derived_kind, derived_id, relation_kind) 조합은 1건만."""
    engine, factory = await _session_factory()
    try:
        from sqlalchemy.exc import IntegrityError
        from app.models.material_lineage import MaterialLineage

        async with factory() as session:
            org_id, _ = await _seed_org(session)
            work_item_id = uuid.uuid4()
            source_evidence_id = await _seed_master_evidence(session, org_id=org_id, work_item_id=work_item_id)
            derived_id = uuid.uuid4()

            row = MaterialLineage(
                id=uuid.uuid4(), org_id=org_id, source_evidence_id=source_evidence_id,
                derived_kind="channel_publication", derived_id=derived_id, relation_kind="platform_cut",
                variant_axis="reels", hook_key="hook_a", work_item_id=work_item_id,
            )
            session.add(row)
            await session.commit()

            dup = MaterialLineage(
                id=uuid.uuid4(), org_id=org_id, source_evidence_id=source_evidence_id,
                derived_kind="channel_publication", derived_id=derived_id, relation_kind="platform_cut",
                variant_axis="shorts", hook_key="hook_b", work_item_id=work_item_id,
            )
            session.add(dup)
            with pytest.raises(IntegrityError):
                await session.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_compute_hook_performance_sums_across_variants_and_preserves_null():
    """같은 hook_key를 쓴 변주 2건(서로 다른 스토리·서로 다른 publication)의 captured
    snapshot을 합산 — null≠0 보존(house 관례): 측정 안 된 키는 0이 아니라 None으로 남는다.
    같은 스토리 안에 다른 hook_key를 쓴 변주가 섞여 있어도(work_item_id 공유) 안 새는지도
    확인(과다집계 회귀 방지 — 이 함수 자신이 최초 구현에서 실제로 걸렸던 결함)."""
    from app.services.material_lineage import compute_hook_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story_a = await _seed_story(session, org_id, project_id, title="영상 제작 A")
            story_b = await _seed_story(session, org_id, project_id, title="영상 제작 B")

            ev_a = await _seed_master_evidence(session, org_id=org_id, work_item_id=story_a)
            ev_b = await _seed_master_evidence(session, org_id=org_id, work_item_id=story_b)

            pub_a = uuid.uuid4()
            pub_b_hook_a = uuid.uuid4()
            pub_b_hook_b = uuid.uuid4()

            # story_a: hook_a 변주 1건 발행.
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev_a, work_item_id=story_a, derived_id=pub_a, hook_key="hook_a")
            # story_b: 같은 스토리 안에 hook_a·hook_b 두 변주가 각각 다른 publication으로 발행
            # — work_item_id는 둘 다 story_b로 같다(과다집계 회귀의 정확한 재현 조건).
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev_b, work_item_id=story_b, derived_id=pub_b_hook_a, hook_key="hook_a")
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev_b, work_item_id=story_b, derived_id=pub_b_hook_b, hook_key="hook_b")

            await _seed_snapshot(session, org_id=org_id, work_item_id=story_a, publication_id=pub_a, normalized={"impressions": 100, "clicks": None})
            await _seed_snapshot(session, org_id=org_id, work_item_id=story_b, publication_id=pub_b_hook_a, normalized={"impressions": 50, "clicks": None})
            await _seed_snapshot(session, org_id=org_id, work_item_id=story_b, publication_id=pub_b_hook_b, normalized={"impressions": 9999, "clicks": 7})
            # pending 상태 snapshot(미완료) — 합산에서 반드시 제외(양성대조).
            await _seed_snapshot(session, org_id=org_id, work_item_id=story_a, publication_id=pub_a, status="pending", normalized={"impressions": 424242})

            result = await compute_hook_performance(session, org_id=org_id, hook_key="hook_a")
            assert result.variant_count == 2
            assert result.snapshot_count == 2
            assert result.totals["impressions"] == 150, "hook_b(9999)가 섞이면 과다집계 회귀"
            assert result.totals["clicks"] is None, "measured 0 되면 안 됨 — null≠0 위반"
            assert result.totals["reach"] is None  # 아예 건드리지 않은 키도 None 유지

            hook_b_result = await compute_hook_performance(session, org_id=org_id, hook_key="hook_b")
            assert hook_b_result.variant_count == 1
            assert hook_b_result.snapshot_count == 1
            assert hook_b_result.totals["impressions"] == 9999
            assert hook_b_result.totals["clicks"] == 7
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_compute_hook_performance_draft_variant_has_no_performance_yet():
    """`channel_post_draft`(발행 前) 변주는 variant_count엔 잡히지만 아직 발행 실적이 없어
    snapshot 합산 대상이 아니다 — 지어내지 않는다."""
    from app.services.material_lineage import compute_hook_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story = await _seed_story(session, org_id, project_id)
            ev = await _seed_master_evidence(session, org_id=org_id, work_item_id=story)
            await _seed_lineage(
                session, org_id=org_id, source_evidence_id=ev, work_item_id=story,
                derived_id=uuid.uuid4(), derived_kind="channel_post_draft", hook_key="hook_draft",
            )

            result = await compute_hook_performance(session, org_id=org_id, hook_key="hook_draft")
            assert result.variant_count == 1
            assert result.snapshot_count == 0
            assert all(v is None for v in result.totals.values())
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_compute_hook_performance_unknown_hook_key_returns_empty_summary():
    """등재된 계보가 0건인 hook_key — 에러 대신 빈 요약(전부 None/0). 지어내지 않는다."""
    from app.services.material_lineage import compute_hook_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, _ = await _seed_org(session)
            result = await compute_hook_performance(session, org_id=org_id, hook_key="never_registered")
            assert result.variant_count == 0
            assert result.snapshot_count == 0
            assert all(v is None for v in result.totals.values())
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_compute_hook_performance_is_org_scoped():
    """다른 org의 같은 hook_key는 안 섞인다 — org_id 스코프 회귀 방지."""
    from app.services.material_lineage import compute_hook_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_a, proj_a = await _seed_org(session)
            org_b, proj_b = await _seed_org(session)
            story_a = await _seed_story(session, org_a, proj_a)
            story_b = await _seed_story(session, org_b, proj_b)

            ev_a = await _seed_master_evidence(session, org_id=org_a, work_item_id=story_a)
            ev_b = await _seed_master_evidence(session, org_id=org_b, work_item_id=story_b)
            pub_a, pub_b = uuid.uuid4(), uuid.uuid4()
            await _seed_lineage(session, org_id=org_a, source_evidence_id=ev_a, work_item_id=story_a, derived_id=pub_a, hook_key="shared_key")
            await _seed_lineage(session, org_id=org_b, source_evidence_id=ev_b, work_item_id=story_b, derived_id=pub_b, hook_key="shared_key")
            await _seed_snapshot(session, org_id=org_a, work_item_id=story_a, publication_id=pub_a, normalized={"impressions": 10})
            await _seed_snapshot(session, org_id=org_b, work_item_id=story_b, publication_id=pub_b, normalized={"impressions": 20})

            result_a = await compute_hook_performance(session, org_id=org_a, hook_key="shared_key")
            assert result_a.variant_count == 1
            assert result_a.totals["impressions"] == 10
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_material_lineage_endpoint_scoped_to_work_item_and_org():
    """라우터 함수 직접 호출(evidence.py list_evidence 관례 — Header() DI가 없는 이
    엔드포인트는 ASGI 없이도 안전) — 디디 #4061 buildLineageTree(edges)가 소비할
    원자료가 work_item_id·org_id로 정확히 스코프되는지."""
    from app.routers.material_lineage import list_material_lineage

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story_a = await _seed_story(session, org_id, project_id, title="A")
            story_b = await _seed_story(session, org_id, project_id, title="B")
            other_org, other_project = await _seed_org(session)
            other_story = await _seed_story(session, other_org, other_project)

            ev_a = await _seed_master_evidence(session, org_id=org_id, work_item_id=story_a)
            ev_other = await _seed_master_evidence(session, org_id=other_org, work_item_id=other_story)
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev_a, work_item_id=story_a, derived_id=uuid.uuid4(), hook_key="hook_a")
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev_a, work_item_id=story_a, derived_id=uuid.uuid4(), hook_key="hook_b")
            # 다른 스토리(같은 org) — 안 섞여야 함.
            ev_b = await _seed_master_evidence(session, org_id=org_id, work_item_id=story_b)
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev_b, work_item_id=story_b, derived_id=uuid.uuid4(), hook_key="hook_c")
            # 다른 org — 안 섞여야 함(org_id 스코프 회귀 방지).
            await _seed_lineage(session, org_id=other_org, source_evidence_id=ev_other, work_item_id=story_a, derived_id=uuid.uuid4(), hook_key="hook_leak")

            edges = await list_material_lineage(work_item_id=story_a, session=session, org_id=org_id, _auth=None)
            assert {e.hook_key for e in edges} == {"hook_a", "hook_b"}
            assert all(e.work_item_id == story_a for e in edges)
            assert all(e.master_title == "A" for e in edges)  # 디디 갭2 ① — uuid 대신 표시명
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_material_lineage_endpoint_exposes_channel_display_name():
    """디디 갭2 ②(2026-09-19) — 변주의 channel을 denorm으로 노출. draft/publication
    양쪽 다·매칭 안 되는 derived_id는 fail-soft(None, 에러 아님)."""
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_publication import ChannelPublication
    from app.routers.material_lineage import list_material_lineage

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story = await _seed_story(session, org_id, project_id, title="채널 표시명 테스트")
            ev = await _seed_master_evidence(session, org_id=org_id, work_item_id=story)

            draft_id = uuid.uuid4()
            session.add(ChannelPostDraft(
                id=draft_id, org_id=org_id, work_item_id=story, channel="instagram_sandbox",
                connection_id=uuid.uuid4(),
            ))
            pub_id = uuid.uuid4()
            session.add(ChannelPublication(
                id=pub_id, org_id=org_id, gate_id=uuid.uuid4(), version_id=uuid.uuid4(),
                connection_id=uuid.uuid4(), channel="threads",
            ))
            await session.commit()

            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev, work_item_id=story, derived_id=draft_id, derived_kind="channel_post_draft", hook_key="hook_draft")
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev, work_item_id=story, derived_id=pub_id, derived_kind="channel_publication", hook_key="hook_pub")
            # 매칭 row가 아예 없는 derived_id — fail-soft None(에러 아님).
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev, work_item_id=story, derived_id=uuid.uuid4(), hook_key="hook_orphan")

            edges = await list_material_lineage(work_item_id=story, session=session, org_id=org_id, _auth=None)
            by_hook = {e.hook_key: e.channel for e in edges}
            assert by_hook["hook_draft"] == "instagram_sandbox"
            assert by_hook["hook_pub"] == "threads"
            assert by_hook["hook_orphan"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hook_performance_endpoint_matches_service_and_handles_unknown_key():
    """라우터 함수 직접 호출 — HookPerformanceView가 compute_hook_performance 값을
    그대로 실어 나르는지(변환 손실 0), 미등록 hook_key도 에러 없이 빈 요약."""
    from app.routers.material_lineage import get_hook_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story = await _seed_story(session, org_id, project_id)
            ev = await _seed_master_evidence(session, org_id=org_id, work_item_id=story)
            pub = uuid.uuid4()
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev, work_item_id=story, derived_id=pub, hook_key="hook_x")
            await _seed_snapshot(session, org_id=org_id, work_item_id=story, publication_id=pub, normalized={"impressions": 42})

            view = await get_hook_performance(hook_key="hook_x", session=session, org_id=org_id, _auth=None)
            assert view.hook_key == "hook_x"
            assert view.variant_count == 1
            assert view.snapshot_count == 1
            assert view.totals["impressions"] == 42

            empty_view = await get_hook_performance(hook_key="never_seen", session=session, org_id=org_id, _auth=None)
            assert empty_view.variant_count == 0
            assert empty_view.snapshot_count == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_material_performance_endpoint_returns_snapshots_for_owned_publication():
    """PO 지적(2026-09-19) — 소재(변주) 단위 성과 노출. derived_id(=publication_id)로
    기존 insight_snapshots.py 조회 축을 그대로 재사용하는지."""
    from app.routers.material_lineage import get_material_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story = await _seed_story(session, org_id, project_id)
            ev = await _seed_master_evidence(session, org_id=org_id, work_item_id=story)
            pub = uuid.uuid4()
            await _seed_lineage(session, org_id=org_id, source_evidence_id=ev, work_item_id=story, derived_id=pub, hook_key="hook_x")
            await _seed_snapshot(session, org_id=org_id, work_item_id=story, publication_id=pub, status="captured", normalized={"impressions": 100})
            await _seed_snapshot(session, org_id=org_id, work_item_id=story, publication_id=pub, status="pending", normalized=None)

            views = await get_material_performance(derived_id=pub, session=session, org_id=org_id, _auth=None)
            assert len(views) == 2  # organic_snapshots_only는 paid만 거른다 — pending도 목록엔 포함(상태는 소비부 판단)
            captured = [v for v in views if v.status == "captured"]
            assert len(captured) == 1
            assert captured[0].normalized["impressions"] == 100
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_material_performance_endpoint_draft_variant_returns_empty_not_error():
    """channel_post_draft(발행 前) 변주 — derived_id가 publication이 아니므로 빈 목록,
    에러 아님(지어내지 않는다)."""
    from app.routers.material_lineage import get_material_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_id, project_id = await _seed_org(session)
            story = await _seed_story(session, org_id, project_id)
            ev = await _seed_master_evidence(session, org_id=org_id, work_item_id=story)
            draft_id = uuid.uuid4()
            await _seed_lineage(
                session, org_id=org_id, source_evidence_id=ev, work_item_id=story,
                derived_id=draft_id, derived_kind="channel_post_draft", hook_key="hook_draft",
            )
            views = await get_material_performance(derived_id=draft_id, session=session, org_id=org_id, _auth=None)
            assert views == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_material_performance_endpoint_cross_org_id_returns_empty_not_leak():
    """다른 org 소유 derived_id를 org_id 바꿔 조회 — 존재 비노출(빈 목록), 타 org
    스냅샷이 새지 않는다."""
    from app.routers.material_lineage import get_material_performance

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_a, proj_a = await _seed_org(session)
            org_b, proj_b = await _seed_org(session)
            story_a = await _seed_story(session, org_a, proj_a)
            ev_a = await _seed_master_evidence(session, org_id=org_a, work_item_id=story_a)
            pub_a = uuid.uuid4()
            await _seed_lineage(session, org_id=org_a, source_evidence_id=ev_a, work_item_id=story_a, derived_id=pub_a, hook_key="hook_a")
            await _seed_snapshot(session, org_id=org_a, work_item_id=story_a, publication_id=pub_a, normalized={"impressions": 999})

            views = await get_material_performance(derived_id=pub_a, session=session, org_id=org_b, _auth=None)
            assert views == []
    finally:
        await engine.dispose()
