"""story #2168 PR-② (유나·오르테가군 승인 2026-07-27): `GET /conversations/recent-outside-project`.

스펙 3축을 이 파일에서 고정한다:
  ① 정렬축 = caller 자신의 `ConversationParticipant.last_read_at` DESC(마지막 메시지 시각 아님 —
     크로스-프로젝트 목록에서 그건 "남이 더 떠든 방이 위로 오는" 소음이 된다는 게 스펙의 명시적
     금지 사유). 5개 캡, 넘치면 "오래 안 들어간 것부터" 잘림(=last_read_at 오름차순 쪽부터 드롭).
  ② 현재 프로젝트는 항상 제외.
  ③ 실패-자리 "수동 사라짐(권한 회수)=조용히 빠짐, 무알림"의 BE 축 — participant 원시 행이
     남아 있어도 project_access가 회수됐으면(=project_access 레코드 부재, grant 모델) 이 목록
     자체가 그 대화를 담지 않는다(FE가 나중에 403으로 거르는 게 아니라 쿼리 시점에 이미 없음).

격리된 로컬 throwaway realdb에서 라우터 함수를 직접 호출한다(HTTP 무접촉) — #2198/#2206과 동일
관례.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2168000-0000-0000-0000-000000000001")
CALLER_USER = uuid.UUID("d2168000-0000-0000-0000-000000000002")

PROJ_CURRENT = uuid.UUID("d2168000-0000-0000-0000-000000000010")
PROJ_A = uuid.UUID("d2168000-0000-0000-0000-000000000011")
PROJ_B = uuid.UUID("d2168000-0000-0000-0000-000000000012")
PROJ_REVOKED = uuid.UUID("d2168000-0000-0000-0000-000000000013")

NOW = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(CALLER_USER), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM conversation_participants WHERE conversation_id IN "
        f"(SELECT id FROM conversations WHERE org_id='{ORG}')",
        f"DELETE FROM conversations WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN "
        f"(SELECT id FROM projects WHERE org_id='{ORG}')",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{CALLER_USER}','{OTHER_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_base(s) -> uuid.UUID:
    """org+caller(일반 member, owner/admin 아님)+4개 project. PROJ_A/PROJ_B는 grant 부여,
    PROJ_REVOKED는 의도적으로 grant 없음(=회수 상태). caller_om_id 반환."""
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2168-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{CALLER_USER}','caller@d2168.test','x','C',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ_CURRENT}','{ORG}','Current','d2168-current','warn'),"
        f"('{PROJ_A}','{ORG}','A','d2168-a','warn'),"
        f"('{PROJ_B}','{ORG}','B','d2168-b','warn'),"
        f"('{PROJ_REVOKED}','{ORG}','Revoked','d2168-revoked','warn')",
    ]:
        await s.execute(text(sql))
    om_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{CALLER_USER}','member') RETURNING id"
    ))).one()
    caller_om_id = om_row[0]
    # PROJ_CURRENT엔 grant 불필요(project_id != 필터로 애초에 결과 후보에서 배제).
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ_A}','{caller_om_id}','granted'),"
        f"(gen_random_uuid(),'{PROJ_B}','{caller_om_id}','granted')"
    ))
    # PROJ_REVOKED: grant row 자체가 없다 — "회수"를 project_access 부재로 표현(grant 모델).
    # ⚠️ team_members는 실 배포 스키마에서 VIEW(members ⋈ project_access UNION)라 여기서
    # 행을 만들지 않는다 — conversation_participants.member_id에는 FK 강제가 없다(baseline
    # schema.sql 확인됨: conversation_id FK만 존재). 로컬에서 `Base.metadata.create_all()`로
    # 세운 throwaway DB는 TeamMember 모델을 진짜 테이블로 만들어 이 자리에 FK가 생기지만,
    # 그건 create_all과 실 배포 스키마(뷰) 사이의 알려진 드리프트일 뿐(#2513 CI가 UNION
    # 뷰에 대한 DELETE로 실패한 것도 동일 원인) — 이 파일은 CI(실 baseline 스키마) 기준으로
    # 짜여 있으므로 team_members에 손대지 않는다. 로컬 재현은 create_all 대신 실 baseline
    # 스키마로 세운 DB가 필요하다.
    await s.commit()
    return caller_om_id


async def _add_conv(s, *, conv_id, project_id, caller_om_id, last_read_at):
    await s.execute(text(
        f"INSERT INTO conversations (id,org_id,project_id,type,title,status) VALUES "
        f"('{conv_id}','{ORG}','{project_id}','group','T-{conv_id}','open')"
    ))
    lra = f"'{last_read_at.isoformat()}'" if last_read_at is not None else "NULL"
    await s.execute(text(
        f"INSERT INTO conversation_participants (id,conversation_id,member_id,last_read_at) VALUES "
        f"(gen_random_uuid(),'{conv_id}','{caller_om_id}',{lra})"
    ))
    await s.commit()


OTHER_USER = uuid.UUID("d2168000-0000-0000-0000-000000000099")


async def _seed_other_org_member(s) -> uuid.UUID:
    """story #2972 — DM 상대역 org_member(별도 user). TeamMember 행은 안 만든다(_seed_base와
    동일 이유 — team_members는 실 배포 스키마에서 VIEW라 create_all 드리프트를 피한다)."""
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OTHER_USER}','other@d2168.test','x','Other Person',true,true,0,false,0)"
    ))
    om_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OTHER_USER}','member') RETURNING id"
    ))).one()
    await s.commit()
    return om_row[0]


async def _add_dm_conv(s, *, conv_id, project_id, caller_om_id, other_om_id, last_read_at):
    """story #2972 — DM 대화는 title=NULL(list_conversations 관례 그대로, 표시명은 참가자
    이름으로 클라 조립)로 심는다. group과 달리 참가자 2인(caller+other)."""
    await s.execute(text(
        f"INSERT INTO conversations (id,org_id,project_id,type,title,status) VALUES "
        f"('{conv_id}','{ORG}','{project_id}','dm',NULL,'open')"
    ))
    lra = f"'{last_read_at.isoformat()}'" if last_read_at is not None else "NULL"
    await s.execute(text(
        f"INSERT INTO conversation_participants (id,conversation_id,member_id,last_read_at) VALUES "
        f"(gen_random_uuid(),'{conv_id}','{caller_om_id}',{lra}),"
        f"(gen_random_uuid(),'{conv_id}','{other_om_id}',NULL)"
    ))
    await s.commit()


@pytest.mark.anyio
async def test_orders_by_own_last_read_at_desc_excludes_current_and_revoked():
    from app.routers.conversations import list_recent_conversations_outside_project
    eng, Session = await _engine()
    try:
        async with Session() as s:
            caller_om_id = await _seed_base(s)
            conv_current = uuid.uuid4()
            conv_a_recent = uuid.uuid4()
            conv_b_mid = uuid.uuid4()
            conv_a_old = uuid.uuid4()
            conv_revoked = uuid.uuid4()
            # 현재 프로젝트: last_read_at이 전부보다 최신이어도 제외돼야 함(②).
            await _add_conv(s, conv_id=conv_current, project_id=PROJ_CURRENT,
                             caller_om_id=caller_om_id, last_read_at=NOW - timedelta(minutes=10))
            await _add_conv(s, conv_id=conv_a_recent, project_id=PROJ_A,
                             caller_om_id=caller_om_id, last_read_at=NOW - timedelta(hours=1))
            await _add_conv(s, conv_id=conv_b_mid, project_id=PROJ_B,
                             caller_om_id=caller_om_id, last_read_at=NOW - timedelta(hours=3))
            await _add_conv(s, conv_id=conv_a_old, project_id=PROJ_A,
                             caller_om_id=caller_om_id, last_read_at=NOW - timedelta(hours=5))
            # 권한 회수: participant 행은 있지만 PROJ_REVOKED엔 project_access grant가 없다 —
            # last_read_at이 전부보다 최신이어도(=제일 "안 들어간지 얼마 안 된" 축) 빠져야 함(③).
            await _add_conv(s, conv_id=conv_revoked, project_id=PROJ_REVOKED,
                             caller_om_id=caller_om_id, last_read_at=NOW - timedelta(minutes=30))
        async with Session() as s:
            out = await list_recent_conversations_outside_project(
                project_id=PROJ_CURRENT, limit=5, db=s, auth=_auth(), org_id=ORG,
            )
        ids = [row["id"] for row in out["data"]]
        assert ids == [str(conv_a_recent), str(conv_b_mid), str(conv_a_old)], ids
        assert str(conv_current) not in ids, "현재 프로젝트 대화가 새면 안 됨"
        assert str(conv_revoked) not in ids, "권한 회수된 프로젝트 대화가 새면 안 됨(③ 조용히 빠짐)"
        # ③ 프로젝트명 병기(스펙③) 확인.
        assert out["data"][0]["project_name"] == "A"
        assert out["data"][1]["project_name"] == "B"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_caps_at_limit_dropping_least_recently_read():
    """①"5개, 넘치면 오래 안 들어간 것부터" — 6개 접근가능 대화 중 last_read_at 최신 5개만."""
    from app.routers.conversations import list_recent_conversations_outside_project
    eng, Session = await _engine()
    try:
        async with Session() as s:
            caller_om_id = await _seed_base(s)
            conv_ids = [uuid.uuid4() for _ in range(6)]
            for i, cid in enumerate(conv_ids):
                await _add_conv(
                    s, conv_id=cid, project_id=(PROJ_A if i % 2 == 0 else PROJ_B),
                    caller_om_id=caller_om_id, last_read_at=NOW - timedelta(hours=i),
                )
        async with Session() as s:
            out = await list_recent_conversations_outside_project(
                project_id=PROJ_CURRENT, limit=5, db=s, auth=_auth(), org_id=ORG,
            )
        ids = [row["id"] for row in out["data"]]
        assert ids == [str(c) for c in conv_ids[:5]], ids
        assert str(conv_ids[5]) not in ids, "가장 오래 안 들어간(hours=5) 것부터 잘려야 함"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_dm_row_carries_participants_for_client_side_name_assembly():
    """story #2972 — DM 행(title=NULL)이 participants를 실어 내려줘야 FE가 상대 이름을 조립할
    재료가 생긴다(이전엔 participants가 아예 없어 "님과의 대화"라는 접미 조각만 노출되던 버그).
    group 행은 title이 있어 회귀 없음(스펙 그대로 유지) 확인도 같이 잰다."""
    from app.routers.conversations import list_recent_conversations_outside_project
    eng, Session = await _engine()
    try:
        async with Session() as s:
            caller_om_id = await _seed_base(s)
            other_om_id = await _seed_other_org_member(s)
            conv_dm = uuid.uuid4()
            conv_group = uuid.uuid4()
            await _add_dm_conv(
                s, conv_id=conv_dm, project_id=PROJ_A,
                caller_om_id=caller_om_id, other_om_id=other_om_id,
                last_read_at=NOW - timedelta(hours=1),
            )
            await _add_conv(
                s, conv_id=conv_group, project_id=PROJ_B,
                caller_om_id=caller_om_id, last_read_at=NOW - timedelta(hours=2),
            )
        async with Session() as s:
            out = await list_recent_conversations_outside_project(
                project_id=PROJ_CURRENT, limit=5, db=s, auth=_auth(), org_id=ORG,
            )
        by_id = {row["id"]: row for row in out["data"]}

        dm_row = by_id[str(conv_dm)]
        assert dm_row["title"] is None, "DM 행 title은 항상 NULL(list_conversations 관례)"
        dm_member_ids = {p["member_id"] for p in dm_row["participants"]}
        assert dm_member_ids == {str(caller_om_id), str(other_om_id)}
        other_p = next(p for p in dm_row["participants"] if p["member_id"] == str(other_om_id))
        assert other_p["name"], "상대 참가자 이름이 채워져야 FE가 «X님과의 대화»를 조립할 수 있음"
        assert other_p["name"] != str(other_om_id)[:8], "orphan fallback(8자 UUID)이 아니라 실명이어야 함"

        group_row = by_id[str(conv_group)]
        assert group_row["title"] == f"T-{conv_group}", "group 행 title 노출은 회귀 없음"
    finally:
        await eng.dispose()
