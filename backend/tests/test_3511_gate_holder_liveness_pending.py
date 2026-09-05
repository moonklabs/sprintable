"""story #3511(Phase1·BE·결함·소형, 페드루 PO 確定 2026-09-05) — `resolve_gate_holder_
draft_id`의 라이브니스 우회가 `status == "approved"`에만 걸려 있어, 회수(unpublish) 뒤
새 draft/버전이 생기면(`_reseal_gate_on_new_version`이 무조건 pending+reapproval_
required=True로 되돌림 — 라이브니스 무관) 다음 상신 시점엔 이미 status가 "pending"이라
같은 우회가 다시는 안 먹어 영구 409(SITE_POST_GATE_ALREADY_HELD·CHANNEL_POST_GATE_
ALREADY_HELD)가 되던 결함.

fix = `app/services/gate_service.py::resolve_gate_holder_draft_id`의 라이브니스 체크에서
`status == "approved" and` 조건을 없앤다(1줄) — pending에도 적용.

세팅 헬퍼는 test_3502_insights_board.py/test_e4fc29fa_destination_axis.py와 동형(중복
재발명 금지). `resolve_gate_holder_draft_id`를 직접 호출해 라이브니스 판정 자체를
핀 박는다(HTTP round-trip·외부 어댑터 모킹 불요 — 이 함수 자체가 순수하게 DB 행만
본다).

페드루 PO 확定(2026-09-05, 처방 승인 코멘트) — 세 시나리오 「site_post·channel_post
동형」:
① pending+미발행(발행 행 0건) — `_gate_publication_is_live`의 보수 판정("행 0=쥔다")이
   유일한 안전판. 다른 draft가 여전히 막혀야 한다.
② approved+live(회수 안 됨) — AC2 회귀, 계속 홀드.
③ pending+unpublished(3478-B' 경로) — 다른 draft가 통과해야 한다(None 반환).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


async def _seed_gate(session, *, org_id, work_item_id, status, holding_draft_id, reapproval_required=False):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        gate_type="external_publish", status=status,
        neutral_facts={"draft_id": str(holding_draft_id)},
        reapproval_required=reapproval_required,
    )
    session.add(gate)
    await session.commit()
    return gate


async def _seed_site_post(session, *, org_id, work_item_id, gate_id, published_at, unpublished_at=None, slug=None):
    from app.models.site_post import SitePost

    post = SitePost(
        id=uuid.uuid4(), org_id=org_id, lang="ko", slug=slug or f"post-{uuid.uuid4().hex[:8]}",
        title="T", summary="요약", tags=[], body_md="본문", published_at=published_at,
        source_story_id=work_item_id, gate_id=gate_id, unpublished_at=unpublished_at,
    )
    session.add(post)
    await session.commit()
    return post


async def _seed_channel_publication(session, *, org_id, gate_id, status, published_at, channel="threads"):
    from app.models.channel_publication import ChannelPublication

    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=uuid.uuid4(),
        connection_id=uuid.uuid4(), channel=channel, status=status,
        external_id=f"ext-{uuid.uuid4().hex[:8]}", permalink="https://example.com/post",
        published_at=published_at,
    )
    session.add(pub)
    await session.commit()
    return pub


# ─── site_post(hosted_site·wordpress/webhook 공용 — SitePost.gate_id 축) ──────


@pytest.mark.anyio
async def test_site_post_pending_never_published_still_holds():
    """① 방금 상신한 진짜 pending(발행 행 0건) — 다른 draft가 여전히 막혀야 한다.
    이 assert가 없으면 아래 ③의 fix가 "회수 안 된 pending도 다 뚫는" 반쪽짜리가 된다."""
    from app.services.gate_service import resolve_gate_holder_draft_id

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            draft_a = uuid.uuid4()
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id, status="pending", holding_draft_id=draft_a)

            holder = await resolve_gate_holder_draft_id(s, gate, this_draft_id=uuid.uuid4())
        assert holder == draft_a, "발행 행이 아예 없는 pending은 보수적으로 계속 홀드해야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_approved_live_still_holds_regression():
    """② AC2 회귀 — 승인 뒤 편집(회수 안 됨), 발행이 여전히 live면 계속 홀드."""
    from app.services.gate_service import resolve_gate_holder_draft_id

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            draft_a = uuid.uuid4()
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id, status="approved", holding_draft_id=draft_a)
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, gate_id=gate.id,
                published_at=datetime.now(timezone.utc), unpublished_at=None,
            )

            holder = await resolve_gate_holder_draft_id(s, gate, this_draft_id=uuid.uuid4())
        assert holder == draft_a, "회수 안 된 live 발행은 approved 상태에서 계속 홀드해야 한다(회귀 0)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_pending_after_unpublish_releases_holder():
    """③ 3478-B' 경로 — 회수됐는데 훅이 pending+reapproval로 되돌린 상태. 다른 draft가
    통과해야 한다(#3511 원 증상)."""
    from app.services.gate_service import resolve_gate_holder_draft_id

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            draft_a = uuid.uuid4()
            gate = await _seed_gate(
                s, org_id=org_id, work_item_id=story_id, status="pending",
                holding_draft_id=draft_a, reapproval_required=True,
            )
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, gate_id=gate.id,
                published_at=datetime.now(timezone.utc), unpublished_at=datetime.now(timezone.utc),
            )

            holder = await resolve_gate_holder_draft_id(s, gate, this_draft_id=uuid.uuid4())
        assert holder is None, "회수(unpublish)된 뒤 pending으로 되돌아간 게이트는 새 draft를 막으면 안 된다"
    finally:
        await engine.dispose()


# ─── channel_post(threads 등 — ChannelPublication.gate_id 축, site_post와 동형) ──


@pytest.mark.anyio
async def test_channel_post_pending_never_published_still_holds():
    from app.services.gate_service import resolve_gate_holder_draft_id

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            draft_a = uuid.uuid4()
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id, status="pending", holding_draft_id=draft_a)

            holder = await resolve_gate_holder_draft_id(s, gate, this_draft_id=uuid.uuid4())
        assert holder == draft_a
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_approved_live_still_holds_regression():
    from app.services.gate_service import resolve_gate_holder_draft_id

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            draft_a = uuid.uuid4()
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id, status="approved", holding_draft_id=draft_a)
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, status="published",
                published_at=datetime.now(timezone.utc),
            )

            holder = await resolve_gate_holder_draft_id(s, gate, this_draft_id=uuid.uuid4())
        assert holder == draft_a
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_pending_after_unpublish_releases_holder():
    from app.services.gate_service import resolve_gate_holder_draft_id

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            draft_a = uuid.uuid4()
            gate = await _seed_gate(
                s, org_id=org_id, work_item_id=story_id, status="pending",
                holding_draft_id=draft_a, reapproval_required=True,
            )
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, status="unpublished",
                published_at=datetime.now(timezone.utc),
            )

            holder = await resolve_gate_holder_draft_id(s, gate, this_draft_id=uuid.uuid4())
        assert holder is None
    finally:
        await engine.dispose()
