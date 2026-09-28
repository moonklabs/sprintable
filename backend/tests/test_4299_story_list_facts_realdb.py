"""story #4299 ① — 목록 붙이기 칸을 한 SQL로 읽는 `_attach_list_fields`가 예전 다섯 헬퍼(`_attach_assignee_ids` · `_attach_has_evidence` ·
`_attach_has_hypothesis_or_goal` · `_attach_org_project_slugs` · `_attach_trust_stage`)와 **같은 응답**을 내는지 실 PG에서 대조한다.

다섯 헬퍼는 단건 · 다른 라우트에서 그대로 쓰이므로 둘이 같이 산다(쌍둥이) — 조건은 필터 빌더를 같이 써서 갈리지 않게 했고, 이 테스트가
갈리는 순간을 잡는다. 시드는 칸마다 갈래를 하나씩 태운다:
- 담당: join 여러 줄(에이전트 · 사람 team_member · org_member만 · orphan · alias) 순서 · join 없이 assignee_id 폴백(에이전트 / 사람)
- evidence: 일반만 / gate_approval 둘(최신 고름) · 가설 링크
- trust: 사람 대기 게이트 · verify_fail · 미완 blocker vs 끝난 blocker(in-review · 진행 중 story에서 단계가 실제로 갈리게)
- scope_violation은 목록이 안 읽는다 — 그 전제(`derive_trust_stage`가 scope_violation을 안 본다)를 아래 테스트가 못박는다.
- 두 갈래 신원 해소(member_ssot_resolver_shadow 끔/켬) 모두.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _u() -> uuid.UUID:
    return uuid.uuid4()


async def _seed(s) -> dict:
    org, proj, user = _u(), _u(), _u()
    agent_a, agent_b, agent_c, human_m, om_only, orphan, alias_id = _u(), _u(), _u(), _u(), _u(), _u(), _u()
    s1, s2, s3, s4, s5, s6, blocker_open, blocker_done = _u(), _u(), _u(), _u(), _u(), _u(), _u(), _u()
    hyp = _u()
    sql = [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o-{org.hex[:12]}','free')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{proj}','{org}','P','p-{proj.hex[:12]}','warn')",
        (
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
            f"VALUES ('{user}','u{user.hex[:12]}@s4299.test','x','U',true,true,0,false,0)"
        ),
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{om_only}','{org}','{user}','member')",
        f"INSERT INTO members (id,org_id,type,name,user_id) VALUES ('{human_m}','{org}','human','H','{user}')",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{proj}','{human_m}','granted')",
    ]
    for a in (agent_a, agent_b, agent_c):
        sql.append(f"INSERT INTO members (id,org_id,type,name) VALUES ('{a}','{org}','agent','A{a.hex[:6]}')")
    for a in (agent_a, agent_b):  # agent_c는 profile 없음 → 레거시 team_members 뷰에 없다(앵커로만 alias를 통해 에이전트)
        sql.append(f"INSERT INTO agent_project_profiles (member_id,project_id) VALUES ('{a}','{proj}')")
    sql.append(f"INSERT INTO member_identity_aliases (alias_id,member_id,org_id,alias_source) VALUES ('{alias_id}','{agent_c}','{org}','test')")

    def story(sid, status, assignee=None, title=None, minutes=0):
        a = f"'{assignee}'" if assignee else "NULL"
        return (
            "INSERT INTO stories (id,org_id,project_id,title,status,priority,assignee_id,created_at) "
            f"VALUES ('{sid}','{org}','{proj}','{title or sid.hex[:6]}','{status}','medium',{a},now() - interval '{minutes} minutes')"
        )

    sql += [
        story(s1, "in-review", minutes=1), story(s2, "in-progress", agent_b, minutes=2), story(s3, "in-review", human_m, minutes=3),
        story(s4, "backlog", minutes=4), story(s5, "in-progress", minutes=5), story(s6, "in-review", minutes=8),
        story(blocker_open, "in-progress", minutes=6), story(blocker_done, "done", minutes=7),
    ]
    for i, mid in enumerate((agent_a, human_m, om_only, orphan)):
        sql.append(
            "INSERT INTO story_assignees (id,org_id,story_id,member_id,created_at) "
            f"VALUES (gen_random_uuid(),'{org}','{s1}','{mid}',now() - interval '{10 - i} minutes')"
        )
    sql.append(f"INSERT INTO story_assignees (id,org_id,story_id,member_id) VALUES (gen_random_uuid(),'{org}','{s5}','{alias_id}')")
    sql += [
        f"INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by) VALUES (gen_random_uuid(),'{org}','{s1}','story','pr','r1','{agent_a}')",
        f"INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by,created_at) VALUES (gen_random_uuid(),'{org}','{s1}','story','gate_approval','g1','{agent_a}',now() - interval '2 hours')",
        f"INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by,created_at) VALUES (gen_random_uuid(),'{org}','{s1}','story','gate_approval','g2','{human_m}',now() - interval '1 hours')",
        f"INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by) VALUES (gen_random_uuid(),'{org}','{s4}','story','url','r4','{agent_a}')",
        f"INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by) VALUES (gen_random_uuid(),'{org}','{s3}','story','gate_approval','g3','{human_m}')",
        f"INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by) VALUES (gen_random_uuid(),'{org}','{s6}','story','gate_approval','g6','{human_m}')",
        (
            "INSERT INTO hypotheses (id,org_id,project_id,owner_member_id,statement,metric_definition,measure_after,status) "
            f"VALUES ('{hyp}','{org}','{proj}','{human_m}','h','{{}}',now(),'active')"
        ),
        f"INSERT INTO hypothesis_story_links (id,hypothesis_id,story_id) VALUES (gen_random_uuid(),'{hyp}','{s3}')",
        (
            "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,neutral_facts,requires_human) "
            f"VALUES (gen_random_uuid(),'{org}','{s2}','story','merge','pending','{{}}',true)"
        ),
        (
            "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,neutral_facts,evidence_status,requires_human) "
            f"VALUES (gen_random_uuid(),'{org}','{s6}','story','merge','pending','{{}}','blocked',false)"
        ),
        f"INSERT INTO item_dependency (id,org_id,from_id,to_id,dep_type,item_type) VALUES (gen_random_uuid(),'{org}','{blocker_open}','{s3}','blocks','story')",
        f"INSERT INTO item_dependency (id,org_id,from_id,to_id,dep_type,item_type) VALUES (gen_random_uuid(),'{org}','{blocker_done}','{s4}','blocks','story')",
    ]

    def link(sid, n, source, conf, violated, minutes):  # 위반 링크가 있어도 목록 응답은 같아야 한다(안 읽으니)
        return (
            "INSERT INTO pull_request_story_link (id,org_id,story_id,repo_full_name,pr_number,link_source,confidence,evidence,updated_at) "
            f"VALUES (gen_random_uuid(),'{org}','{sid}','o/r{org.hex[:6]}',{n},'{source}','{conf}',"
            f"'{{\"scope_check\": {{\"violated\": {str(violated).lower()}}}}}',now() - interval '{minutes} minutes')"
        )

    sql += [
        link(s1, 1, "explicit", "high", True, 30), link(s1, 2, "explicit", "high", False, 5),  # 최신이 위반 아님 → 위반 없음
        link(s2, 3, "auto_match", "high", True, 5),                                            # 위반
        link(s3, 4, "auto_match", "low", True, 5),                                             # 낮은 신뢰 → 무시
    ]
    for q in sql:
        await s.execute(text(q))
    await s.commit()
    return {"org": org, "proj": proj, "ids": {"s1": s1, "s2": s2, "s3": s3, "s4": s4, "s5": s5, "s6": s6},
            "agent_a": agent_a, "agent_b": agent_b, "agent_c": agent_c, "alias_id": alias_id}


async def _dump(Session, org, proj, attach) -> dict:
    from app.repositories.story import StoryRepository
    from app.schemas.story import StoryResponse

    async with Session() as s:
        stories, _ = await StoryRepository(s, org).list(limit=100, project_id=proj)
        await attach(s, org, stories)
        return {st.id: StoryResponse.model_validate(st).model_dump(mode="json") for st in stories}


async def _old(session, org, stories):
    from app.routers.stories import (
        _attach_assignee_ids,
        _attach_has_evidence,
        _attach_has_hypothesis_or_goal,
        _attach_org_project_slugs,
        _attach_trust_stage,
    )

    await _attach_assignee_ids(session, org, stories)
    verified = await _attach_has_evidence(session, stories)
    await _attach_has_hypothesis_or_goal(session, stories)
    await _attach_org_project_slugs(session, org, stories)
    await _attach_trust_stage(session, org, stories, verified_map=verified)


async def _new(session, org, stories):
    from app.routers.stories import _attach_list_fields

    await _attach_list_fields(session, org, stories)


@pytest.mark.parametrize("anchor", [False, True], ids=["legacy-resolver", "anchor-resolver"])
async def test_one_statement_list_fields_match_the_five_helpers(monkeypatch, anchor):
    from app.core.config import settings

    monkeypatch.setattr(settings, "member_ssot_resolver_shadow", anchor)
    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with Session() as s:
            seeded = await _seed(s)
        old = await _dump(Session, seeded["org"], seeded["proj"], _old)
        new = await _dump(Session, seeded["org"], seeded["proj"], _new)
    finally:
        await eng.dispose()

    assert new == old
    ids = seeded["ids"]
    s1, s2, s3, s4, s5, s6 = (old[ids[k]] for k in ("s1", "s2", "s3", "s4", "s5", "s6"))
    # 시드가 칸마다 갈래를 실제로 태웠는지(값이 다 비면 둘이 «같다»가 헛돈다)
    assert s1["assignee_ids"][0] == str(seeded["agent_a"]) and len(s1["assignee_ids"]) == 4
    assert s1["agent_delegate_ids"] == [str(seeded["agent_a"])]
    assert s1["human_verified"] is True and s1["has_evidence"] is True
    assert s2["assignee_ids"] == [str(seeded["agent_b"])] and s2["agent_delegate_ids"] == [str(seeded["agent_b"])]
    assert s3["agent_delegate_ids"] == [] and s3["has_hypothesis_or_goal"] is True
    # trust 갈래: s1 in-review · 서명 · 막힘 없음 = merge_ready / s2 진행 중 · 사람 대기 게이트 = needs_input / s3 in-review · 서명 ·
    # 미완 blocker = verified / s6 in-review · 서명 · verify_fail = verified / s4 backlog = queued(끝난 blocker는 막힘 아님)
    assert (s1["trust_stage"], s2["trust_stage"], s3["trust_stage"], s6["trust_stage"], s4["trust_stage"]) == (
        "merge_ready", "needs_input", "verified", "verified", "queued")
    assert s4["has_evidence"] is True and s4.get("human_verified") in (None, False)
    # alias 담당: 앵커 갈래에서만 에이전트(레거시는 team_members 뷰에 그 id가 없어 human)
    assert s5["agent_delegate_ids"] == ([str(seeded["alias_id"])] if anchor else [])


def test_trust_stage_ignores_scope_violation():
    """목록 한 문장이 scope_violation을 안 읽는 전제 — derive_trust_stage가 이 칸을 보기 시작하면 RED(그땐 story_list_facts에 다시 넣을 것)."""
    import itertools

    from app.services.trust_pipeline import TrustFacts, derive_trust_stage

    statuses = ["backlog", "ready-for-dev", "in-progress", "in-review", "done", "estimated", "unknown"]
    for status, hv, pending, vf, blk in itertools.product(statuses, *([[False, True]] * 4)):
        base = {"status": status, "project_id": uuid.uuid4(), "human_verified": hv, "has_pending_human_gate": pending,
                "has_verify_fail": vf, "has_unresolved_blocker": blk}
        assert derive_trust_stage(TrustFacts(**base, has_scope_violation=False)) == derive_trust_stage(TrustFacts(**base, has_scope_violation=True))


async def test_list_total_is_the_filtered_count_not_the_page_length():
    """story #4299 ① — 전체 수를 따로 세던 count 문장을 같은 문장의 count(*) over()로 옮겼다. 전체 수 = LIMIT 전 걸러진 행 수
    (X-Total-Count · 미매달림 버킷 수의 원천): 페이지가 잘려도 전체, 커서로 거르면 커서 뒤만, 걸러진 게 없으면 0."""
    from app.repositories.story import StoryRepository

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            repo = StoryRepository(s, seeded["org"])
            page, total = await repo.list(limit=3, project_id=seeded["proj"])
            assert (len(page), total) == (3, 8)
            _, after_cursor = await repo.list(limit=3, project_id=seeded["proj"], cursor=page[-1].created_at)
            assert after_cursor == 5
            empty, zero = await repo.list(limit=3, project_id=seeded["proj"], q="no-such-title-4299")
            assert (empty, zero) == ([], 0)
    finally:
        await eng.dispose()
