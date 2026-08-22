"""story #2893(§2 A1, 0271) 후속 — 카디르 QA(PR#3349 CI 실 실패 2건, 2026-08-22, codex
소스분석→실 재현 확定).

pr_number를 멱등 키에 편입한 것(정확매치 only)이 「PR 컨텍스트가 나중에 밝혀지는」 정상
케이스(①line-engine/board-preflight self-report shell 後 실 PR 연결 ②legacy 백필 누락 행의
재제출)까지 다른 PR과 똑같이 취급해 새 행을 만들며 옛 NULL-슬롯 행을 고아화시켰다.
`gate_service.find_gate_slot_with_pr_fallback`가 정확매치 우선+NULL-슬롯 승격 폴백으로
고쳤다 — 이 파일은 그 헬퍼 자체의 계약(승격 성립)과, 승격이 실사고1/2가 막던 축(서로 다른
PR이 같은 슬롯을 공유)을 다시 열지 않는다는 것 둘 다를 실 PG로 고정한다.
"""
from __future__ import annotations

import uuid
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

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_find_gate_slot_promotes_null_slot_to_real_pr_number():
    """단위 계약 — NULL-슬롯이 있으면 정확매치가 없을 때 그 행을 찾아 pr_number를 채운다
    (같은 gate.id 유지, 새 행 생성 아님)."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="auto_passed", pr_number=None,
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        async with Session() as s:
            found = await find_gate_slot_with_pr_fallback(
                s, org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", pr_number=8,
            )
            assert found is not None
            assert found.id == gate_id, "새 행이 아니라 기존 NULL-슬롯 행을 재사용해야 함"
            assert found.pr_number == 8, "승격 — pr_number가 채워져야 함"
            await s.commit()

        async with Session() as s:
            row = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert row.pr_number == 8, "승격이 커밋 後에도 영속돼야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_find_gate_slot_promotion_does_not_let_second_different_pr_steal_it():
    """실사고1/2 재발방지 — NULL-슬롯이 PR A로 승격된 後, PR B(다른 pr_number)가 같은
    (work_item, gate_type)을 조회해도 승격된 행을 못 찾는다(정확매치 불일치+NULL-슬롯
    자체가 이제 없음) — «미상→특정 PR» 1회성 전이일 뿐 «PR A→PR B» 전이는 이 헬퍼가
    만들어내지 않는다는 것의 직접 증거."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="auto_passed", pr_number=None,
            )
            s.add(gate)
            await s.commit()

        async with Session() as s:
            promoted = await find_gate_slot_with_pr_fallback(
                s, org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", pr_number=8,
            )
            assert promoted is not None and promoted.pr_number == 8
            await s.commit()

        async with Session() as s:
            for_pr_b = await find_gate_slot_with_pr_fallback(
                s, org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", pr_number=9,
            )
            assert for_pr_b is None, "PR B는 승격된 PR A의 슬롯을 훔치면 안 됨(실사고1/2 재발방지)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_find_gate_slot_none_pr_number_never_touches_pr_scoped_row():
    """pr_number=None(PR 컨텍스트 없는 조회)은 NULL-슬롯만 찾는다 — 이미 특정 PR에 귀속된
    행을 "PR 컨텍스트 없음"이라는 이유로 승격 해제하거나 잘못 반환하면 안 된다."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="approved", pr_number=8,
            )
            s.add(gate)
            await s.commit()

        async with Session() as s:
            found = await find_gate_slot_with_pr_fallback(
                s, org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", pr_number=None,
            )
            assert found is None, "PR-scoped 행은 pr_number=None 조회 대상이 아님(NULL-슬롯 전용)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_webhook_self_report_shell_promoted_by_first_pr_then_second_pr_gets_own_row():
    """통합 — board-preflight/line-engine self-report shell(NULL-슬롯)이 실존하는 상태에서
    PR A가 열리면 그 행이 승격돼 재사용되고(같은 gate_id), 뒤이어 같은 스토리에 PR B가
    열리면 승격된 PR A 행과 무관한 **독립** 새 행을 얻는다(실사고1/2 축 그대로 보존)."""
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680401)
            await _seed_link(s, org, story, pr_number=401)
            await _seed_link(s, org, story, pr_number=402)
            story_id = story.id
            # self-report shell(라인/board-preflight): PR 컨텍스트 모름 — pr_number NULL.
            shell = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story_id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending", pr_number=None,
            )
            s.add(shell)
            await s.commit()
            shell_id = shell.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 94001}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _pr_payload(action="opened", pr_number=401, installation_id=680401, head_sha="sha-a1"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            await _post_app(
                _pr_payload(action="opened", pr_number=402, installation_id=680401, head_sha="sha-b1"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        async with Session() as s:
            rows = (
                await s.execute(
                    select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE)
                )
            ).scalars().all()
            assert len(rows) == 2, "shell이 PR A로 승격 재사용 + PR B는 별개 새 행 = 총 2행"
            by_pr = {g.pr_number: g for g in rows}
            assert set(by_pr) == {401, 402}
            assert by_pr[401].id == shell_id, "PR A는 승격된 shell 행을 그대로 재사용해야 함"
            assert by_pr[402].id != shell_id, "PR B는 승격된 shell을 훔치지 않고 독립 행이어야 함"
    finally:
        await engine.dispose()
