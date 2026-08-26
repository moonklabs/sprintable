"""story #2893(설계안 gate-auto-creation-design-2893 §3, PR②/B1+B2-a) — SHA-diff 자동
재-pending은 이미 #2813에서 완성돼 있었다(reopen_gate_if_new_sha). 이 PR의 신규 축은 B2-a
(라벨 자동 unlabel) 하나 — 「라벨=검증된 SHA에 대한 약속」 시맨틱을 웹훅 경로에 배선한다:
synchronize로 head SHA가 anchor(gate.approved_head_sha)와 달라져 실제 재-pending이 발생하면
qa:pass/design:pass 라벨 제거를 GitHub에 요청해야 한다.

실 GitHub API(remove_pr_label/create_check_run)만 mock — DB 왕복은 실 Postgres
(test_2893_gate_pr_scoped_isolation_realdb.py와 동일 관례, 헬퍼도 그대로 재사용).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from tests.test_2893_gate_pr_scoped_isolation_realdb import (
    _post_app,
    _pr_payload,
    _seed_installation,
    _seed_link,
    _seed_org_project_story,
    _session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_approved_pr_gate(s, org, story, *, pr_number, installation_id, anchor_sha):
    """이미 승인·라벨(qa:pass/design:pass)이 붙은 상태를 직접 시드 — 실 승인 플로우(gates.py)를
    타지 않고 이 파일의 관심사(재-pending 발생 시 라벨 제거 배선)만 좁혀 재현한다."""
    from app.models.gate import Gate, set_gate_status
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    gate = Gate(
        id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
        gate_type=MERGE_GATE_TYPE, status="pending", pr_number=pr_number, requires_human=False,
    )
    set_gate_status(gate, "approved", now=datetime.now(timezone.utc))
    gate.approved_head_sha = anchor_sha
    gate.github_check_run_id = 92001
    gate.github_check_run_sha = anchor_sha
    s.add(gate)
    await s.commit()
    return gate


async def _reload_gate(Session, gate_id):
    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()


@pytest.mark.anyio
async def test_sha_mismatch_synchronize_triggers_repending_and_unlabels_both_recheck_labels():
    """B1(재-pending)+B2-a(unlabel) 결합 — synchronize의 head_sha가 anchor와 다르면 gate가
    pending으로 돌고, qa:pass/design:pass 둘 다 제거가 시도돼야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680301)
            await _seed_link(s, org, story, pr_number=301)
            gate = await _seed_approved_pr_gate(
                s, org, story, pr_number=301, installation_id=680301, anchor_sha="sha-orig",
            )
            gate_id = gate.id

        removed_calls = []

        async def _fake_remove(installation_id, repo_full_name, pr_number, label):
            removed_calls.append((installation_id, repo_full_name, pr_number, label))
            return True

        with (
            patch("app.services.github_app.remove_pr_label", new=_fake_remove),
            patch("app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92002})),
            patch("app.services.gate_github_check.update_check_run", AsyncMock(return_value={"id": 92002})),
            patch("app.core.database.async_session_factory", Session),
        ):
            resp = await _post_app(
                _pr_payload(action="synchronize", pr_number=301, installation_id=680301, head_sha="sha-new"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        assert resp.status_code == 200

        gate_after = await _reload_gate(Session, gate_id)
        assert gate_after.status == "pending", "SHA 불일치 → 재-pending(B1, #2813 기존 동작)"
        assert gate_after.approved_head_sha is None

        assert {c[3] for c in removed_calls} == {"qa:pass", "design:pass"}, "두 라벨 모두 제거 시도"
        assert all(c[1] == "moonklabs/sprintable" and c[2] == 301 for c in removed_calls)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sha_match_does_not_repend_or_unlabel():
    """synchronize라도 head_sha가 anchor와 같으면(GitHub이 보내는 raw 이벤트라 실질 변경 없는
    호출도 온다) 재-pending도 라벨 제거도 발생하면 안 된다 — reopen_gate_if_new_sha의 기존
    가드(approved_head_sha == new_head_sha → False)가 그대로 라벨 축의 게이트 역할도 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680302)
            await _seed_link(s, org, story, pr_number=302)
            gate = await _seed_approved_pr_gate(
                s, org, story, pr_number=302, installation_id=680302, anchor_sha="sha-same",
            )
            gate_id = gate.id

        removed_calls = []

        async def _fake_remove(installation_id, repo_full_name, pr_number, label):
            removed_calls.append((installation_id, repo_full_name, pr_number, label))
            return True

        with (
            patch("app.services.github_app.remove_pr_label", new=_fake_remove),
            patch("app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92003})),
            patch("app.services.gate_github_check.update_check_run", AsyncMock(return_value={"id": 92003})),
            patch("app.core.database.async_session_factory", Session),
        ):
            await _post_app(
                _pr_payload(action="synchronize", pr_number=302, installation_id=680302, head_sha="sha-same"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        gate_after = await _reload_gate(Session, gate_id)
        assert gate_after.status == "approved", "SHA 일치 — 재-pending 없음(기존 #2813 계약)"
        assert gate_after.approved_head_sha == "sha-same"
        assert removed_calls == [], "재-pending이 안 일어났으면 라벨도 안 건드려야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_diff_classification_fast_path_docs_only_title_still_unlabels():
    """PO 명시 제외(2026-08-21) — 문서만 변경 등 diff 분류 fast-path는 스코프 밖. PR 제목이
    "docs:"로 시작해도(문서 전용 변경을 시사) 특별취급 없이 다른 케이스와 동일하게
    재-pending+양쪽 라벨 제거가 그대로 일어나야 한다(코드가 title/diff 내용을 보고 건너뛰는
    분기를 만들지 않았다는 것의 회귀 가드)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680303)
            await _seed_link(s, org, story, pr_number=303)
            gate = await _seed_approved_pr_gate(
                s, org, story, pr_number=303, installation_id=680303, anchor_sha="sha-docs-orig",
            )
            gate_id = gate.id

        removed_calls = []

        async def _fake_remove(installation_id, repo_full_name, pr_number, label):
            removed_calls.append(label)
            return True

        with (
            patch("app.services.github_app.remove_pr_label", new=_fake_remove),
            patch("app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92004})),
            patch("app.services.gate_github_check.update_check_run", AsyncMock(return_value={"id": 92004})),
            patch("app.core.database.async_session_factory", Session),
        ):
            await _post_app(
                _pr_payload(
                    action="synchronize", pr_number=303, installation_id=680303,
                    head_sha="sha-docs-new", title="docs: update README only",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        gate_after = await _reload_gate(Session, gate_id)
        assert gate_after.status == "pending", "docs 제목이어도 fast-path 없음 — 여전히 재-pending"
        assert set(removed_calls) == {"qa:pass", "design:pass"}, "docs 제목이어도 fast-path 없음 — 여전히 unlabel"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_label_removal_failure_does_not_block_response_or_gate_state():
    """fail-closed — GitHub 쪽 라벨 제거가 실패(401/5xx 등)해도 웹훅 응답·gate DB 상태(이미
    커밋된 재-pending)는 영향 없어야 한다(publish_label_unlabel은 commit 後 background task —
    실패해도 트랜잭션과 무관)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680304)
            await _seed_link(s, org, story, pr_number=304)
            gate = await _seed_approved_pr_gate(
                s, org, story, pr_number=304, installation_id=680304, anchor_sha="sha-fail-orig",
            )
            gate_id = gate.id

        with (
            patch("app.services.github_app.remove_pr_label", AsyncMock(return_value=False)),
            patch("app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92005})),
            patch("app.services.gate_github_check.update_check_run", AsyncMock(return_value={"id": 92005})),
            patch("app.core.database.async_session_factory", Session),
        ):
            resp = await _post_app(
                _pr_payload(action="synchronize", pr_number=304, installation_id=680304, head_sha="sha-fail-new"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        assert resp.status_code == 200, "라벨 제거 실패가 웹훅 응답을 깨면 안 됨(fail-closed)"

        gate_after = await _reload_gate(Session, gate_id)
        assert gate_after.status == "pending", "라벨 제거 실패와 무관하게 재-pending(DB)은 이미 커밋됨"
    finally:
        await engine.dispose()
