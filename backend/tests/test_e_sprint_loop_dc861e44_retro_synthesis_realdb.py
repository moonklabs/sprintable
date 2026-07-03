"""E-SPRINT-LOOP dc861e44: retro §5 계약 — realdb E2E(IDOR 상속·409 게이팅·hypotheses[] embed).

router 함수를 직접 호출해(context_pack_search_idor_realdb.py·retro_mutation_project_scope_idor_
realdb.py와 동형) 실 Postgres로 검증: ① sprint 링크 가설이 hypotheses[]로 정확히 평탄화되는지
(story 1 HypothesisSprintLink 재사용) ② synthesize/recommend-next가 IDOR 가드(#1801)를
상속하는지 ③ recommend-next가 synthesis 없으면 fail-closed 409인지. LLM은 patch(실 API 미호출).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from unittest.mock import patch

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("db000000-0000-0000-0000-000000000001")
USER = uuid.UUID("db000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("db000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("db000000-0000-0000-0000-0000000000c1")  # USER grant(접근 O)
PROJ_B = uuid.UUID("db000000-0000-0000-0000-0000000000c2")  # USER 접근 X(IDOR 축)
SPRINT = uuid.UUID("db000000-0000-0000-0000-0000000000d1")
HYP = uuid.UUID("db000000-0000-0000-0000-0000000000d2")
SESSION_A = uuid.UUID("db000000-0000-0000-0000-0000000000e1")
SESSION_B = uuid.UUID("db000000-0000-0000-0000-0000000000e2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    for sql in [
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM hypothesis_sprint_links WHERE hypothesis_id='{HYP}'",
        f"DELETE FROM hypotheses WHERE id='{HYP}'",
        f"DELETE FROM sprints WHERE id='{SPRINT}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','DB','db-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@db.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_A}','{ORG}','A','none')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_B}','{ORG}','B','none')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{SPRINT}','{ORG}','{PROJ_A}','sprint-a','planning',14)",
    ]:
        await s.execute(text(sql))
    # hypothesis(§5 metric/target/direction/actual 평탄화 실증용 — falsified+actual 채점됨)
    await s.execute(
        text(
            "INSERT INTO hypotheses (id,org_id,project_id,owner_member_id,statement,"
            "metric_definition,measure_after,status,outcome_result,human_accounting,gate_contract) VALUES "
            "(:id,:org_id,:project_id,:owner_id,:statement,CAST(:metric AS jsonb),:measure_after,"
            "'falsified',CAST(:outcome AS jsonb),'{}','{}')"
        ),
        {
            "id": HYP, "org_id": ORG, "project_id": PROJ_A, "owner_id": OM,
            "statement": "온보딩 개선으로 이탈이 줄 것이다",
            "metric": '{"metric":"retention","source":"manual","target":50,"direction":"up"}',
            "measure_after": datetime(2026, 8, 1, tzinfo=timezone.utc),
            "outcome": '{"actual": 42}',
        },
    )
    await s.execute(
        text(
            "INSERT INTO hypothesis_sprint_links (id,hypothesis_id,sprint_id,link_type) "
            "VALUES (:id,:hyp,:sprint,'declared')"
        ),
        {"id": uuid.uuid4(), "hyp": HYP, "sprint": SPRINT},
    )
    # retro session — PROJ_A(sprint 링크)·PROJ_B(IDOR 대상)
    from app.models.retro import RetroSession
    s.add(RetroSession(
        id=SESSION_A, org_id=ORG, project_id=PROJ_A, sprint_id=SPRINT,
        title="retro-a", phase="closed",
    ))
    s.add(RetroSession(
        id=SESSION_B, org_id=ORG, project_id=PROJ_B, title="retro-b", phase="collect",
    ))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_hypotheses_embed_flattens_sprint_linked_hypothesis():
    from app.routers.retros import get_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            resp = await get_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
        assert len(resp.hypotheses) == 1
        h = resp.hypotheses[0]
        assert h.id == HYP
        assert h.status == "falsified"
        assert h.metric == "retention"
        assert h.target == 50
        assert h.direction == "up"
        assert h.actual == 42
        assert h.href == f"/hypotheses/{HYP}"
        assert resp.synthesis is None
        assert resp.next_hypotheses is None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_synthesize_then_recommend_next_full_flow():
    from app.routers.retros import recommend_next_session, synthesize_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        # get_db 의존성은 요청 끝에서 커밋한다(프로덕션 경로) — 라우터 함수를 직접 호출하는
        # 이 테스트는 그 래핑을 우회하므로 명시 commit 필요(repo.update()는 flush만 함).
        synth_raw = '{"items": [{"text": "가설이 반증됐다(온보딩 42% vs 목표 50%) — 학습 데이터", "source": "가설 1"}]}'
        async with Session() as s:
            with patch("app.services.llm_client.generate_text", return_value=synth_raw):
                resp = await synthesize_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            await s.commit()
        assert resp.synthesis is not None
        assert len(resp.synthesis.learned) == 1
        assert "학습" in resp.synthesis.learned[0].text or resp.synthesis.learned[0].text

        next_raw = '{"items": [{"statement": "온보딩 UX를 단순화하면 이탈이 줄 것이다.", "rationale": "가설 1 반증", "confidence": 0.55}]}'
        async with Session() as s:
            with patch("app.services.llm_client.generate_text", return_value=next_raw):
                resp2 = await recommend_next_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            await s.commit()
        assert resp2.next_hypotheses is not None
        assert len(resp2.next_hypotheses) == 1
        assert resp2.next_hypotheses[0].requires_confirmation is True

        # 재조회해도 overwrite 캐시가 그대로 남아있는지(PO 결 — 매 GET 재생성 안 함).
        from app.routers.retros import get_session
        async with Session() as s:
            resp3 = await get_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
        assert resp3.synthesis is not None
        assert resp3.next_hypotheses is not None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_recommend_next_without_synthesis_409():
    from app.routers.retros import recommend_next_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await recommend_next_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "SYNTHESIS_REQUIRED"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_synthesize_cross_project_403():
    """IDOR 가드 상속(#1801) — USER는 PROJ_B(SESSION_B) grant 없음."""
    from app.routers.retros import synthesize_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await synthesize_session(SESSION_B, db=s, auth=_auth(), repo=_repo(s))
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_llm_failure_does_not_destroy_existing_good_synthesis():
    """까심 RC①(2026-07-03) — good synthesis가 이미 저장된 상태에서 [다시 생성]이 LLM 장애로
    실패하면 502를 반환하고 **DB의 기존 값은 그대로**여야 한다(재조회로 실증 — 세션 로컬 파이썬
    객체 비교가 아니라 진짜 커밋된 DB 상태 확인)."""
    from app.routers.retros import get_session, synthesize_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        good_raw = '{"items": [{"text": "가설이 반증됐다 — 학습 데이터", "source": "가설 1"}]}'
        async with Session() as s:
            with patch("app.services.llm_client.generate_text", return_value=good_raw):
                await synthesize_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            await s.commit()

        # [다시 생성] 중 LLM 장애(Anthropic outage 재현) — 예외로 실패.
        async with Session() as s:
            with patch("app.services.llm_client.generate_text", side_effect=RuntimeError("outage")):
                with pytest.raises(HTTPException) as ei:
                    await synthesize_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
                assert ei.value.status_code == 502
                assert ei.value.detail["code"] == "SYNTHESIS_GENERATION_FAILED"
            await s.rollback()  # 실패 응답이면 어차피 아무것도 flush 안 됨 — 명시적으로 확인

        # 재조회 — DB에 남은 값은 여전히 "good"(빈 배열/garbage로 덮이지 않음).
        async with Session() as s:
            resp = await get_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
        assert resp.synthesis is not None
        assert resp.synthesis.learned[0].text == "가설이 반증됐다 — 학습 데이터"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_malformed_llm_response_does_not_destroy_existing_good_synthesis():
    """까심 codex RC①(2026-07-03) — [다시 생성]에서 LLM이 예외/None이 아니라 **JSON 형식을
    안 지킨 텍스트**를 반환해도(raw는 존재) 기존 good synthesis가 살아남아야 한다. 1차 fix는
    raw가 None/예외인 경우만 잡았고, "raw는 있지만 malformed"는 여전히 1-bullet로 래핑해
    캐시를 덮어썼다(codex가 잡은 잔여 구멍) — 이제 이 경로도 502·캐시 보존."""
    from app.routers.retros import get_session, synthesize_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        good_raw = '{"items": [{"text": "가설이 반증됐다 — 학습 데이터", "source": "가설 1"}]}'
        async with Session() as s:
            with patch("app.services.llm_client.generate_text", return_value=good_raw):
                await synthesize_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            await s.commit()

        # [다시 생성] — LLM이 응답은 하지만 JSON 형식을 안 지킴(raw-wrap 구제 제거 검증).
        async with Session() as s:
            with patch("app.services.llm_client.generate_text", return_value="이건 JSON이 아님"):
                with pytest.raises(HTTPException) as ei:
                    await synthesize_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
                assert ei.value.status_code == 502
            await s.rollback()

        async with Session() as s:
            resp = await get_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
        assert resp.synthesis is not None
        assert resp.synthesis.learned[0].text == "가설이 반증됐다 — 학습 데이터"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_recommend_next_malformed_synthesis_in_db_returns_409_not_500():
    """까심 RC②(2026-07-03) — DB에 malformed synthesis(list)가 들어있어도 크래시 없이 409."""
    from app.routers.retros import recommend_next_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            await s.execute(
                text("UPDATE retro_sessions SET synthesis = '[]'::jsonb WHERE id = :id"),
                {"id": SESSION_A},
            )
            await s.commit()
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await recommend_next_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "SYNTHESIS_REQUIRED"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_recommend_next_item_shape_malformed_synthesis_in_db_returns_409():
    """까심 codex RC②(2026-07-03) — learned는 비어있지 않은 list지만 아이템이 스키마 불일치
    (text 부재)면 여전히 409여야 한다(item-shape 미검증 시 통과하던 구멍)."""
    from app.routers.retros import recommend_next_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            await s.execute(
                text("UPDATE retro_sessions SET synthesis = :syn WHERE id = :id"),
                {"syn": '{"learned": [{}], "generated_at": "t", "source": "ai_draft"}', "id": SESSION_A},
            )
            await s.commit()
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await recommend_next_session(SESSION_A, db=s, auth=_auth(), repo=_repo(s))
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "SYNTHESIS_REQUIRED"
    finally:
        await eng.dispose()


def _repo(session):
    from app.repositories.retro import RetroSessionRepository
    return RetroSessionRepository(session, ORG)
