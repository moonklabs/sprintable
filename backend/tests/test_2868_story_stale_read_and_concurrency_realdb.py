"""story #2868(P0, 실사고 — 2026-08-21 유나 홀름 정직 보고) — story #2752 본문에 진단 절을
append하려 GET→PATCH를 돌렸는데, 그 사이 어디선가 본문이 빈 값으로 관측돼 append가 기존
본문을 통째로 덮어썼다(리비전/audit 필터 부재로 원문 verbatim 회수 불가, 캡처본으로 부분 복구).

## AC1 그라운딩 — 실측 결과
Cloud Logging(freshness=6h, 사고 당일)으로 story 2752의 GET/PATCH 시퀀스를 재구성했다:
  04:14:27 GET 200 → (2m44s 공백, 그 사이 /revisions·/history·/audit 전부 404 — 조사 흔적)
  → 04:17:11.290 PATCH 200(이 PATCH의 updated_at이 사고 story의 현재 updated_at과 정확히
    일치 — 이 PATCH가 그 사고 write임을 확定) → 04:17:11.513 GET 200.
전 구간 User-Agent가 `Python-urllib/3.14`로 동일(단일 액터·순차 요청 — 동시편집 레이스 아님).

get_story·update_story는 **둘 다 `get_db`(primary pool)를 쓴다**(`list_stories`만
`get_read_db`/replica) — 단건 GET에는 read-replica 지연이 구조적으로 적용되지 않는다. HTTP
레벨 응답 캐시도 이 라우터엔 없다.

①이 이 사실을 값으로 잰다: 같은 코드 경로(get_story→update_story→get_story)를 밀착 반복(60회,
간격 0)해도 read-after-write 불일치가 **재현되지 않는다** — #2459(2026-08-05, PgBouncer
transaction-mode 조합까지 포함한 광범위 재현 시도에도 확定 실패)와 동일한 결론. 즉 이 계층
(app 코드·primary DB 세션)에서는 결함이 없다 — 사고의 실제 메커니즘은 (a) 클라이언트가
오래된(2m44s 전) 스냅숏을 재사용했거나 (b) dev 인프라 특정 레이스(PgBouncer/Cloud Run) 중
하나로 좁혀지는데, (b)는 인프라 접근 밖(디디는 dev 코드 스코프)이라 확定 불가 — 있는 그대로
보고.

## AC2 처방 — docs.py에 이미 있던 낙관적 동시성을 stories에 이식(쌍둥이 체계 약한 쪽 보강)
`docs.py::update_doc`(151e05f1)는 `expected_updated_at`+409 DOC_CONFLICT를 이미 갖고 있었는데
`stories.py::update_story`엔 없었다 — 정확히 이 사고 클래스(오래된 스냅숏 기반 PATCH)를 막는
표준 방어가 «쌍둥이» 중 한쪽에만 있던 것. 이 파일 ②가 stories에도 동일하게 작동하는지 잰다.

#2853/#2845/#2857과 동일 정신 — 격리 로컬 throwaway realdb만 사용(라이브 배포 시스템 무접촉).
"""
from __future__ import annotations

import os
import uuid

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

ORG = uuid.UUID("28680000-0000-0000-0000-000000000101")
USER = uuid.UUID("28680000-0000-0000-0000-0000000101a1")
OM = uuid.UUID("28680000-0000-0000-0000-0000000101b1")
PROJ = uuid.UUID("28680000-0000-0000-0000-0000000101c1")
STORY = uuid.UUID("28680000-0000-0000-0000-0000000101d1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s, *, description: str = "ORIGINAL_BODY") -> None:
    for sql in [
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2868','s2868-conc-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','u@s2868.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s2868-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OM}','granted','owner')",
        "INSERT INTO stories (id,org_id,project_id,title,status,priority,description) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog','medium','{description}')",
    ]:
        await s.execute(text(sql))
    await s.commit()


# ───────────── ① read-after-write 밀착 반복 — 이 계층엔 재현되지 않음(양성/음성 값 기록) ─────────────

@pytest.mark.anyio
async def test_tight_get_patch_get_loop_has_no_stale_read():
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="BASE")

        anomalies = []
        for i in range(15):
            async with Session() as s:
                repo = StoryRepository(s, ORG)
                current = (await get_story(STORY, repo, _auth_human(USER))).description or ""
            appended = current + f"|{i}"
            async with Session() as s:
                repo = StoryRepository(s, ORG)
                await update_story(
                    STORY, StoryUpdate(description=appended), BackgroundTasks(), repo, s, _auth_human(USER),
                )
            async with Session() as s:
                repo = StoryRepository(s, ORG)
                verify = (await get_story(STORY, repo, _auth_human(USER))).description or ""
            if verify != appended:
                anomalies.append((i, appended, verify))

        assert anomalies == [], (
            f"read-after-write 불일치가 재현되면 원인이 app/primary-DB 레이어에 있다는 뜻 — "
            f"{anomalies}"
        )
    finally:
        await eng.dispose()


# ───────────── ② AC2 — expected_updated_at 낙관적 동시성(docs.py 이식) ─────────────

@pytest.mark.anyio
async def test_stale_expected_updated_at_is_rejected_409():
    """A가 GET한 시점의 updated_at을 들고 있는 사이 B가 먼저 저장 → A의 append가 그 updated_at을
    실어 PATCH하면 409로 거부돼야 한다(사고의 «오래된 스냅숏 기반 PATCH» 클래스를 구조적으로 차단)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="ORIGINAL")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            a_snapshot = await get_story(STORY, repo, _auth_human(USER))

        # B(다른 write, 예: 다른 탭/에이전트)가 먼저 저장 — updated_at이 갱신된다.
        async with Session() as s:
            repo = StoryRepository(s, ORG)
            await update_story(
                STORY, StoryUpdate(description="ORIGINAL + B's edit"), BackgroundTasks(), repo, s,
                _auth_human(USER),
            )

        # A가 자신의 오래된 snapshot 기준 expected_updated_at으로 append PATCH — 거부돼야 한다.
        async with Session() as s:
            repo = StoryRepository(s, ORG)
            with pytest.raises(HTTPException) as exc_info:
                await update_story(
                    STORY,
                    StoryUpdate(
                        description=(a_snapshot.description or "") + " + A's append",
                        expected_updated_at=a_snapshot.updated_at,
                    ),
                    BackgroundTasks(), repo, s, _auth_human(USER),
                )
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "STORY_CONFLICT"

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            final = await get_story(STORY, repo, _auth_human(USER))
        assert "B's edit" in (final.description or "") and "A's append" not in (final.description or ""), (
            "409로 거부됐다면 A의 write는 B의 저장분을 덮어쓰면 안 된다"
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_expected_updated_at_matching_current_succeeds():
    """정상 경로 회귀 — GET 직후 바로 PATCH(사이에 아무도 안 건드림)는 expected_updated_at을
    실어도 그대로 통과해야 한다(오탐 없음)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="ORIGINAL")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            snapshot = await get_story(STORY, repo, _auth_human(USER))

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            resp = await update_story(
                STORY,
                StoryUpdate(
                    description=(snapshot.description or "") + " + append",
                    expected_updated_at=snapshot.updated_at,
                ),
                BackgroundTasks(), repo, s, _auth_human(USER),
            )
        assert resp.description == "ORIGINAL + append"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_expected_updated_at_omitted_is_backward_compatible():
    """expected_updated_at을 아예 안 보내는 기존 호출자는 무체크로 그대로 통과(회귀 0)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="ORIGINAL")
        async with Session() as s:
            repo = StoryRepository(s, ORG)
            resp = await update_story(
                STORY, StoryUpdate(description="NEW"), BackgroundTasks(), repo, s, _auth_human(USER),
            )
        assert resp.description == "NEW"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_force_overwrite_bypasses_conflict_check():
    """force_overwrite=True는 명시적 last-write-wins 승인 — 409를 우회한다(docs.py와 동형 계약)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="ORIGINAL")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            a_snapshot = await get_story(STORY, repo, _auth_human(USER))

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            await update_story(
                STORY, StoryUpdate(description="B's edit"), BackgroundTasks(), repo, s, _auth_human(USER),
            )

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            resp = await update_story(
                STORY,
                StoryUpdate(
                    description="A forces this",
                    expected_updated_at=a_snapshot.updated_at,
                    force_overwrite=True,
                ),
                BackgroundTasks(), repo, s, _auth_human(USER),
            )
        assert resp.description == "A forces this"
    finally:
        await eng.dispose()
