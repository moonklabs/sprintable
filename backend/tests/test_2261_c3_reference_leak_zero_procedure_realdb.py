"""story #2261(C-3·안전핀) — 누설 0 증명 절차를 «지금 있는 참조 읽기 경로»(#2266 story/doc
backlinks — incoming 방향)에 실제로 적용한다.

파울로 판정(2026-07-29): #2261의 대상은 아직 없는 forward-resolve(#2262가 열 자리)가 아니라
지금 이미 라이브인 backlinks다 — 새 라우터 0개, «있는 것을 재는» 것.

절차(스토리 본문 그대로, ⚠️표시 자리를 backlinks의 실제 두 진입점으로 치환):
  ①양성대조 — caller가 접근권 있는 entity를 backlinks로 조회해 「있는 것을 있다고 잡는가」부터
  ②세 응답 대조 — ㉠mine+theirs(존재하되 org 밖) ㉡mine+없는id ㉢mine만(기준선), status·헤더·
    content-length까지 byte-identical
  ③단건+배치 — 단건=TARGET 게이트(조회 대상 자체), 배치=한 응답 안에서 걸러지는 SOURCE 목록
    (원본 절차의 "단건 API/배치 API" 두 진입점이 backlinks엔 이 두 축으로 치환된다 — 별도
    배치 엔드포인트가 없으므로 «한 호출 안의 다건 필터링»이 배치 축의 실체)
  ④못 잡는 것 — 스토리 본문 그대로(타이밍 사이드채널·캐싱 레이어·다른 채널 누설·시점 스냅샷·
    FE 렌더 레이어) + 이 적용에서 새로 드러난 것 둘:
    ⛔**forward-resolve 경로는 아직 없으므로 이 절차가 안 잰다** — #2262가 참조를 대상
      콘텐츠(상태·다음 행동)로 펼치는 라우터를 만들 때, **이 절차를 그 PR 안에서 다시
      돌려야 한다**(#2261이 done이 돼도 C-4 前에 재실행 필요 — 코드 옆의 이 선언이 그 의무를
      남긴다).
    ⚠️**단건(TARGET) 축은 지금 byte-identical이 아니다** — `test_single_axis_target_gate_
      flagged_403_vs_404_asymmetry`가 실측: 존재하되 접근권 없음=403, 존재 자체가 없음=404
      (stories.py/docs.py 기존 SEC-S8 감사 계약, 이 PR 범위 밖 — 조용히 안 바꿈). 이 절차가
      증명하는 것은 «배치(SOURCE 목록) 축의 누설 0»이지 «TARGET 자체의 존재 비노출»이 아니다.

byte-identical 대조 방법은 오늘 #2245 배치 감사에서 쓴 원형을 그대로 재사용(새로 안 짓는다) —
status code·content-length·정렬된 헤더 키 집합(Date 등 매 요청 변하는 키 제외) 셋을 비교한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_doc,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
    _t,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

# 매 요청마다 값이 바뀔 수 있는 헤더 — byte-identical 대조에서 제외(응답 "형태"만 비교).
_VOLATILE_HEADERS = {"date"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.commit()
    return story


async def _make_mention_to(
    session, org_id, source_type, source_id, target_type, target_id, created_by, created_at=None,
):
    """`_make_mention`(test_1994)은 target_type을 "doc"으로 고정한다 — story target도 필요해
    일반화한 버전. 그 외 계약은 동일(entity_references에 시드, source_field="body")."""
    from app.models.reference import Reference
    m = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field="body",
        source_id=source_id, target_type=target_type, target_id=target_id, form="mention",
        created_by=created_by,
    )
    if created_at is not None:
        m.created_at = created_at
    session.add(m)
    await session.commit()
    return m


def _headers_fingerprint(resp) -> dict:
    return {k.lower(): v for k, v in resp.headers.items() if k.lower() not in _VOLATILE_HEADERS}


def _assert_byte_identical(resp_a, resp_b, label: str) -> None:
    assert resp_a.status_code == resp_b.status_code, (
        f"{label}: status 다름 — {resp_a.status_code} vs {resp_b.status_code}"
    )
    assert len(resp_a.content) == len(resp_b.content), (
        f"{label}: content-length 다름 — {len(resp_a.content)} vs {len(resp_b.content)} "
        f"(a={resp_a.content!r} b={resp_b.content!r})"
    )
    fa, fb = _headers_fingerprint(resp_a), _headers_fingerprint(resp_b)
    assert fa == fb, f"{label}: 헤더(휘발성 제외) 다름 — {fa} vs {fb}"


# ─── ① 양성대조 — 「있는 것을 있다고 잡는가」 ──────────────────────────────


@pytest.mark.anyio
async def test_positive_control_doc_backlinks_sees_own_accessible_source():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_doc(s, org.id, project.id, title="Target")
            source = await _make_doc(s, org.id, project.id, title="Findable Source")
            await _make_mention_to(s, org.id, "doc", source.id, "doc", target.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(item["source_id"] == str(source.id) for item in body["data"]), (
                "양성대조 실패 — 접근권 있는 소스가 backlinks에 안 잡힘. "
                "이게 실패하면 ②③은 의미 없다(0건이 '못 봐서'인지 '없어서'인지 구분 불가)."
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_positive_control_story_backlinks_sees_own_accessible_source():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target Story")
            source = await _make_doc(s, org.id, project.id, title="Findable Source")
            await _make_mention_to(s, org.id, "doc", source.id, "story", target.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{target.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(item["source_id"] == str(source.id) for item in body["data"]), (
                "양성대조 실패 — story backlinks가 접근권 있는 소스를 못 잡음."
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ② 세 응답 대조 — ㉠mine+theirs vs ㉡mine+없는id vs ㉢mine(기준선), byte-identical ──


@pytest.mark.anyio
async def test_three_way_byte_identical_doc_backlinks_source_axis():
    """배치 축(한 응답 안의 다건 소스 필터링) — doc backlinks."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_ok = await _make_project(s, org.id, "OK")
            project_no = await _make_project(s, org.id, "NO")
            member_ok, user_ok = await _make_human_member(s, org.id, project_ok.id)
            member_no, _ = await _make_human_member(s, org.id, project_no.id)

            # ㉢ 기준선용 — mine 2개만.
            target_baseline = await _make_doc(s, org.id, project_ok.id, title="TargetBaseline")
            mine1 = await _make_doc(s, org.id, project_ok.id, title="Mine1")
            mine2 = await _make_doc(s, org.id, project_ok.id, title="Mine2")
            await _make_mention_to(s, org.id, "doc", mine1.id, "doc", target_baseline.id, created_by=member_ok, created_at=_t(1))
            await _make_mention_to(s, org.id, "doc", mine2.id, "doc", target_baseline.id, created_by=member_ok, created_at=_t(2))

            # ㉠ mine 2 + theirs(존재하나 다른 project) 2.
            target_theirs = await _make_doc(s, org.id, project_ok.id, title="TargetTheirs")
            mine3 = await _make_doc(s, org.id, project_ok.id, title="Mine3")
            mine4 = await _make_doc(s, org.id, project_ok.id, title="Mine4")
            theirs1 = await _make_doc(s, org.id, project_no.id, title="Theirs1")
            theirs2 = await _make_doc(s, org.id, project_no.id, title="Theirs2")
            await _make_mention_to(s, org.id, "doc", mine3.id, "doc", target_theirs.id, created_by=member_ok, created_at=_t(1))
            await _make_mention_to(s, org.id, "doc", mine4.id, "doc", target_theirs.id, created_by=member_ok, created_at=_t(2))
            await _make_mention_to(s, org.id, "doc", theirs1.id, "doc", target_theirs.id, created_by=member_no, created_at=_t(3))
            await _make_mention_to(s, org.id, "doc", theirs2.id, "doc", target_theirs.id, created_by=member_no, created_at=_t(4))

            # ㉡ mine 2 + 존재 자체가 없는 임의 UUID 2(고아 mention row — source row가 아예 없음).
            target_nonexistent = await _make_doc(s, org.id, project_ok.id, title="TargetNonexistent")
            mine5 = await _make_doc(s, org.id, project_ok.id, title="Mine5")
            mine6 = await _make_doc(s, org.id, project_ok.id, title="Mine6")
            await _make_mention_to(s, org.id, "doc", mine5.id, "doc", target_nonexistent.id, created_by=member_ok, created_at=_t(1))
            await _make_mention_to(s, org.id, "doc", mine6.id, "doc", target_nonexistent.id, created_by=member_ok, created_at=_t(2))
            ghost1, ghost2 = uuid.uuid4(), uuid.uuid4()
            await _make_mention_to(s, org.id, "doc", ghost1, "doc", target_nonexistent.id, created_by=member_ok, created_at=_t(3))
            await _make_mention_to(s, org.id, "doc", ghost2, "doc", target_nonexistent.id, created_by=member_ok, created_at=_t(4))

        await _setup_app_human(app, Session, user_ok, org.id)
        client = _client_for(app)
        try:
            resp_baseline = await client.get(f"/api/v2/docs/{target_baseline.id}/backlinks")
            resp_theirs = await client.get(f"/api/v2/docs/{target_theirs.id}/backlinks")
            resp_nonexistent = await client.get(f"/api/v2/docs/{target_nonexistent.id}/backlinks")
            assert resp_baseline.status_code == 200, resp_baseline.text
            assert resp_theirs.status_code == 200, resp_theirs.text
            assert resp_nonexistent.status_code == 200, resp_nonexistent.text

            for label, resp in (("theirs", resp_theirs), ("nonexistent", resp_nonexistent)):
                body = resp.json()
                ids = {item["source_id"] for item in body["data"]}
                assert ids == {str(mine1.id), str(mine2.id)} or len(ids) == 2, (
                    f"{label}: mine 2건만 나와야(다른 target이라 실제 id는 다르지만 개수·구조는 baseline과 동형)"
                )
                assert str(theirs1.id) not in ids and str(theirs2.id) not in ids
                assert str(ghost1) not in ids and str(ghost2) not in ids

            _assert_byte_identical(resp_theirs, resp_nonexistent, "㉠theirs vs ㉡nonexistent")

            # ㉢ 기준선과도 구조(길이·헤더)가 같아야 한다 — target id 문자열 차이로 인한
            # content-length 편차는 UUID 고정 길이(36자)라 없다는 것도 이 대조가 같이 증명한다.
            _assert_byte_identical(resp_baseline, resp_theirs, "㉢baseline vs ㉠theirs")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_three_way_byte_identical_story_backlinks_source_axis():
    """배치 축 — story backlinks(doc과 별개 라우트·별개 target 테이블이라 독립적으로 잰다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_ok = await _make_project(s, org.id, "OK")
            project_no = await _make_project(s, org.id, "NO")
            member_ok, user_ok = await _make_human_member(s, org.id, project_ok.id)
            member_no, _ = await _make_human_member(s, org.id, project_no.id)

            target_theirs = await _make_story(s, org.id, project_ok.id, title="TS-Theirs")
            mine1 = await _make_doc(s, org.id, project_ok.id, title="Mine1")
            theirs1 = await _make_doc(s, org.id, project_no.id, title="Theirs1")
            await _make_mention_to(s, org.id, "doc", mine1.id, "story", target_theirs.id, created_by=member_ok, created_at=_t(1))
            await _make_mention_to(s, org.id, "doc", theirs1.id, "story", target_theirs.id, created_by=member_no, created_at=_t(2))

            target_nonexistent = await _make_story(s, org.id, project_ok.id, title="TS-Nonexistent")
            mine2 = await _make_doc(s, org.id, project_ok.id, title="Mine2")
            ghost = uuid.uuid4()
            await _make_mention_to(s, org.id, "doc", mine2.id, "story", target_nonexistent.id, created_by=member_ok, created_at=_t(1))
            await _make_mention_to(s, org.id, "doc", ghost, "story", target_nonexistent.id, created_by=member_ok, created_at=_t(2))

        await _setup_app_human(app, Session, user_ok, org.id)
        client = _client_for(app)
        try:
            resp_theirs = await client.get(f"/api/v2/stories/{target_theirs.id}/backlinks")
            resp_nonexistent = await client.get(f"/api/v2/stories/{target_nonexistent.id}/backlinks")
            assert resp_theirs.status_code == 200, resp_theirs.text
            assert resp_nonexistent.status_code == 200, resp_nonexistent.text

            for resp in (resp_theirs, resp_nonexistent):
                ids = {item["source_id"] for item in resp.json()["data"]}
                assert len(ids) == 1, ids
                assert str(theirs1.id) not in ids and str(ghost) not in ids

            _assert_byte_identical(resp_theirs, resp_nonexistent, "story ㉠theirs vs ㉡nonexistent")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ③ 단건+배치 — 단건(TARGET 게이트) 축 ──────────────────────────────────


@pytest.mark.anyio
async def test_single_axis_target_gate_flagged_403_vs_404_asymmetry():
    """⚠️실측 결과 — 스토리 본문이 가정한 «단건 축도 byte-identical»이 지금 코드에서는 안 선다.

    `_assert_story_project_access`/`_require_doc_project_access`는 대상이 «존재하되 접근권
    없음»이면 403, «존재 자체가 없음»이면 404를 낸다(stories.py:264·docs.py:598 — 코드로
    직접 확認, 둘 다 일관되게 이 패턴). references.py의 create/delete 게이트(둘 다 404 —
    "존재 비노출 오라클")와 다른 설계다.

    ⛔이 테스트는 실패가 아니라 «지금 상태를 고정하는 기록»이다 — SEC-S8(story 83ea3d6a)가
    이미 감사한 기존 계약을 이 PR이 조용히 바꾸지 않는다(범위 밖 변경 금지). 이 비대칭이
    #2261의 «누설 0» 기준에 부합하는지는 PO 판단으로 남긴다 — 코드가 그렇다는 사실만 여기
    실측으로 고정해 둔다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_ok = await _make_project(s, org.id, "OK")
            project_no = await _make_project(s, org.id, "NO")
            _, user_ok = await _make_human_member(s, org.id, project_ok.id)
            story_theirs = await _make_story(s, org.id, project_no.id, title="TheirsStory")
            doc_theirs = await _make_doc(s, org.id, project_no.id, title="TheirsDoc")

        await _setup_app_human(app, Session, user_ok, org.id)
        client = _client_for(app)
        try:
            resp_story_theirs = await client.get(f"/api/v2/stories/{story_theirs.id}/backlinks")
            resp_story_ghost = await client.get(f"/api/v2/stories/{uuid.uuid4()}/backlinks")
            resp_doc_theirs = await client.get(f"/api/v2/docs/{doc_theirs.id}/backlinks")
            resp_doc_ghost = await client.get(f"/api/v2/docs/{uuid.uuid4()}/backlinks")

            # 실측 그대로 기록 — 존재하되 접근권 없음=403, 존재 자체가 없음=404.
            assert resp_story_theirs.status_code == 403, resp_story_theirs.text
            assert resp_story_ghost.status_code == 404, resp_story_ghost.text
            assert resp_doc_theirs.status_code == 403, resp_doc_theirs.text
            assert resp_doc_ghost.status_code == 404, resp_doc_ghost.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 뮤테이션 자가검증 — 이 테스트들이 실제로 그 필터를 붙잡고 있는지 ───────────


@pytest.mark.anyio
async def test_mutation_self_check_source_filter_actually_guards(monkeypatch):
    """`list_doc_backlinks`의 authz predicate를 무력화(사보타주)하면 ②의 leak-zero 대조가
    실제로 RED가 되는 것을 보인다 — 이 절차 자체가 «아무것도 안 재서» 통과하는 게 아님을
    증명한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_ok = await _make_project(s, org.id, "OK")
            project_no = await _make_project(s, org.id, "NO")
            member_ok, user_ok = await _make_human_member(s, org.id, project_ok.id)
            member_no, _ = await _make_human_member(s, org.id, project_no.id)

            target = await _make_doc(s, org.id, project_ok.id, title="Target")
            mine = await _make_doc(s, org.id, project_ok.id, title="Mine")
            theirs = await _make_doc(s, org.id, project_no.id, title="Theirs")
            await _make_mention_to(s, org.id, "doc", mine.id, "doc", target.id, created_by=member_ok, created_at=_t(1))
            await _make_mention_to(s, org.id, "doc", theirs.id, "doc", target.id, created_by=member_no, created_at=_t(2))

        await _setup_app_human(app, Session, user_ok, org.id)
        client = _client_for(app)
        try:
            # 사보타주 전 — theirs가 안 보여야 정상.
            resp = await client.get(f"/api/v2/docs/{target.id}/backlinks")
            ids_before = {item["source_id"] for item in resp.json()["data"]}
            assert str(theirs.id) not in ids_before, "사보타주 전인데 이미 새고 있다 — 사전조건 오염"

            # 사보타주 — project_access_valid_correlated(SQL WHERE절에 심는 실제 authz atom)를
            # 항상-참 표현식으로 바꿔치기해 source-authz 필터를 무력화(정확히 이 필터가 하는
            # 일을 되돌린다 — backlinks.py가 project_auth에서 import해 쓰는 그 이름 그대로).
            from sqlalchemy import true as _sa_true

            import app.services.backlinks as backlinks_mod

            def _leaky_project_access_valid_correlated(project_id_col, *, caller_id, org_id):
                return _sa_true()

            monkeypatch.setattr(
                backlinks_mod, "project_access_valid_correlated", _leaky_project_access_valid_correlated,
            )

            resp_sabotaged = await client.get(f"/api/v2/docs/{target.id}/backlinks")
            ids_after = {item["source_id"] for item in resp_sabotaged.json()["data"]}
            assert str(theirs.id) in ids_after, (
                "사보타주가 안 먹혔다 — accessible_project_ids_in_org가 이 경로의 실제 필터가 "
                "맞는지부터 재확認해야 한다(사보타주 지점이 틀렸을 수 있음)"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
