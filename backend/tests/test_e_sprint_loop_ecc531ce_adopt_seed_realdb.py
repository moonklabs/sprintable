"""E-SPRINT-LOOP ecc531ce: 다음가설 채택→시드 — realdb(IDOR·human-gate·N:1·동시성).

router 함수를 직접 호출해(story 1/2와 동형 패턴) 실 Postgres로 검증: ① 다음 sprint가
있으면 link_type=seeded로 연결·없으면 backlog proposed(sprint 링크 없음) ② 동시 더블클릭
(concurrent adopt)이 중복 hypothesis를 만들지 않는지(까심 crux 핵심 요구) ③ 재채택 409
④ IDOR 상속. embeddings 테이블은 로컬 pg16에 pgvector가 없어 스키마에서 제외했으므로
`enqueue_embedding`을 patch(이 story의 관심사 밖 — story 1/S1이 이미 검증한 배선)."""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("dc000000-0000-0000-0000-000000000001")
USER = uuid.UUID("dc000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("dc000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("dc000000-0000-0000-0000-0000000000c1")  # USER grant(접근 O)
PROJ_B = uuid.UUID("dc000000-0000-0000-0000-0000000000c2")  # USER 접근 X(IDOR 축)
SPRINT_PLANNING_LATE = uuid.UUID("dc000000-0000-0000-0000-0000000000d1")
SPRINT_PLANNING_EARLY = uuid.UUID("dc000000-0000-0000-0000-0000000000d2")
SESSION_A = uuid.UUID("dc000000-0000-0000-0000-0000000000e1")
SESSION_A_NOSPRINT = uuid.UUID("dc000000-0000-0000-0000-0000000000e2")
SESSION_B = uuid.UUID("dc000000-0000-0000-0000-0000000000e3")
CANDIDATE_ID = uuid.UUID("dc000000-0000-0000-0000-0000000000f1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _candidate_payload(cid: uuid.UUID = CANDIDATE_ID) -> list:
    return [{
        "id": str(cid),
        "statement": "온보딩 UX를 단순화하면 이탈이 줄 것이다.",
        "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
        "measure_after": (datetime.now(timezone.utc) + timedelta(days=14)).isoformat(),
        "confidence": 0.55, "rationale": "가설 1 반증에서", "requires_confirmation": True,
        "adopted_hypothesis_id": None,
    }]


async def _seed(s):
    for sql in [
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
        f"DELETE FROM sprints WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','DC','dc-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@dc.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_A}','{ORG}','A','none')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_B}','{ORG}','B','none')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        # planning sprint 2개(§2 규칙 실증: 이른 start_date가 선택돼야 함) + active sprint 1개(제외 대상).
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration,start_date) VALUES "
        f"('{SPRINT_PLANNING_LATE}','{ORG}','{PROJ_A}','late','planning',14,'2026-09-01')",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration,start_date) VALUES "
        f"('{SPRINT_PLANNING_EARLY}','{ORG}','{PROJ_A}','early','planning',14,'2026-08-01')",
    ]:
        await s.execute(text(sql))
    from app.models.retro import RetroSession
    s.add(RetroSession(
        id=SESSION_A, org_id=ORG, project_id=PROJ_A, title="retro-a", phase="closed",
        next_hypotheses=_candidate_payload(),
    ))
    s.add(RetroSession(
        id=SESSION_A_NOSPRINT, org_id=ORG, project_id=PROJ_A, title="retro-a-nosprint", phase="closed",
        next_hypotheses=_candidate_payload(uuid.uuid4()),
    ))
    s.add(RetroSession(
        id=SESSION_B, org_id=ORG, project_id=PROJ_B, title="retro-b", phase="closed",
        next_hypotheses=_candidate_payload(),
    ))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


def _repo(session):
    from app.repositories.retro import RetroSessionRepository
    return RetroSessionRepository(session, ORG)


def _no_embed():
    """매 호출마다 새 patch 인스턴스 — 동시 실행(asyncio.gather) 시 같은 patch 객체를
    공유하면 'Patch is already started' RuntimeError가 난다(patch는 재진입 불가)."""
    return patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock(return_value=None))


@pytest.mark.anyio
async def test_resolve_next_sprint_full_tie_breaks_deterministically_by_id():
    """까심 QA MINOR(2026-07-03) — start_date·created_at까지 완전히 동일한 planning sprint가
    여럿이면 `Sprint.id.asc()` tie-break 없이는 비결정적이었다. 두 sprint를 같은 start_date·
    같은 explicit created_at으로 심고, 매번 같은(더 작은 id) sprint가 선택되는지 확인."""
    from app.services.retro_hypothesis_seed import resolve_next_sprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text(f"DELETE FROM sprints WHERE project_id='{PROJ_A}'"))
            same_ts = datetime(2026, 8, 15, tzinfo=timezone.utc)
            tie_a = uuid.UUID("dc000000-0000-0000-0000-0000000000aa")
            tie_b = uuid.UUID("dc000000-0000-0000-0000-0000000000bb")
            for sid in (tie_b, tie_a):  # 삽입 순서를 id 순서와 반대로 — 삽입순 우연 일치 배제
                await s.execute(
                    text(
                        "INSERT INTO sprints (id,org_id,project_id,title,status,duration,"
                        "start_date,created_at) VALUES "
                        "(:id,:org,:proj,'tie','planning',14,'2026-08-15',:ts)"
                    ),
                    {"id": sid, "org": ORG, "proj": PROJ_A, "ts": same_ts},
                )
            await s.commit()

        picks = set()
        for _ in range(3):
            async with Session() as s:
                sprint = await resolve_next_sprint(s, ORG, PROJ_A)
                picks.add(sprint.id)
        assert picks == {tie_a}  # 항상 더 작은 id(tie_a < tie_b)만 선택 — 결정적
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_adopt_creates_proposed_hypothesis_seeds_earliest_planning_sprint():
    """§2 PO 결 — planning 중 가장 이른 start_date(0801)가 선택돼야 함(0901 아님)."""
    from app.routers.retros import adopt_next_hypothesis
    from app.schemas.retro import AdoptNextHypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with _no_embed():
                resp = await adopt_next_hypothesis(
                    SESSION_A, AdoptNextHypothesis(id=CANDIDATE_ID), db=s, auth=_auth(), repo=_repo(s),
                )
            await s.commit()

        assert resp.next_hypotheses[0].adopted_hypothesis_id is not None
        hyp_id = resp.next_hypotheses[0].adopted_hypothesis_id

        async with Session() as s:
            from app.models.hypothesis import Hypothesis, HypothesisSprintLink
            hyp = (await s.execute(select(Hypothesis).where(Hypothesis.id == hyp_id))).scalar_one()
            assert hyp.status == "proposed"
            assert hyp.statement == "온보딩 UX를 단순화하면 이탈이 줄 것이다."
            link = (await s.execute(
                select(HypothesisSprintLink).where(HypothesisSprintLink.hypothesis_id == hyp_id)
            )).scalar_one()
            assert link.sprint_id == SPRINT_PLANNING_EARLY  # 이른 sprint가 선택됨
            assert link.link_type == "seeded"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_adopt_no_planning_sprint_creates_backlog_proposed_no_link():
    """AC #2 — 다음 sprint 없으면 backlog proposed(링크 없음). PROJ_B는 seed에서 sprint 0개."""
    from app.routers.retros import adopt_next_hypothesis
    from app.schemas.retro import AdoptNextHypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            # PROJ_B는 사용자 접근권이 없어(IDOR 대상) 여기선 못 씀 — PROJ_A에서 planning sprint를
            # 전부 지워 "다음 sprint 없음"을 재현.
            await s.execute(text(f"DELETE FROM sprints WHERE project_id='{PROJ_A}'"))
            await s.commit()

        async with Session() as s:
            with _no_embed():
                resp = await adopt_next_hypothesis(
                    SESSION_A, AdoptNextHypothesis(id=CANDIDATE_ID), db=s, auth=_auth(), repo=_repo(s),
                )
            await s.commit()

        hyp_id = resp.next_hypotheses[0].adopted_hypothesis_id
        assert hyp_id is not None

        async with Session() as s:
            from app.models.hypothesis import Hypothesis, HypothesisSprintLink
            hyp = (await s.execute(select(Hypothesis).where(Hypothesis.id == hyp_id))).scalar_one()
            assert hyp.status == "proposed"
            link = (await s.execute(
                select(HypothesisSprintLink).where(HypothesisSprintLink.hypothesis_id == hyp_id)
            )).scalar_one_or_none()
            assert link is None  # backlog proposed — sprint 링크 없음
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_adopt_already_adopted_409():
    from app.routers.retros import adopt_next_hypothesis
    from app.schemas.retro import AdoptNextHypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with _no_embed():
                await adopt_next_hypothesis(SESSION_A, AdoptNextHypothesis(id=CANDIDATE_ID), db=s, auth=_auth(), repo=_repo(s))
            await s.commit()

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await adopt_next_hypothesis(SESSION_A, AdoptNextHypothesis(id=CANDIDATE_ID), db=s, auth=_auth(), repo=_repo(s))
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "ALREADY_ADOPTED"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_adopt_cross_project_403():
    from app.routers.retros import adopt_next_hypothesis
    from app.schemas.retro import AdoptNextHypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await adopt_next_hypothesis(SESSION_B, AdoptNextHypothesis(id=CANDIDATE_ID), db=s, auth=_auth(), repo=_repo(s))
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_concurrent_double_click_creates_exactly_one_hypothesis():
    """까심 crux 핵심(2026-07-03) — 동시 더블클릭이 중복 proposed 가설을 만들면 안 된다.
    `get_for_update`(FOR UPDATE)가 두 요청을 직렬화 — 하나는 200, 하나는 409(ALREADY_ADOPTED)
    여야 하고, hypotheses 테이블에는 정확히 1행만 생겨야 한다."""
    from app.models.retro import RetroSession
    from app.routers.retros import adopt_next_hypothesis
    from app.schemas.retro import AdoptNextHypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            row = (await s.execute(
                select(RetroSession).where(RetroSession.id == SESSION_A_NOSPRINT)
            )).scalar_one()
            seeded_candidate_id = uuid.UUID(row.next_hypotheses[0]["id"])

        async def _attempt():
            async with Session() as s:
                try:
                    resp = await adopt_next_hypothesis(
                        SESSION_A_NOSPRINT, AdoptNextHypothesis(id=seeded_candidate_id),
                        db=s, auth=_auth(), repo=_repo(s),
                    )
                    await s.commit()
                    return ("ok", resp)
                except HTTPException as exc:
                    await s.rollback()
                    return ("error", exc.status_code)

        # 두 태스크가 각자 patch.start()/stop()을 하면 한쪽의 __exit__이 다른 쪽이 아직
        # 쓰는 중인 패치를 원본으로 되돌려버리는 레이스가 난다(unittest.mock.patch가 동시
        # 진입을 가정 안 함) — gather 전체를 감싸는 단일 patch로 묶어 이 레이스를 없앤다.
        with _no_embed():
            results = await asyncio.gather(_attempt(), _attempt())
        outcomes = [r[0] for r in results]
        assert outcomes.count("ok") == 1
        assert outcomes.count("error") == 1
        assert 409 in [r[1] for r in results if r[0] == "error"]

        async with Session() as s:
            from app.models.hypothesis import Hypothesis
            count = (await s.execute(
                select(Hypothesis).where(
                    Hypothesis.org_id == ORG, Hypothesis.source_id == SESSION_A_NOSPRINT
                )
            ))
            rows = count.scalars().all()
            assert len(rows) == 1  # 핵심 — 동시 더블클릭이 딱 1개만 생성
    finally:
        await eng.dispose()
