"""story #2629(챗·전달계약) — 본문의 맨 스토리 번호(`#24`류)를 서버가 entity 임베드로
자동 승격. P0의 본문 `@handle` 파서(story #2646로 은퇴)와 동형 철학이었다(read-only
해석이 아니라 본문 자체를 저장 시점에 치환하는 첫 사례).

커버: ①순수 regex 후보 추출(dev 실측 오탐 경계 — 헥스 컬러 배제·한글 조사 결합 통과)
②보호 구간(코드블록/인라인코드/기존 entity 토큰) ③실 DB resolve(org+project 스코프·
실패 시 원문 유지·타 project 미스코프) ④send_message() 전체 경로에서 agent/human 양쪽
동형 적용(AC3)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


# ── ① 순수 regex 후보 추출 — dev 실측 오탐 경계 그대로 고정 ─────────────────────
def test_extract_bare_ref_plain_number():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    content = "보드 확인은 #24 참고"
    cands = extract_bare_story_ref_candidates(content)
    assert len(cands) == 1
    start, end, number = cands[0]
    assert number == 24
    assert content[start:end] == "#24"


def test_extract_bare_ref_korean_particle_attached():
    """dev 실측 다수 형태 — #2629와 처럼 한글 조사가 공백 없이 바로 붙는 케이스."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    content = "#2629와 #2642로 같이 보는"
    cands = extract_bare_story_ref_candidates(content)
    numbers = [c[2] for c in cands]
    assert numbers == [2629, 2642]


def test_extract_bare_ref_hex_color_excluded():
    """dev 실측 1위 오탐 축 — 매치 직후 라틴 알파벳이면(헥스 컬러류) 통째로 제외."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("baseline `#74747c` 톤") == []
    assert extract_bare_story_ref_candidates("색상 #95959c 확인") == []


def test_extract_bare_ref_double_hash_excluded():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("## 42 제목") == []


def test_extract_bare_ref_multiple_and_none():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("") == []
    assert extract_bare_story_ref_candidates("아무 번호도 없음") == []
    cands = extract_bare_story_ref_candidates("#1 그리고 #2 둘 다")
    assert [c[2] for c in cands] == [1, 2]


# ── story #2651 — 「PR #N」오승격 회귀 pin (실피해 재현: 9e19d9b2·45e9e868) ─────────
def test_extract_bare_ref_pr_prefixed_excluded():
    """AC1 — 직전 토큰이 「PR」이면 승격 후보에서 제외. 실피해 그대로 재현."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("PR #19 리뷰 완료") == []
    assert extract_bare_story_ref_candidates("PR [E-02-S-02…] 열었음(fix/x) — PR #21 열었음") == []


def test_extract_bare_ref_pr_prefixed_case_insensitive_and_no_space():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("pr #21 머지") == []
    assert extract_bare_story_ref_candidates("PR#21 머지") == []


def test_extract_bare_ref_bare_hash_still_promotes_no_regression():
    """AC2 — 맨 `#N`(PR 접두 없음) 승격은 무회귀."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    cands = extract_bare_story_ref_candidates("확인은 #24 참고")
    assert [c[2] for c in cands] == [24]


def test_extract_bare_ref_pr_lookalike_word_not_excluded():
    """`SUPR #21`처럼 「PR」 앞에 다른 알파벳/숫자가 곧장 붙으면 PR 토큰이 아니다 — 과도한
    제외 방지(단어 경계 lookbehind 회귀 pin)."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    cands = extract_bare_story_ref_candidates("SUPR #21 확인")
    assert [c[2] for c in cands] == [21]


# ── story #2660(#2651 후속) — GitHub 「repo-name#N」 오승격 회귀 pin ────────────────
def test_extract_bare_ref_repo_name_hash_excluded():
    """실피해 문장 그대로(agent-plugins#25·gemini#3) — 레포명 직후 해시(공백 없음)는
    GitHub 크로스레포 관례라 승격 제외."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("카디르 발신 「agent-plugins#25」") == []
    assert extract_bare_story_ref_candidates("gemini#3 PR 확인 바라는") == []


def test_extract_bare_ref_repo_shorthand_compound_prefix_excluded():
    """`sprintable-`류 접두가 붙은 전체 레포명("sprintable-agent-plugins")도 접미사
    매칭으로 같이 걸린다(하이픈 앞 토큰과 무관하게 "agent-plugins"로 끝나면 매치)."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("sprintable-agent-plugins#25 확인") == []
    assert extract_bare_story_ref_candidates("sprintable-mobile#4 배포") == []
    assert extract_bare_story_ref_candidates("sprintable-claude-plugin#1 확인") == []


def test_extract_bare_ref_team_shorthand_hash_prefix_not_excluded():
    """AC2 양성대조(GROUP BY 실측, story #2660) — 「story#N」/「BE#N」/「FE#N」류 팀 표기는
    레포 짧은이름 허용목록에 없어 계속 승격된다(dev 60일 실측: story#N 11건·BE#N/FE#N
    다수 확인 — 이 축을 깨는 설계는 #2629/#2651과 같은 "실측 없는 과잉 제외" 재발이었다,
    최초 설계(임의 라틴 단어문자 전부 제외)에서 이 실측으로 걷어냄)."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert [c[2] for c in extract_bare_story_ref_candidates("story#2588(As 이전")] == [2588]
    assert [c[2] for c in extract_bare_story_ref_candidates("BE#1839 계약 확인")] == [1839]
    assert [c[2] for c in extract_bare_story_ref_candidates("라이브 픽셀은 FE#1840+BE#1839 dep")] == [1840, 1839]


def test_extract_bare_ref_unlisted_word_hash_prefix_not_excluded():
    """허용목록에 없는 임의 라틴 단어("my_repo" 등)는 레포 짧은이름이 아니므로 승격
    무회귀 — 허용목록 방식이 "라틴 단어문자 전부"가 아님을 명시적으로 고정."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert [c[2] for c in extract_bare_story_ref_candidates("my_repo#7 이슈")] == [7]
    assert [c[2] for c in extract_bare_story_ref_candidates("v1.2#3 릴리즈 노트")] == [3]


def test_extract_bare_ref_korean_word_hash_prefix_not_excluded():
    """양성대조 — 한글 단어가 «#N 앞»에 공백 없이 붙는 것은 GitHub repo-name 관례가
    아니므로(그 관례는 라틴 식별자 문자셋뿐) 제외 대상이 아니다. 한글 조사는 원래
    «#N 뒤»에 붙는 형태(모듈 docstring)이지만, 이 pin은 그 반대 방향(#N 앞)도 안전함을
    명시적으로 고정한다."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    cands = extract_bare_story_ref_candidates("확인#24 부탁")
    assert [c[2] for c in cands] == [24]


def test_extract_bare_ref_space_before_hash_still_promotes_no_regression():
    """AC2 — 공백 하나만 있어도(레포명류가 아니라 진짜 단어 뒤 공백) 무회귀."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    cands = extract_bare_story_ref_candidates("story #24 그리고 문서 #25")
    assert [c[2] for c in cands] == [24, 25]


# ── ② 보호 구간 ────────────────────────────────────────────────────────────────
async def test_promote_skips_fenced_code_block():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "설명\n```\n# 24 이건 셸 주석\n```\n끝"
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert result == content  # 코드블록 안이라 무변환
            assert promoted_ids == set()
    finally:
        await engine.dispose()


async def test_promote_skips_inline_code():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "명령어 `git checkout #24` 참고"
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert result == content
            assert promoted_ids == set()
    finally:
        await engine.dispose()


async def test_promote_skips_existing_entity_token():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "[이슈 #24 수정](entity:story:11111111-1111-1111-1111-111111111111) 참고"
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert result == content  # 이미 토큰 안 — 이중 변환 금지
            assert promoted_ids == set()
    finally:
        await engine.dispose()


# story #3162(채팅·치환 결함) — 인용부호/블록인용 안의 #N은 재인용이지 새 참조 의도가
# 아니다(디캄포 오늘 밤 재발 실사고: 정정 메시지에서 오염된 원문을 그대로 다시 인용해
# 재승격됨). 코드블록/인라인코드와 같은 "예시 영역" 원칙을 확장.
async def test_promote_skips_double_quoted_number():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = '방금 메시지의 "#24" 인용은 예시일 뿐인'
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert result == content
            assert promoted_ids == set()
    finally:
        await engine.dispose()


async def test_promote_skips_korean_bracket_quoted_number():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "원문 그대로 재인용하는 — 「#24는 오탈자였는」"
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert result == content
            assert promoted_ids == set()
    finally:
        await engine.dispose()


async def test_promote_skips_blockquote_line():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "인용:\n> 예전에 #24라고 썼던\n지금은 아닌"
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert result == content
            assert promoted_ids == set()
    finally:
        await engine.dispose()


async def test_promote_bare_ref_outside_quotes_still_promotes_no_regression():
    """따옴표 밖의 정상 참조는 회귀 0 — 보호구간 확장이 정상 승격까지 죽이지 않는다."""
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = '"예시"는 무시하고 #24 보드 확인 부탁하는'
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content=content,
            )
            assert promoted_ids == {story.id}
            assert "#24" not in result
    finally:
        await engine.dispose()


# ── ③ 실 DB resolve ────────────────────────────────────────────────────────────
async def test_promote_resolves_existing_story_to_entity_token():
    from app.services.story_ref_promoter import promote_bare_story_refs
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content="확인은 #24 참고",
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result == f"확인은 {expected_token} 참고"
            # story #2679: 실제 치환된 story_id 집합도 반환 — caller가 origin='auto' 판정에 씀.
            assert promoted_ids == {story.id}
    finally:
        await engine.dispose()


async def test_promote_unresolved_number_kept_verbatim():
    """resolve 실패(그 번호 story 없음) — 그 매치만 원문 유지, all-or-nothing 아님."""
    from app.services.story_ref_promoter import promote_bare_story_refs
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content="#24 그리고 #9999",
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result == f"{expected_token} 그리고 #9999"
            # #9999는 resolve 실패라 promoted_ids엔 안 들어간다(원문 그대로 남은 것과 대칭).
            assert promoted_ids == {story.id}
    finally:
        await engine.dispose()


async def test_promote_scoped_to_project_cross_project_not_resolved():
    """같은 org 다른 project의 동일 story_number는 resolve 안 됨(스코프 경계)."""
    from app.models.project import Project
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            other_project = Project(id=uuid.uuid4(), org_id=org.id, name="Other")
            s.add(other_project)
            await s.commit()
            await _seed_story(s, org.id, other_project.id, number=24, title="다른 프로젝트 스토리")

            result, promoted_ids = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content="#24 참고",
            )
            assert result == "#24 참고"  # 다른 project 소속이라 미승격
            assert promoted_ids == set()
    finally:
        await engine.dispose()


# ── ④ send_message() 전체 경로 — agent/human 양쪽 동형(AC3) ─────────────────────
async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2629", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org, project


async def _seed_story(session, org_id, project_id, *, number, title):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", story_number=number,
    )
    session.add(story)
    await session.commit()
    return story


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name=name))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted"))
    await session.commit()
    return member_id


async def _seed_human(session, org_id, project_id):
    """team_members는 실 migrated DB에선 VIEW(members ⋈ project_access, migration 0088)라
    직접 INSERT 불가 — anchor 경로(Member+ProjectAccess.org_member_id)로 시드한다
    (test_1994_backlink_api_realdb.py::_make_human_member와 동형 패턴)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="Human"))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=om.id,
        permission="granted", role="member",
    ))
    await session.commit()
    return user_id


async def _seed_conversation(session, org_id, project_id, member_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title="Test", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


def _agent_auth(agent_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
    )


def _human_auth(user_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="human@test.com",
        claims={"app_metadata": {"org_id": str(org_id)}},
    )


async def test_send_message_promotes_bare_ref_for_agent_sender():
    from fastapi import BackgroundTasks
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="확인은 #24 참고"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result["data"]["content"] == f"확인은 {expected_token} 참고"
    finally:
        await engine.dispose()


async def test_send_message_promotes_bare_ref_for_human_sender():
    """AC3 — 사람 발신 메시지도 동형 동작(발신자 타입 무관)."""
    from fastapi import BackgroundTasks
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            user_id = await _seed_human(s, org.id, project.id)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            conv_id = await _seed_conversation(s, org.id, project.id, [user_id], created_by=user_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="확인은 #24 참고"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_human_auth(user_id, org.id), org_id=org.id,
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result["data"]["content"] == f"확인은 {expected_token} 참고"
    finally:
        await engine.dispose()


async def test_send_message_pr_prefixed_number_not_promoted_no_false_reference():
    """story #2651 AC1/AC3 — 「PR #N」은 승격되지 않고, 그 결과 거짓 참조도 references
    적재 레벨에서 0건이다(실피해 재현: 무관 스토리에 backlink가 실제로 꽂혔던 사고)."""
    from fastapi import BackgroundTasks
    from app.models.reference import Reference
    from app.routers.conversations import SendMessageRequest, send_message
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            story = await _seed_story(s, org.id, project.id, number=24, title="무관 구스토리")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="PR #24 리뷰 완료"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )
            # AC1: 본문이 원문 그대로 저장(entity 토큰으로 안 바뀜)
            assert result["data"]["content"] == "PR #24 리뷰 완료"

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id,
                    Reference.source_id == uuid.UUID(result["data"]["id"]),
                    Reference.target_type == "story",
                    Reference.target_id == story.id,
                )
            )).scalars().all()
            # AC3: 무관 스토리를 향한 거짓 참조가 적재되지 않았다
            assert rows == []
    finally:
        await engine.dispose()


async def test_send_message_repo_name_hash_not_promoted_no_false_reference():
    """story #2660 AC1/AC3 — 「repo-name#N」(예: agent-plugins#25)은 승격되지 않고,
    거짓 참조도 references 적재 레벨에서 0건이다(실피해 재현: 카디르 발신 메시지가
    무관 스토리 3d740d8f/d99d4c20으로 오승격됐던 사고)."""
    from fastapi import BackgroundTasks
    from app.models.reference import Reference
    from app.routers.conversations import SendMessageRequest, send_message
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            story = await _seed_story(s, org.id, project.id, number=25, title="무관 구스토리")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="agent-plugins#25 QA 확인 바라는"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )
            assert result["data"]["content"] == "agent-plugins#25 QA 확인 바라는"

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id,
                    Reference.source_id == uuid.UUID(result["data"]["id"]),
                    Reference.target_type == "story",
                    Reference.target_id == story.id,
                )
            )).scalars().all()
            assert rows == []
    finally:
        await engine.dispose()


async def test_send_message_no_bare_ref_unaffected():
    """무회귀 — 매치할 게 없으면 content가 그대로 저장된다."""
    from fastapi import BackgroundTasks
    from app.routers.conversations import SendMessageRequest, send_message

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="그냥 평문 메시지"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )
            assert result["data"]["content"] == "그냥 평문 메시지"
    finally:
        await engine.dispose()
