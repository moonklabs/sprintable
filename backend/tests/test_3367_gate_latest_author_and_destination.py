"""story #3367(3자기점검, 페드루 지적 2026-09-10) — AC7("결재 카드에서... 마지막 수정
주체, 목적지를 확認할 수 있고")의 BE 입력. `GateResponse`에 `sealed_destination_
connection_id`(Gate ORM 실 컬럼, from_attributes 자동)·`latest_author_kind`(신규 배치
enrich, list_gates()가 neutral_facts.draft_id로 site_post_versions 최신 행을 조회)
additive.

確定 매핑:
1. `sealed_destination_connection_id`는 Gate ORM 컬럼명과 일치해 from_attributes로
   자동 채워짐(신규 코드 0) — null=hosted_site.
2. `latest_author_kind`는 **봉인(sealed_content_*)의 작성자가 아니라** draft의 **지금**
   최신 버전 author_kind다 — approved 뒤 편집이면 봉인은 옛 버전에 묶이지만(story
   #3367 본편 규율) latest_author_kind는 새 버전을 따라간다(그게 이 필드의 존재 이유).
3. external_publish가 아닌 게이트는 둘 다 null(sealed_doc_* 관례 동형).
4. list_gates()의 배치 enrich는 N+1 0(sealed_doc_title과 동일 선례) — 서로 다른 draft를
   가진 gate 여럿이 각자 정확한 값으로 매칭된다.

세팅 헬퍼는 test_3367_site_post_submit_gate_seal.py 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3367_site_post_submit_gate_seal import (
    _approve_gate_directly,
    _client_for,
    _draft_body,
    _seed_agent,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

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


@pytest.mark.anyio
async def test_latest_author_kind_tracks_current_version_not_sealed_version():
    """승인 뒤 편집(휴먼)하면 봉인(sealed_content_*)은 옛(에이전트) 버전에 그대로
    묶이지만, latest_author_kind는 새(휴먼) 버전을 따라간다 — 봉인 작성자와 달라지는
    바로 그 케이스가 이 필드의 존재 이유다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_list_before = await client.get(
                "/api/v2/gates", params={"ids": gate_id},
            )
        assert r_list_before.status_code == 200, r_list_before.text
        row_before = r_list_before.json()[0]
        # 상신자는 human이지만 초안 v1의 원작성자는 agent(_seed_agent가 만든 draft) —
        # latest_author_kind는 "지금 최신 버전"(v1, agent) 작성자를 따라간다.
        assert row_before["latest_author_kind"] == "agent"
        assert row_before["sealed_destination_connection_id"] is None  # hosted_site

        # 승인 뒤 편집(휴먼) — 새 버전(v2, human)이 생기고 게이트는 pending 재오픈.
        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, title="2호 글(승인 후 수정)"),
            )
        assert r_edit.status_code == 201, r_edit.text

        async with _client_for(app) as client:
            r_list_after = await client.get(
                "/api/v2/gates", params={"ids": gate_id},
            )
        row_after = r_list_after.json()[0]
        assert row_after["latest_author_kind"] == "human"
        # 봉인 값(sealed_content_sha256)은 옛 버전에 그대로 묶여 있다는 걸 간접 확認 —
        # reapproval_required=True가 그 증거(3367 본편 규율, 이 파일 밖에서 이미 검증됨).
        assert row_after["reapproval_required"] is True
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_other_gate_types_have_null_latest_author_and_destination():
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", status="pending", neutral_facts={},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_detail = await client.get(f"/api/v2/gates/{gate_id}")
        assert r_detail.status_code == 200, r_detail.text
        body = r_detail.json()
        assert body["latest_author_kind"] is None
        assert body["sealed_destination_connection_id"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_gates_batches_latest_author_kind_lookup_no_n_plus_1():
    """뮤테이션 대상 — list_gates()의 latest_author_kind 배치 enrich 블록을 제거하면
    이 테스트가 RED여야 한다. N+1 방지 확認도 겸함(서로 다른 draft를 가진 게이트
    둘이 각자 정확한 작성자로 매칭되는지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_a = await _seed_story(s, org_id, project_id, title="스토리 A")
            story_b = await _seed_story(s, org_id, project_id, title="스토리 B")

        # A: agent가 초안(v1=agent) → human이 상신.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_a, slug="post-a"),
            )
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_a_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{r_a.json()['draft_id']}/submit", json={},
            )

        # B: human이 직접 초안(v1=human) → human이 상신.
        async with _client_for(app) as client:
            r_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_b, slug="post-b"),
            )
            r_b_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{r_b.json()['draft_id']}/submit", json={},
            )

        gate_a_id = r_a_submit.json()["gate_id"]
        gate_b_id = r_b_submit.json()["gate_id"]

        async with _client_for(app) as client:
            r_list = await client.get(
                "/api/v2/gates", params={"ids": f"{gate_a_id},{gate_b_id}"},
            )
        assert r_list.status_code == 200, r_list.text
        rows = {row["id"]: row for row in r_list.json()}
        assert rows[gate_a_id]["latest_author_kind"] == "agent"
        assert rows[gate_b_id]["latest_author_kind"] == "human"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
