"""story #2893(설계안 gate-auto-creation-design-2893 §4, PR④/C1) — 라벨정렬 기반 게이트
생성 트리거(웹훅, 폴링 배제).

원 스토리(#2893) 증상 그 자체: "QA·design·CI가 전부 서고도 merge 게이트 레코드가 없어
PR 작성자가 close→reopen으로 수동 생성". qa:pass+design:pass 라벨이 **둘 다** 갖춰지는
순간(`pull_request.labeled` raw 웹훅)을 게이트 생성의 2차 트리거로 추가한다 — PR
opened/synchronize 등 1차 트리거가 어떤 이유로든(참여 미등록 당시 open됐다가 나중에
등록 등) 게이트를 못 만들었어도, 라벨정렬이 마지막 안전망이 된다.

github_app.py의 실 GitHub API 호출만 mock — DB 왕복은 실 Postgres
(test_2893_gate_pr_scoped_isolation_realdb.py와 동일 관례, 헬퍼 재사용).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from tests.test_2893_gate_pr_scoped_isolation_realdb import (
    _post_app,
    _seed_installation,
    _seed_link,
    _seed_org_project_story,
    _session_factory,
)

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _labeled_payload(*, pr_number, installation_id, head_sha, labels, title="chore: unrelated"):
    return {
        "action": "labeled",
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": False,
            "head": {"sha": head_sha, "ref": f"feat-branch-{pr_number}"},
            "labels": [{"name": name} for name in labels],
        },
    }


async def _gates_for_story(s, story_id):
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    rows = (
        await s.execute(
            select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE)
        )
    ).scalars().all()
    return rows


@pytest.mark.anyio
async def test_labeled_event_with_both_labels_creates_missing_gate():
    """핵심 — opened/synchronize 없이 labeled(둘 다 갖춤) 단독으로도 게이트가 생겨야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680501)
            await _seed_link(s, org, story, pr_number=501)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 95001}),
        ), patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _labeled_payload(
                    pr_number=501, installation_id=680501, head_sha="sha-label-1",
                    labels=["qa:pass", "design:pass"],
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        assert resp.status_code == 200, resp.text

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1, "labeled(둘 다 갖춤) 단독 트리거로 게이트가 생겨야 함"
            assert gates[0].pr_number == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_labeled_event_with_only_one_label_does_not_create_gate():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680502)
            await _seed_link(s, org, story, pr_number=502)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 95002}),
        ), patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _labeled_payload(
                    pr_number=502, installation_id=680502, head_sha="sha-label-2",
                    labels=["qa:pass"],
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        assert resp.status_code == 200, resp.text

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 0, "한 라벨만으로는 생성 트리거가 안 돼야 함(둘 다 정렬 필요)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_labeled_event_with_unrelated_label_does_not_create_gate():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680503)
            await _seed_link(s, org, story, pr_number=503)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 95003}),
        ), patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _labeled_payload(
                    pr_number=503, installation_id=680503, head_sha="sha-label-3",
                    labels=["bug"],
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        assert resp.status_code == 200, resp.text

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_labeled_event_does_not_duplicate_existing_gate():
    """이미 게이트가 있으면(1차 트리거로 생성됐던 경우) labeled 이벤트가 중복 행을 만들면 안
    된다 — find_gate_slot_with_pr_fallback가 기존 행을 찾아 reopen_gate_if_new_sha 분기로
    가고(SHA 동일이라 no-op), 새 create는 안 탄다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680504)
            await _seed_link(s, org, story, pr_number=504)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 95004}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _labeled_payload(
                    pr_number=504, installation_id=680504, head_sha="sha-label-4",
                    labels=["qa:pass", "design:pass"],
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        async with Session() as s:
            gates_first = await _gates_for_story(s, story_id)
            assert len(gates_first) == 1
            first_gate_id = gates_first[0].id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 95005}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _labeled_payload(
                    pr_number=504, installation_id=680504, head_sha="sha-label-4",
                    labels=["qa:pass", "design:pass", "extra"],
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        async with Session() as s:
            gates_second = await _gates_for_story(s, story_id)
            assert len(gates_second) == 1, "두 번째 labeled 이벤트가 중복 행을 만들면 안 됨"
            assert gates_second[0].id == first_gate_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unlabeled_action_with_both_labels_present_does_not_trigger_creation():
    """action이 "labeled"가 아니면(예: unlabeled) 라벨 집합이 같아도 트리거 대상이 아니다 —
    "정렬되는 그 순간"만 게이트 생성 신호이지, 다른 액션에 얹혀 오면 안 된다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680505)
            await _seed_link(s, org, story, pr_number=505)
            story_id = story.id

        payload = _labeled_payload(
            pr_number=505, installation_id=680505, head_sha="sha-label-5",
            labels=["qa:pass", "design:pass"],
        )
        payload["action"] = "unlabeled"

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 95006}),
        ), patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
        assert resp.status_code == 200, resp.text

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 0
    finally:
        await engine.dispose()
