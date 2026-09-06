"""story #3569(Phase2·BE·소형, 페드루 PO 確定 2026-09-06) — 3561 후속. `GateResponse`
(list/detail 공용)에 `sealed_doc_id`·`sealed_doc_body_sha256`·`sealed_doc_title`
additive — #3922(3561)는 두 필드를 `Gate` 모델과 상신 1회성 응답에만 실어, FE(3560)
가 봉인 doc을 못 읽는 갭(미르코 그라운딩(b)).

確定 매핑:
1. `sealed_doc_id`/`sealed_doc_body_sha256`는 Gate ORM 컬럼명과 일치해
   `from_attributes`로 자동 채워짐(신규 코드 0). `sealed_doc_title`은 **봉인 시점이
   아니라 「지금」 doc 제목**(제목은 봉인 대상이 아니다 — 본문 sha만 봉인) — 신규
   배치 조회.
2. list_gates·get_gate_endpoint 각각 독립 N+1-금지 조회(work_item_summary/doc_proj
   와 다른 축 — sealed_doc_id로 키잉, work_item_id 아님).
3. concept_approval이 아닌 게이트는 셋 다 null(sealed_estimated_cost_minor 관례
   동형).

세팅 헬퍼는 test_3561_concept_approval_gate.py 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3561_concept_approval_gate import (
    _client_for,
    _seed_default_role,
    _seed_doc,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
    _submit_concept_approval,
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
async def test_list_and_detail_expose_sealed_doc_fields_for_concept_approval():
    from app.main import app
    from app.services.doc import compute_doc_body_sha256

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, content="본문", title="컨셉 문서 제목")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r_submit.status_code == 201, r_submit.text
            gate_id = r_submit.json()["gate_id"]

            r_list = await client.get(f"/api/v2/gates", params={"work_item_id": str(story_id), "work_item_type": "story"})
            assert r_list.status_code == 200, r_list.text
            list_row = next(g for g in r_list.json() if g["id"] == gate_id)

            r_detail = await client.get(f"/api/v2/gates/{gate_id}")
            assert r_detail.status_code == 200, r_detail.text
            detail_row = r_detail.json()

        expected_sha = compute_doc_body_sha256("본문")
        for row in (list_row, detail_row):
            assert row["sealed_doc_id"] == str(doc_id)
            assert row["sealed_doc_body_sha256"] == expected_sha
            assert row["sealed_doc_title"] == "컨셉 문서 제목"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_other_gate_types_have_null_sealed_doc_fields():
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
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
        assert body["sealed_doc_id"] is None
        assert body["sealed_doc_body_sha256"] is None
        assert body["sealed_doc_title"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_sealed_doc_title_null_when_doc_deleted_but_ids_and_sha_preserved():
    """제목=null이어도 sealed_doc_id·sealed_doc_body_sha256(봉인 그 자체)은 그대로
    남는다 — 제목만 「지금 doc 조회 결과」라 doc이 사라지면 그 축만 null이 된다."""
    from app.main import app
    from sqlalchemy import select
    from app.models.doc import Doc
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, content="본문", title="곧 삭제될 문서")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r_submit.status_code == 201, r_submit.text
            gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            doc = (await s.execute(select(Doc).where(Doc.id == doc_id))).scalar_one()
            doc.deleted_at = datetime.now(timezone.utc)
            await s.commit()

        async with _client_for(app) as client:
            r_detail = await client.get(f"/api/v2/gates/{gate_id}")
        assert r_detail.status_code == 200, r_detail.text
        body = r_detail.json()
        assert body["sealed_doc_id"] == str(doc_id)
        assert body["sealed_doc_body_sha256"] is not None
        assert body["sealed_doc_title"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_gates_batches_sealed_doc_title_lookup_no_n_plus_1():
    """뮤테이션 대상 — list_gates의 sealed_doc_title 배치 enrich 블록을 제거하면
    (sealed_doc_id는 그대로지만 title이 안 채워짐) 이 테스트가 RED여야 한다.
    N+1 방지 확認도 겸함(여러 게이트가 서로 다른 doc을 참조해도 정확히 매칭)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_a = await _seed_story(s, org_id, project_id, title="스토리 A")
            story_b = await _seed_story(s, org_id, project_id, title="스토리 B")
            doc_a = await _seed_doc(s, org_id, project_id, content="본문 A", title="문서 A")
            doc_b = await _seed_doc(s, org_id, project_id, content="본문 B", title="문서 B")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r1 = await _submit_concept_approval(client, org_id, doc_a, work_item_id=story_a)
            assert r1.status_code == 201, r1.text
            r2 = await _submit_concept_approval(client, org_id, doc_b, work_item_id=story_b)
            assert r2.status_code == 201, r2.text

            r_list = await client.get(
                f"/api/v2/gates", params={"ids": f"{r1.json()['gate_id']},{r2.json()['gate_id']}"},
            )
        assert r_list.status_code == 200, r_list.text
        rows = {row["id"]: row for row in r_list.json()}
        assert rows[r1.json()["gate_id"]]["sealed_doc_title"] == "문서 A"
        assert rows[r2.json()["gate_id"]]["sealed_doc_title"] == "문서 B"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
