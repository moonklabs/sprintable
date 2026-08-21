"""story #2874(하드닝) — #3288 QA서 codex가 지적(카디르 사실 확認): `BaseRepository.update()`
는 재조회→setattr→flush의 check-then-write라 원자적 CAS가 아니다. `expected_updated_at`
방어(#2868)가 같은 밀리초대 «진짜 동시» PATCH 두 건 앞에서 뚫릴 수 있다 — 두 요청이 모두
"충돌 前" updated_at을 읽고 통과한 뒤, 나중 flush가 먼저 것을 조용히 덮어쓰는 TOCTOU 창.

이 파일은 `BaseRepository.update_with_cas()`(단일 SQL `UPDATE ... WHERE id= AND
date_trunc('milliseconds', updated_at)=`)가:
  ① 진짜 동시(asyncio.gather, 별도 세션) PATCH 두 건 중 정확히 1건만 통과시키는지(원자성
     실측 — 순차 staleness가 아니라 진짜 레이스로 하중 증명)
  ② ms-절삭 경계에서 false-409를 안 내는지(DB μs=654321·클라 ms절삭 654000 전송 → 200,
     카디르 probe로 실증된 축 — #3288 5건엔 직접 커버가 없던 갭)
값으로 잰다. stories·docs 양쪽 다(공용 판정 함수 재사용 확認).

#2853/#2845/#2857과 동일 정신 — 격리 로컬 throwaway realdb만 사용(라이브 배포 시스템 무접촉).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.background import BackgroundTasks

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("28740000-0000-0000-0000-000000000101")
USER = uuid.UUID("28740000-0000-0000-0000-0000000101a1")
OM = uuid.UUID("28740000-0000-0000-0000-0000000101b1")
PROJ = uuid.UUID("28740000-0000-0000-0000-0000000101c1")
STORY = uuid.UUID("28740000-0000-0000-0000-0000000101d1")
DOC = uuid.UUID("28740000-0000-0000-0000-0000000101e1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC, pool_size=5, max_overflow=5)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2874','s2874-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','u@s2874.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s2874-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OM}','granted','owner')",
        "INSERT INTO stories (id,org_id,project_id,title,status,priority,description) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog','medium','ORIGINAL')",
        "INSERT INTO docs (id,org_id,project_id,title,slug,content) VALUES "
        f"('{DOC}','{ORG}','{PROJ}','D','s2874-doc','ORIGINAL')",
    ]:
        await s.execute(text(sql))
    await s.commit()


# ───────────── ① 진짜 동시 PATCH 두 건 — 정확히 1건만 통과(원자성) ─────────────

@pytest.mark.anyio
async def test_story_concurrent_patch_only_one_wins_atomically():
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            snapshot = await get_story(STORY, repo, _auth_human(USER))

        async def _patch(suffix: str):
            async with Session() as s:
                repo = StoryRepository(s, ORG)
                try:
                    resp = await update_story(
                        STORY,
                        StoryUpdate(description=f"ORIGINAL+{suffix}", expected_updated_at=snapshot.updated_at),
                        BackgroundTasks(), repo, s, _auth_human(USER),
                    )
                    return ("ok", resp.description)
                except HTTPException as e:
                    return ("conflict", e.status_code)

        results = await asyncio.gather(_patch("A"), _patch("B"))
        outcomes = [r[0] for r in results]
        assert outcomes.count("ok") == 1, (
            f"진짜 동시 PATCH 두 건 중 정확히 1건만 통과해야 한다(원자적 CAS) — {results}"
        )
        assert outcomes.count("conflict") == 1
        conflict = next(r for r in results if r[0] == "conflict")
        assert conflict[1] == 409

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            final = await get_story(STORY, repo, _auth_human(USER))
        winner_desc = next(r[1] for r in results if r[0] == "ok")
        assert final.description == winner_desc, "DB 최종 상태가 승자의 write와 일치해야 한다"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_doc_concurrent_patch_only_one_wins_atomically():
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc, update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            snapshot = await get_doc(DOC, session=s, repo=repo, auth=_auth_human(USER))

        async def _patch(suffix: str):
            async with Session() as s:
                repo = DocRepository(s, ORG)
                try:
                    resp = await update_doc(
                        DOC,
                        DocUpdate(content=f"ORIGINAL+{suffix}", expected_updated_at=snapshot.updated_at),
                        BackgroundTasks(), repo, s, _auth_human(USER),
                    )
                    # update_doc은 (stories.py와 달리) 자체 commit이 없다 — 실 FastAPI 경로는
                    # get_db() 디펜던시 래퍼가 요청 종료 시 commit한다. 직접호출 테스트는 그
                    # 래퍼 역할을 여기서 명시로 재현해야 락 보유 구간(원자성의 핵심)이 실제
                    # 요청과 동형이 된다 — 생략하면 두 트랜잭션 다 커밋 전 롤백돼 "둘 다 성공"
                    # 이라는 가짜 결과가 나온다(직접 확인한 실패 모드).
                    await s.commit()
                    return ("ok", resp.content)
                except HTTPException as e:
                    return ("conflict", e.status_code)

        results = await asyncio.gather(_patch("A"), _patch("B"))
        outcomes = [r[0] for r in results]
        assert outcomes.count("ok") == 1, f"doc도 동일 — {results}"
        assert outcomes.count("conflict") == 1
        conflict = next(r for r in results if r[0] == "conflict")
        assert conflict[1] == 409
    finally:
        await eng.dispose()


# ───────────── ② ms-절삭 경계 — DB μs 대비 클라 ms절삭 전송해도 false-409 없음 ─────────────

@pytest.mark.anyio
async def test_story_ms_truncated_expected_updated_at_no_false_409():
    """카디르 probe 축(#3288) — DB가 μs=654321을 들고 있는데 클라(JS Date)가 ms절삭한
    654000을 expected_updated_at으로 보내도 CAS가 «다른 값»으로 오판해 409를 내면 안 된다."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            # μs=654321로 정밀 세팅(INSERT 기본 now()는 임의 μs라 명시로 고정해 대조를 값으로 잰다).
            await s.execute(text(
                f"UPDATE stories SET updated_at = '2026-08-21 05:00:00.654321+00' WHERE id='{STORY}'"
            ))
            await s.commit()

        client_ms_truncated = __import__("datetime").datetime(
            2026, 8, 21, 5, 0, 0, 654000, tzinfo=__import__("datetime").timezone.utc
        )

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            resp = await update_story(
                STORY,
                StoryUpdate(description="APPENDED", expected_updated_at=client_ms_truncated),
                BackgroundTasks(), repo, s, _auth_human(USER),
            )
        assert resp.description == "APPENDED", "ms-절삭값 == DB μs값(ms 단위까지)이면 통과해야 한다(false-409 금지)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_doc_ms_truncated_expected_updated_at_no_false_409():
    """story 쪽과 대칭 — doc도 같은 공용 판정 함수(update_with_cas)를 타므로 동일하게
    ms-절삭 경계에서 false-409가 없어야 한다."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text(
                f"UPDATE docs SET updated_at = '2026-08-21 05:00:00.654321+00' WHERE id='{DOC}'"
            ))
            await s.commit()

        client_ms_truncated = __import__("datetime").datetime(
            2026, 8, 21, 5, 0, 0, 654000, tzinfo=__import__("datetime").timezone.utc
        )

        async with Session() as s:
            repo = DocRepository(s, ORG)
            resp = await update_doc(
                DOC, DocUpdate(content="APPENDED", expected_updated_at=client_ms_truncated),
                BackgroundTasks(), repo, s, _auth_human(USER),
            )
        assert resp.content == "APPENDED"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_story_genuinely_different_ms_is_rejected_409():
    """대조군 — ms 단위 자체가 다르면(진짜 stale) 여전히 409여야 한다(ms-절삭 관용이
    "아무 값이나 통과"로 새지 않았는지 확認)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text(
                f"UPDATE stories SET updated_at = '2026-08-21 05:00:00.654321+00' WHERE id='{STORY}'"
            ))
            await s.commit()

        stale = __import__("datetime").datetime(
            2026, 8, 21, 5, 0, 0, 653000, tzinfo=__import__("datetime").timezone.utc
        )  # ms 단위가 654→653으로 실제로 다름(1ms 오차, 진짜 stale 시나리오)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            with pytest.raises(HTTPException) as exc_info:
                await update_story(
                    STORY, StoryUpdate(description="X", expected_updated_at=stale),
                    BackgroundTasks(), repo, s, _auth_human(USER),
                )
        assert exc_info.value.status_code == 409
    finally:
        await eng.dispose()


# ───────────── ③ #3291 카디르 QA rework — ms-절삭 CAS 토큰의 same-bucket 퇴화 ─────────────
#
# 카디르 SQL 레벨 결정적 재현(2026-08-21): T1의 write가 만든 새 updated_at이 원래 값과 같은
# ms 버킷에 떨어지면(양쪽 다 date_trunc('milliseconds', ...)로 같은 값), T2가 T0(원래) 시점의
# 낡은 expected_updated_at을 들고 와도 CAS 비교가 통과해 rowcount=1로 조용히 덮어쓴다 —
# 타이밍 운이 아니라 같은 ms 안에서는 항상 재현되는 결정적 결함. 처방: onupdate 자체를
# GREATEST(clock_timestamp(), updated_at + 1ms)로 바꿔 매 write가 최소 1ms(=최소 1 버킷)는
# 반드시 전진하게 강제(app/models/base.py::MONOTONIC_UPDATED_AT_ONUPDATE, Story/Doc가 override).
# 이 아래 테스트는 실 타이밍(비결정적)에 기대지 않고 저장값을 직접 조작해 **결정적으로** 잰다.

@pytest.mark.anyio
async def test_story_onupdate_strictly_advances_ms_bucket_even_when_stored_value_is_far_future():
    """수학적 불변식 직접 검증 — updated_at을 실제 시각보다 훨씬 미래로 박아 두면
    clock_timestamp() 단독으로는 절대 못 앞서므로, GREATEST의 «updated_at+1ms» 분기가
    반드시 이겨야 한다(그렇지 않으면 뒤로 가거나 제자리 — 둘 다 same-bucket 퇴화의 원인).
    ms 경계에 딱 붙은 microsecond(999000)로 앞서 최악 케이스까지 잡는다."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            # 실 시각보다 100년 미래 + ms 경계에 딱 붙은 microsecond — clock_timestamp()가
            # 이 값을 절대 못 앞지르는 조건을 만든다(GREATEST의 +1ms 분기 강제 발동 검증).
            await s.execute(text(
                f"UPDATE stories SET updated_at = '2126-01-01 00:00:00.999000+00' WHERE id='{STORY}'"
            ))
            await s.commit()

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            before = await get_story(STORY, repo, _auth_human(USER))

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            after = await update_story(
                STORY, StoryUpdate(description="ADVANCED"), BackgroundTasks(), repo, s, _auth_human(USER),
            )

        before_ms_bucket = before.updated_at.replace(microsecond=(before.updated_at.microsecond // 1000) * 1000)
        after_ms_bucket = after.updated_at.replace(microsecond=(after.updated_at.microsecond // 1000) * 1000)
        assert after_ms_bucket > before_ms_bucket, (
            f"onupdate가 ms 버킷을 전진 못 시키면 same-bucket 퇴화가 재현된다 — "
            f"before={before.updated_at} after={after.updated_at}"
        )
        assert after.updated_at >= before.updated_at + timedelta(milliseconds=1)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_story_cas_rejects_stale_token_after_write_forced_into_far_future_bucket():
    """통합 레벨 — T0 스냅숏(미래로 박아 둔 값)을 들고 온 T2가, T1이 이미 다른 값을 쓴
    뒤에도 여전히 409로 거부되는지(설령 T1의 새 값이 T0와 «가까운» ms대라도 onupdate가
    최소 1버킷은 반드시 벌려 둬서 date_trunc 비교가 다시는 우연히 일치하지 않는다)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text(
                f"UPDATE stories SET updated_at = '2126-01-01 00:00:00.999000+00' WHERE id='{STORY}'"
            ))
            await s.commit()

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            t0_snapshot = await get_story(STORY, repo, _auth_human(USER))

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            await update_story(
                STORY, StoryUpdate(description="T1_WRITE"), BackgroundTasks(), repo, s, _auth_human(USER),
            )

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            with pytest.raises(HTTPException) as exc_info:
                await update_story(
                    STORY,
                    StoryUpdate(description="T2_STALE", expected_updated_at=t0_snapshot.updated_at),
                    BackgroundTasks(), repo, s, _auth_human(USER),
                )
        assert exc_info.value.status_code == 409

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            final = await get_story(STORY, repo, _auth_human(USER))
        assert final.description == "T1_WRITE", "T2가 거부돼야 T1의 write가 안 덮인다"
    finally:
        await eng.dispose()
