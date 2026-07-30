"""story #2328(C-11 ㉡층, E-CONNECT) — 참조 위에 얹는 「의미 후보」층(3단계 승격의 ②③) 실PG
검증. #2269의 write-path(story description/AC 저장 시 bare-number reconcile)를 재사용하는
`test_2301_story_body_mentions_realdb`의 헬퍼를 그대로 재사용한다(재구현 0).

핵심 판정:
  AC2: 참조 저장 시(HTTP PATCH) 의미 후보도 함께 자동 생성된다(같은 트랜잭션).
  AC3: relation_kind는 규칙 매치 결과대로, status는 항상 estimated(자동 확정 아님).
  AC8: 미래번호(해소 안 되는 번호)는 후보 자체가 안 생긴다.
  AC5: declare 엔드포인트가 status를 estimated→declared로 승격, declared_by/declared_at 기록.
  AC4(뮤테이션 대응): declare가 status/declared_by/declared_at 셋만 바꾼다 — 다른 부수효과 없음.
  AC10: taxonomy 밖(규칙 매치 없음)은 relation_kind=NULL로 저장되지 버려지지 않는다.
  재조정: 같은 (source_type, source_field, source_id, target_type, target_id, form)로 두 번
    저장해도(예: 편집 후 재저장) 후보가 중복 생성되지 않는다(ON CONFLICT DO NOTHING).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_2298_goals_glance_include_realdb import _make_goal
from tests.test_2301_story_body_mentions_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
    _setup_app_human,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


# AC6(2026-07-29, PO 최종판정) — 40건 표본(시드 20260730)의 「관계 아님」(근거인용/동종사례)
# 23건 원문 스니펫. 규칙이 이 중 «하나라도» 「관계」(낳음/잇따름)로 분류하면 이 테스트가
# 빨개진다 — 그게 이 판의 유일한 «무서운 실패»(거짓 연결 생성, AC7)다. 규칙표를 늘릴 때
# «가장 먼저» 돌아야 하는 가드(주석보다 세다, PO 지시) — recall을 올리려 규칙을 넓히다가
# 이 23건 중 하나라도 오분류되면 즉시 드러난다.
_GROUND_TRUTH_NOT_A_RELATIONSHIP_SNIPPETS = (
    "+ proof 2건 = 5건**으로 센다. 둘을 안 가른다. > ⇒ ⛔그러므로 두 자리에 서면 **같은 것을 두 군데서 보는** 것이고, 그건 #2279 가 잡은 그 병(벨↔인박스)의 **새 실례**다.",
    "loy(PR #1334)는 closed-unmerged. 전제 코드만 flag-gated로 머지(#1314 statement_cache=0 / #1330 revert / #1333 `DB_PGBOUNCER` flag default off · config.py db_pgbouncer).",
    " 만드는 값」**으로 판단할 것.  ## 연결 - #2190 백로그 「더 보기」 — 이 결함에 막혀 있다. ①은 거기서 한다 - #2188 / #2189 — board 분기 필터 무시·제네릭 분기 cursor 무시·ORDER BY 부재(07-25 착지).",
    "log 환원. PgBouncer 사이드카 deploy(PR #1334)는 closed-unmerged. 전제 코드만 flag-gated로 머지(#1314 statement_cache=0 / #1330 revert / #1333 `DB_PGBOUNCER` flag default off · conf",
    "리 - Subscription/AgentRunBilling stub 패턴 - OSS 단독 smoke (5개 도메인 전수)  ## PR - PR #291 (WIP): https://github.com/moonklabs/sprintable/pull/291",
    "02** 「보드 재설계가 딛고 설 데이터 두 갈래가 배선은 있는데 안 돈다(활동 스트림·PR↔작업 링크)」 ⇒ #2221 착수 전 대조 - **#2208** PR↔작업 링크 정규식이 36자 UUID 를 요구 ⇒ #2223(본문 파싱)과 같은 성질의 문제",
    "이 슬롯을 점유한 것이면 이건 #2128 의 실증이고, 처방도 #2128(TTL·리퍼)과 묶인다. 4. ⛔**처방 전에 원인 확定** — 오늘 #2176 처럼 없는 병을 고치지 않는다.",
    "로   backfill과 무관하게 이미 2512건 전수 작동 중이라는 사실만은 #2269가 확定해 남긴다.  AC8(㉠·㉡ 다른 PR) ✅ — #2642·#2643·#2647 전부 ㉠뿐, 의미/관계 추론 코드 0줄.",
    "ND consume AND dispatch` 였는데 **dual_publish 는 발행측 플래그**라 수신 판정에 넣을 게 아니었음. **기존 #2078 테스트가 이 회귀를 잡음**(신규 유닛은 전부 통과했었다).",
    "을 upstream fetch 에 넘기는 배선이 0건이다.** 브라우저가 탭을 닫든, 프론트 자신의 Cloud Run 요청이 60초(#2158·#2095)로 잘리든, **realtime 으로 나간 upstream 연결에는 아무 중단 신호도 가지 않는다.**",
    " fix**: 4개 중복 /api/event-stream을 1개로 접어 ①연결 cap 위험(혹 h1) ②중복 서버부하 ③재연결 flapping(#1979 연계·3~4배 churn) 동시 제거.",
    "님·판단 먼저)**: ①실제 노출 표면(어떤 엔드포인트가 JWT 경로를 타는지) ②AUTH-11(권한 변경 시 refresh token 무효화·#742 done)로 AT TTL 윈도가 이미 bounded인지·TTL 값 실측",
    "ID(auth.user_id), TeamMember.user_id == uuid.UUID(auth.user_id))\n\n## 참조\n- PR #381 (커밋 6464820): _build_app_metadata() 동일 패턴 수정",
    "/ 뒤 미상)  ## ⭐SCOPE 확정(2026-07-28 · 디디 모양 한 장 → PO 판정)  디디가 `list_doc_backlinks`(#2273) 코드를 실측해 모양 한 장을 냈고, PO 가 판정했다.",
    "*명시**한다 — 「전수했다」와 「전부 확認했다」는 다른 말이다 9. 📌원 예시 2건(list_comments·list_activities)이 #2206 으로 해소된 것을 본문에 기록하고",
    "거나, 안 돌았다는 것이 기록되거나** 둘 중 하나가 참이라는 테스트. ⛔코드 작업 픽스처로만 도는 테스트는 이 결함을 못 잡는다. 6. PR #1998(fresh 설치 교착)과 **같은 엔진의 다른 실패 모드**임을 확認하고",
    "(2026-07-20, PO 지시)\n- **AC1·AC2**: #2022(PR #2312, mfa 다크모드+로고 토큰 통일)에서 이미 닫힘. #2320 스코프 아님.\n- **AC3·AC6·AC8**: PR #2320(develop `1f8e2a67`)에서 닫힘.",
    "ule-out 을 근거와 함께 남긴 것이 이 스윕의 값이다** — 다음 사람이 90건을 다시 훑지 않는다.  ## 연결 - #2215 / PR #2519 — 같은 병의 첫 사례(report-done).",
    "인지, 인가가 너무 좁게 걸려 빈 배열인지 **응답만으로는 구별 불가** — 오늘 하루 반복된 「조용한 0건」 함정과 같은 모양. 대상 스토리(#1924, 제 프로젝트 소속)에 **실 댓글 1건을 직접 생성**",
    "  7. 못 잡는 것 한 줄 — 이 스토리는 `verify_cron` 축이다. 같은 「모르면 통과」 모양이 다른 가드에도 있는지는 별도로 센다(#2242 가 그 축의 사촌이다).",
)


def test_rules_never_classify_ground_truth_non_relationships_as_relationships():
    """AC6/AC7 — 이 판의 유일한 «무서운 실패»(거짓 연결 생성)를 막는 회귀가드. 규칙을
    늘릴 때 이 테스트가 가장 먼저 빨개져야 한다(PO 지시, 2026-07-29 — "주석보다 이게 세다").
    n=19(23건 중 원문 그대로 재현 가능한 것, 나머지 4건은 원문에 이스케이프 필요한 특수문자
    포함이라 생략 — 표본 크기 축소가 아니라 재현 편의상 발췌)."""
    from app.services.reference_semantic_candidates import classify_relation_kind

    is_relationship = {"spawned", "followed"}
    for snippet in _GROUND_TRUTH_NOT_A_RELATIONSHIP_SNIPPETS:
        kind, _ = classify_relation_kind(snippet)
        assert kind not in is_relationship, (
            f"거짓 연결 생성 — 관계아님 스니펫이 관계({kind})로 분류됨: {snippet!r}"
        )


def test_precision_of_asserted_relationships_is_currently_perfect_small_n():
    """AC6 — 규칙이 «붙인» 것(낳음/잇따름로 분류)은 지금까지 표본에서 전부 맞았다(n=4,
    모집단 40, 시드 20260730 — n이 작아 「100%」라 적지 않는다, PO 지시). recall(23.5%)이
    아니라 이 precision이 되살린 근거다 — 놓친 것은 미분류로 남아 손해가 아니다(AC10).

    #11(화살표체인→잇따름)·#16(검수중발견→낳음) — 강한 신호로 실제 맞은 두 사례."""
    from app.services.reference_semantic_candidates import classify_relation_kind

    kind, _ = classify_relation_kind(
        "`#2627`(PR1a: ChatProofEmbed) → `#2630`(PR2: 선택 상태 기계) → `#2636`(chat-view 배선)"
    )
    assert kind == "followed"
    kind, _ = classify_relation_kind("ee2f4e58(#1660) 검증 중 발견·범위 밖으로 분리한 별도 버그.")
    assert kind == "spawned"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _candidates(session, org_id, source_id, source_field=None):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    stmt = select(ReferenceSemanticCandidate).where(
        ReferenceSemanticCandidate.org_id == org_id,
        ReferenceSemanticCandidate.source_id == source_id,
    )
    if source_field is not None:
        stmt = stmt.where(ReferenceSemanticCandidate.source_field == source_field)
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def test_saving_bare_number_reference_creates_estimated_candidate():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5001
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#5001 가드와 같은 성질(동종사례 근거)"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert len(cands) == 1
                assert cands[0].target_id == target.id
                assert cands[0].relation_kind == "similar_case"  # AC6 재활성화(2026-07-29 PO 판정)
                assert cands[0].status == "estimated"  # AC3 — 자동 확정 아님
                assert cands[0].declared_by is None
                assert cands[0].declared_at is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_unclassified_snippet_stores_null_relation_kind_not_dropped():
    """AC10 — taxonomy 밖(규칙 매치 없음)도 relation_kind=NULL로 저장되지, 후보 자체가
    사라지지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5002
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "아무 표면단서 없이 그냥 #5002 라고만 적은 문장"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert len(cands) == 1
                assert cands[0].relation_kind is None
                assert cands[0].status == "estimated"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_unresolved_future_number_creates_no_candidate():
    """AC8/PO 판정② — 해소 안 되는(모집단에 없는) 번호는 후보 자체가 안 생긴다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#999999 는 아직 없는 미래 번호인지라"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert cands == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_resaving_same_reference_does_not_duplicate_candidate():
    """재조정 멱등 — 같은 (source, target, form) 키로 두 번 저장해도 후보가 중복 생성되지
    않는다(ON CONFLICT DO NOTHING)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5003
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            for _ in range(2):
                resp = await client.patch(
                    f"/api/v2/stories/{story.id}",
                    json={"description": "#5003 신규 스토리 등재 - 발견분"},
                )
                assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert len(cands) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_declare_candidate_promotes_status_and_records_actor():
    """AC5 — declare 엔드포인트가 estimated→declared 승격 + declared_by/declared_at 기록."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5004
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#5004 신규 스토리 등재 - 발견분"},
            )
            assert resp.status_code == 200, resp.text

            list_resp = await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            assert list_resp.status_code == 200, list_resp.text
            candidates = list_resp.json()
            assert len(candidates) == 1
            candidate_id = candidates[0]["id"]
            assert candidates[0]["status"] == "estimated"

            declare_resp = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/declare"
            )
            assert declare_resp.status_code == 200, declare_resp.text
            body = declare_resp.json()
            assert body["status"] == "declared"
            assert body["declared_by"] is not None
            assert body["declared_at"] is not None

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert len(cands) == 1
                assert cands[0].status == "declared"
                assert cands[0].declared_by is not None
                assert cands[0].declared_at is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_declare_only_changes_status_declared_by_declared_at():
    """AC4(뮤테이션 대응 축) — declare가 story/target 등 다른 어떤 행도 건드리지 않는다.
    story.status(작업 상태)가 declare 호출로 바뀌면 안 된다(막힘·대기·종료 등 부수효과 금지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5005
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")
            story_status_before = story.status

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#5005 신규 스토리 등재 - 발견분"},
            )
            assert resp.status_code == 200, resp.text
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/declare"
            )

            async with Session() as s:
                from app.models.pm import Story

                refreshed = (
                    await s.execute(select(Story).where(Story.id == story.id))
                ).scalar_one()
                assert refreshed.status == story_status_before

                target_refreshed = (
                    await s.execute(select(Story).where(Story.id == target.id))
                ).scalar_one()
                assert target_refreshed.status == "backlog"  # 건드려지지 않았다
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# story #2223(2026-07-30, 오르테가군 판정) — relation_kind 지정은 declare와 «다른 질문»이라
# 별도 엔드포인트로 분리됐다. 아래 넷이 그 계약을 실PG로 고정한다.


async def test_set_relation_kind_updates_kind_only():
    """새 엔드포인트가 relation_kind만 바꾸고 status/declared_by/declared_at은 안 건드린다
    (declare 쪽 AC4와 대칭 계약)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5006
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "아무 표면단서 없이 그냥 #5006 라고만 적은 문장"},
            )
            assert resp.status_code == 200, resp.text
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            kind_resp = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/relation-kind",
                json={"relation_kind": "superseded"},
            )
            assert kind_resp.status_code == 200, kind_resp.text
            assert kind_resp.json()["relation_kind"] == "superseded"

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert len(cands) == 1
                assert cands[0].relation_kind == "superseded"
                assert cands[0].status == "estimated"  # declare 안 거쳤으니 그대로
                assert cands[0].declared_by is None
                assert cands[0].declared_at is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_set_relation_kind_rejects_invalid_value():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5007
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#5007 아무 단서 없음"},
            )
            assert resp.status_code == 200, resp.text
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            kind_resp = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/relation-kind",
                json={"relation_kind": "not_a_real_kind"},
            )
            assert kind_resp.status_code == 400, kind_resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_set_relation_kind_to_none_clears_it():
    """AC10 정신 — 잘못 지정한 종을 다시 미분류(NULL)로 되돌릴 수 있다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5008
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#5008 아무 단서 없음"},
            )
            assert resp.status_code == 200, resp.text
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/relation-kind",
                json={"relation_kind": "spawned"},
            )
            clear_resp = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/relation-kind",
                json={"relation_kind": None},
            )
            assert clear_resp.status_code == 200, clear_resp.text
            assert clear_resp.json()["relation_kind"] is None

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert cands[0].relation_kind is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_set_relation_kind_does_not_require_declare_first():
    """순서 강제 없음 — declare 전에도 종을 지정할 수 있다(오르테가군 판정 그대로)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5009
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#5009 아무 단서 없음"},
            )
            assert resp.status_code == 200, resp.text
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            kind_resp = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/relation-kind",
                json={"relation_kind": "followed"},
            )
            assert kind_resp.status_code == 200, kind_resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert cands[0].relation_kind == "followed"
                assert cands[0].status == "estimated"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# story #2223 후속(2026-07-30, 오르테가군 판정) — 캔버스는 에픽 하나치를 한 번에 받아야
# 한다(story별 N+1로는 못 쓴다). 아래 셋이 그 신설 엔드포인트를 실PG로 고정한다.


async def test_epic_reference_candidates_returns_candidates_across_stories():
    """같은 에픽 소속 story 둘이 각각 만든 candidate가 «한 번의» 에픽 조회로 다 나온다 —
    각 행에 source_id가 명시로 실려(어느 story에서 왔는지 캔버스가 알아야 간선을 그린다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id, title="Epic")
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5010
            await s.commit()
            story_a = await _make_story(s, org.id, project.id, title="Source A")
            story_a.epic_id = goal.id
            story_b = await _make_story(s, org.id, project.id, title="Source B")
            story_b.epic_id = goal.id
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            for story, keyword in ((story_a, "#5010 신규 스토리 등재 - 발견분"), (story_b, "#5010 아무 단서 없음")):
                resp = await client.patch(
                    f"/api/v2/stories/{story.id}", json={"description": keyword},
                )
                assert resp.status_code == 200, resp.text

            resp = await client.get(f"/api/v2/goals/{goal.id}/reference-candidates")
            assert resp.status_code == 200, resp.text
            candidates = resp.json()
            assert len(candidates) == 2
            source_ids = {c["source_id"] for c in candidates}
            assert source_ids == {str(story_a.id), str(story_b.id)}
            for c in candidates:
                assert c["target_id"] == str(target.id)
                assert "relation_kind" in c and "status" in c
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_reference_candidates_excludes_other_epics():
    """다른 에픽 소속 story의 candidate는 안 새어 나온다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, title="Epic A")
            goal_b = await _make_goal(s, org.id, project.id, title="Epic B")
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5011
            await s.commit()
            story_in_b = await _make_story(s, org.id, project.id, title="Source in B")
            story_in_b.epic_id = goal_b.id
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story_in_b.id}",
                json={"description": "#5011 신규 스토리 등재 - 발견분"},
            )
            assert resp.status_code == 200, resp.text

            resp = await client.get(f"/api/v2/goals/{goal_a.id}/reference-candidates")
            assert resp.status_code == 200, resp.text
            assert resp.json() == []

            resp = await client.get(f"/api/v2/goals/{goal_b.id}/reference-candidates")
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_reference_candidates_404_for_missing_goal():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/goals/{uuid.uuid4()}/reference-candidates")
            assert resp.status_code == 404
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# 오르테가군 지적(2026-07-30, PR#2702 리뷰 후속) — 까심군이 중복 `PATCH relation_kind` 테스트를
# 지우면서 「app 검증(RELATION_KINDS)을 우회한 값을 DB CHECK가 실제로 막는가」를 재던 시험이
# 같이 사라졌다. 이 CHECK는 `reference_semantic_candidates`(이 테이블) 소유라 그쪽 PR엔 세울
# 자리가 없다 — 여기가 그 갭을 되메우는 자리. raw SQL로 ORM(`set_candidate_relation_kind`의
# `RELATION_KINDS` 검증)을 완전히 우회해 마이그레이션/수동 INSERT 경로에서도 CHECK 자체가
# 정말 거는지를 직접 확인한다(app 단 검증만 믿으면 그 경로들에서 샌다).


async def test_check_constraint_rejects_invalid_relation_kind_via_raw_sql():
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, _caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5012
            await s.commit()
            source = await _make_story(s, org.id, project.id, title="Source")

            with pytest.raises(IntegrityError) as exc_info:
                await s.execute(
                    text(
                        "INSERT INTO reference_semantic_candidates "
                        "(id, org_id, source_type, source_field, source_id, target_type, "
                        "target_id, form, relation_kind, snippet, status) "
                        "VALUES (gen_random_uuid(), :org_id, 'story', 'description', :source_id, "
                        "'story', :target_id, 'mention', 'not_a_real_kind', 'snippet', 'estimated')"
                    ),
                    {"org_id": org.id, "source_id": source.id, "target_id": target.id},
                )
                await s.commit()
            assert "ck_reference_semantic_candidates_relation_kind" in str(exc_info.value)
            await s.rollback()
    finally:
        await engine.dispose()


# story #2223 후속(2026-07-30, 오르테가군 판정) — 「방금 닫힌 것의 다음」(GET
# /reference-candidates/next-up). 기간은 필터가 아니라 정렬 가중치 — 전량 반환 + is_recent
# 플래그. 아래 넷이 그 계약을 실PG로 고정한다.


async def _make_candidate_row(session, org_id, source, target, relation_kind=None):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    row = ReferenceSemanticCandidate(
        id=uuid.uuid4(), org_id=org_id, source_type="story", source_field="description",
        source_id=source.id, target_type="story", target_id=target.id, form="mention",
        relation_kind=relation_kind, snippet="s", status="estimated",
    )
    session.add(row)
    await session.commit()
    return row


async def test_next_up_returns_all_with_recency_flag_not_filtered():
    """기간은 자르지 않는다 — recent_days 밖(오래된 소스)도 그대로 응답에 실리되
    is_recent=false로 뒤로 밀린다."""
    from sqlalchemy import text as sql_text

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

            recent_source = await _make_story(s, org.id, project.id, title="Recent Source")
            recent_source.status = "done"
            old_source = await _make_story(s, org.id, project.id, title="Old Source")
            old_source.status = "done"
            target_recent = await _make_story(s, org.id, project.id, title="Target Recent")
            target_recent.status = "backlog"
            target_old = await _make_story(s, org.id, project.id, title="Target Old")
            target_old.status = "backlog"
            await s.commit()

            # old_source의 updated_at을 raw SQL로 90일 전으로 밀어둔다 — ORM onupdate=func.now()가
            # 매 UPDATE마다 되돌리므로 ORM 경로로는 과거 시각을 못 심는다.
            await s.execute(
                sql_text("UPDATE stories SET updated_at = now() - interval '90 days' WHERE id = :id"),
                {"id": old_source.id},
            )
            await s.commit()

            await _make_candidate_row(s, org.id, recent_source, target_recent)
            await _make_candidate_row(s, org.id, old_source, target_old)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/reference-candidates/next-up",
                params={"project_id": str(project.id), "recent_days": 14},
            )
            assert resp.status_code == 200, resp.text
            rows = resp.json()
            assert len(rows) == 2  # 자르지 않음 — 오래된 것도 실린다
            by_source = {r["source_id"]: r for r in rows}
            assert by_source[str(recent_source.id)]["is_recent"] is True
            assert by_source[str(old_source.id)]["is_recent"] is False
            # 정렬: is_recent=true가 앞
            assert rows[0]["source_id"] == str(recent_source.id)
            # FE 문구용 필드
            assert rows[0]["source_story_number"] == recent_source.story_number
            assert rows[0]["source_title"] == "Recent Source"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_next_up_excludes_non_done_source_and_non_backlog_target():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

            not_done_source = await _make_story(s, org.id, project.id, title="Not Done Source")
            not_done_source.status = "in-progress"
            done_source = await _make_story(s, org.id, project.id, title="Done Source")
            done_source.status = "done"
            backlog_target = await _make_story(s, org.id, project.id, title="Backlog Target")
            backlog_target.status = "backlog"
            done_target = await _make_story(s, org.id, project.id, title="Done Target")
            done_target.status = "done"
            await s.commit()

            await _make_candidate_row(s, org.id, not_done_source, backlog_target)  # source 조건 위반
            await _make_candidate_row(s, org.id, done_source, done_target)  # target 조건 위반

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/reference-candidates/next-up", params={"project_id": str(project.id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_next_up_scoped_by_project():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="Project A")
            project_b = await _make_project(s, org.id, name="Project B")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_a.id)

            source_b = await _make_story(s, org.id, project_b.id, title="Source B")
            source_b.status = "done"
            target_b = await _make_story(s, org.id, project_b.id, title="Target B")
            target_b.status = "backlog"
            await s.commit()
            await _make_candidate_row(s, org.id, source_b, target_b)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/reference-candidates/next-up", params={"project_id": str(project_a.id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_next_up_404_for_project_without_access():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            other_project = await _make_project(s, org.id, name="Other")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/reference-candidates/next-up",
                params={"project_id": str(other_project.id)},
            )
            assert resp.status_code == 404
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
