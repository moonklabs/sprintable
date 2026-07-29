"""story #2262(C-4) AC9② — visual_artifact는 status 컬럼이 없다. 「미결」의 첫 실증으로
`unresolved_comment_count`(ArtifactComment.resolved=false 개수, root+reply 전부 — 스레드는
제품에 없는 개념)를 list_artifacts·get_artifact 양쪽에 싣는다(오르테가 판정 2026-07-29).

이 PR이 #2262가 여는 forward-resolve 축의 첫 새 집계(다른 리소스의 코멘트를 자신의 응답에
숫자로 노출)라, 착수 조건 AC9④(C-3/#2261)가 요구한 대로 그 절차(양성대조·3방 대조·단건+배치
축·뮤테이션 자가검증)를 이 PR 안에서 재실행한다(#2261 본문 명시 — "forward-resolve 라우터를
만들 때 그 PR 안에서 다시 돌려야 한다"). #2261/#2621의 byte-identical 원형을 그대로 재사용하되,
집계값(정수 count)이 대상이므로 "존재 자체를 숨긴다"가 아니라 "내 것이 남의 것에 오염되지
않는다(값이 바뀌지 않는다)"로 판정 기준을 옮긴다 — 원리는 같다(숨겨진/없는 데이터의 존재가
내 응답에 아무 신호도 안 남긴다).
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_VOLATILE_HEADERS = {"date"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _setup_app_human(app, Session, user_id, org_id, project_id):
    """visual_artifacts.py의 `_get_org_project`는 claims.app_metadata.project_id를 직접
    읽는다(conversations.py처럼 DB에서 해소하지 않는다) — 그래서 test_1994의 `_setup_app_human`
    (org_id만 세팅)을 못 쓰고 project_id를 더한 이 파일 전용 변형이 필요하다."""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _make_artifact(session, org_id, project_id, created_by, title="Artifact"):
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact
    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        source="created", latest_version_number=1, created_by=created_by,
    )
    session.add(artifact)
    await session.flush()
    session.add(ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1))
    await session.commit()
    return artifact


async def _make_comment(session, org_id, project_id, artifact_id, created_by, *, resolved=False, parent_id=None):
    from app.models.visual_artifact import ArtifactComment
    c = ArtifactComment(
        id=uuid.uuid4(), artifact_id=artifact_id, org_id=org_id, project_id=project_id,
        content="c", created_by=created_by, parent_id=parent_id, resolved=resolved,
    )
    session.add(c)
    await session.commit()
    return c


def _headers_fingerprint(resp) -> dict:
    return {k.lower(): v for k, v in resp.headers.items() if k.lower() not in _VOLATILE_HEADERS}


# ─── 기능: 정의(root+reply 전부, resolved 제외) ──────────────────────────────


async def test_get_artifact_counts_unresolved_root_and_reply_excludes_resolved():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            artifact = await _make_artifact(s, org.id, project.id, caller_id)
            root_unresolved = await _make_comment(s, org.id, project.id, artifact.id, caller_id, resolved=False)
            await _make_comment(
                s, org.id, project.id, artifact.id, caller_id, resolved=False, parent_id=root_unresolved.id,
            )  # reply, unresolved — counts.
            await _make_comment(s, org.id, project.id, artifact.id, caller_id, resolved=True)  # resolved — excluded.

        await _setup_app_human(app, Session, caller_user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["unresolved_comment_count"] == 2, "root(1)+reply(1) 미해결 — resolved 1건은 제외"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_list_artifacts_includes_per_artifact_count_with_batched_query():
    """N+1 방지 — 페이지 전체가 배치 쿼리 1회로 해소되는지 호출 횟수로 직접 증명(#2619 패턴)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            art_a = await _make_artifact(s, org.id, project.id, caller_id, title="A")
            art_b = await _make_artifact(s, org.id, project.id, caller_id, title="B")
            await _make_comment(s, org.id, project.id, art_a.id, caller_id, resolved=False)
            # art_b: 코멘트 0건 — 0도 명시돼야 한다(누락 아님).

        await _setup_app_human(app, Session, caller_user_id, org.id, project.id)
        client = _client_for(app)
        try:
            import app.routers.visual_artifacts as va
            calls = {"n": 0}
            _orig = va._count_unresolved_comments

            async def _counting(*a, **kw):
                calls["n"] += 1
                return await _orig(*a, **kw)

            va._count_unresolved_comments = _counting
            try:
                resp = await client.get("/api/v2/visual-artifacts")
            finally:
                va._count_unresolved_comments = _orig
            assert resp.status_code == 200, resp.text
            by_id = {item["id"]: item["unresolved_comment_count"] for item in resp.json()["data"]}
            assert by_id[str(art_a.id)] == 1
            assert by_id[str(art_b.id)] == 0
            assert calls["n"] == 1, f"페이지 1개에 집계 쿼리가 {calls['n']}번 나갔다(N+1)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ① 양성대조 — 「있는 것을 있다고 잡는가」 ──────────────────────────────


async def test_positive_control_get_artifact_sees_own_unresolved_comment():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            artifact = await _make_artifact(s, org.id, project.id, caller_id)
            await _make_comment(s, org.id, project.id, artifact.id, caller_id, resolved=False)

        await _setup_app_human(app, Session, caller_user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact.id}")
            assert resp.status_code == 200
            assert resp.json()["data"]["unresolved_comment_count"] >= 1, (
                "양성대조 실패 — 접근권 있는 코멘트가 안 잡힘. 이게 실패하면 아래 대조는 "
                "'0건'이 '못 봐서'인지 '없어서'인지 구분 불가."
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ② 세 응답 대조 — mine+theirs vs mine+없는id vs mine(기준선) ────────────
# 값(정수 count) 대상이라 "존재 비노출"이 아니라 "내 값이 남의 것에 안 물든다"로 판정한다.


async def test_three_way_other_projects_unresolved_comments_do_not_leak_into_mine():
    """배치 축(list_artifacts) — 다른 project(접근권 없음)에 미해결 코멘트가 대량 있어도
    내 artifact의 count·목록·응답 크기가 바뀌지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_mine = await _make_project(s, org.id, "Mine")
            project_theirs = await _make_project(s, org.id, "Theirs")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_mine.id)
            other_id, _ = await _make_human_member(s, org.id, project_theirs.id)

            # ㉢ 기준선 — mine 1개, 코멘트 없음.
            mine_baseline = await _make_artifact(s, org.id, project_mine.id, caller_id, title="MineBaseline")

        await _setup_app_human(app, Session, caller_user_id, org.id, project_mine.id)
        client = _client_for(app)
        try:
            resp_baseline = await client.get("/api/v2/visual-artifacts")
            assert resp_baseline.status_code == 200, resp_baseline.text

            # ㉠ mine + theirs(다른 project artifact에 미해결 코멘트 5개 — 접근권 없음).
            async with Session() as s:
                for i in range(5):
                    theirs_artifact = await _make_artifact(s, org.id, project_theirs.id, other_id, title=f"Theirs{i}")
                    await _make_comment(s, org.id, project_theirs.id, theirs_artifact.id, other_id, resolved=False)

            resp_with_theirs = await client.get("/api/v2/visual-artifacts")
            assert resp_with_theirs.status_code == 200, resp_with_theirs.text

            # ㉡ mine만 재확인(theirs 존재와 무관하게 mine 응답이 그대로인지 최종 확인).
            resp_after = await client.get("/api/v2/visual-artifacts")

            for label, resp in (("baseline", resp_baseline), ("with_theirs", resp_with_theirs), ("after", resp_after)):
                body = resp.json()
                ids = {item["id"] for item in body["data"]}
                assert ids == {str(mine_baseline.id)}, f"{label}: theirs artifact가 목록에 샜다 — {ids}"
                assert body["data"][0]["unresolved_comment_count"] == 0, (
                    f"{label}: 남의 project 미해결 코멘트가 내 artifact count로 흘러들었다"
                )

            assert resp_baseline.status_code == resp_with_theirs.status_code == resp_after.status_code == 200
            assert len(resp_baseline.content) == len(resp_with_theirs.content) == len(resp_after.content), (
                "theirs 존재 여부로 응답 크기가 달라졌다 — mine 응답이 남의 데이터 존재에 영향받는다"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_single_axis_get_artifact_isolated_from_sibling_artifact_comments():
    """단건 축(get_artifact) — 같은 project 안 다른 artifact의 미해결 코멘트가 내 artifact의
    count로 안 새는지의 «정확성» 테스트. ⛔실측(사보타주 절 참조): 이 격리는 `artifact_id.
    in_(...)` 필터가 아니라 `GROUP BY artifact_id`가 준다 — 그 필터를 제거해도 이 테스트는
    여전히 GREEN이었다(각 코멘트가 자기 artifact_id로만 그룹되므로). 필터의 실제 역할은
    스코프 최적화(호출자가 관심 있는 id만 조회)이지, 이 테스트가 지키는 누출 방지가 아니다
    — 그래서 이 테스트를 «뮤테이션이 잡는 회귀 가드»로 부풀려 부르지 않는다(정확성 pin일 뿐)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            mine = await _make_artifact(s, org.id, project.id, caller_id, title="Mine")
            sibling = await _make_artifact(s, org.id, project.id, caller_id, title="Sibling")
            await _make_comment(s, org.id, project.id, sibling.id, caller_id, resolved=False)
            await _make_comment(s, org.id, project.id, sibling.id, caller_id, resolved=False)

        await _setup_app_human(app, Session, caller_user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{mine.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["unresolved_comment_count"] == 0, (
                "sibling artifact의 미해결 코멘트 2건이 내 artifact count로 샜다"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 뮤테이션 자가검증 — 이 스위트가 실제로 판별력을 갖는지 실증 ─────────────
# 실제 프로덕션 코드(app/routers/visual_artifacts.py의 `_count_unresolved_comments`)를 직접
# Edit로 사보타주 → 재실행 → RED 확認 → 원복 → 재실행 → GREEN 확認 순으로 세션에서 실행했다:
#   ① `resolved.is_(False)` 제거 → test_get_artifact_counts_unresolved_root_and_reply_
#      excludes_resolved · test_mutation_self_check_resolved_filter_is_load_bearing 정확히
#      그 2건만 FAIL(resolved 코멘트가 새어 count가 부풀려짐). 나머지 4건 무영향. 원복 시 6/6.
#   ② ⛔`artifact_id.in_(...)` 제거 → **6/6 그대로 GREEN**(예상과 다름, 정직하게 기록한다).
#      이 필터의 실 역할은 스코프 최적화이지 격리가 아니다 — 격리는 `GROUP BY artifact_id`가
#      준다. 그래서 이 필터를 "제거하면 잡히는 뮤테이션 가드"로 아래 두지 않는다(위
#      test_single_axis_* docstring 참조 — 부풀려 주장하지 않는다).
# 아래 테스트는 ①(진짜 판별력이 있는 것으로 실증된 조건)만 코드로 고정해 회귀 가드로 남긴다.


async def test_mutation_self_check_resolved_filter_is_load_bearing():
    """resolved=false 필터를 몽키패치로 제거 → resolved 코멘트가 새어 count가 부풀려지는 것을
    직접 재현 → 이 파일의 §정의 테스트가 그 결함을 실제로 잡는다는 것을 스스로 증명한다."""
    from app.main import app
    import app.routers.visual_artifacts as va
    from sqlalchemy import func, select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            artifact = await _make_artifact(s, org.id, project.id, caller_id)
            await _make_comment(s, org.id, project.id, artifact.id, caller_id, resolved=True)

        async def _sabotaged(session, artifact_ids):
            from app.models.visual_artifact import ArtifactComment
            if not artifact_ids:
                return {}
            rows = (await session.execute(
                select(ArtifactComment.artifact_id, func.count())
                .where(ArtifactComment.artifact_id.in_(artifact_ids))  # ⛔resolved 필터 빠짐(사보타주)
                .group_by(ArtifactComment.artifact_id)
            )).all()
            return {aid: c for aid, c in rows}

        await _setup_app_human(app, Session, caller_user_id, org.id, project.id)
        client = _client_for(app)
        _orig = va._count_unresolved_comments
        va._count_unresolved_comments = _sabotaged
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact.id}")
            assert resp.json()["data"]["unresolved_comment_count"] == 1, (
                "사보타주가 안 먹었다(resolved 필터 제거해도 여전히 0이면 이 검증 자체가 무의미)"
            )
        finally:
            va._count_unresolved_comments = _orig
            await client.aclose()
            app.dependency_overrides.clear()

        # 원복 확인 — 진짜 함수는 resolved 코멘트를 안 센다.
        await _setup_app_human(app, Session, caller_user_id, org.id, project.id)
        client2 = _client_for(app)
        try:
            resp2 = await client2.get(f"/api/v2/visual-artifacts/{artifact.id}")
            assert resp2.json()["data"]["unresolved_comment_count"] == 0, "원복 후에도 resolved 코멘트가 세어졌다"
        finally:
            await client2.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
