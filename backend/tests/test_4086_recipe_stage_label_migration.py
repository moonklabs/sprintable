"""story #4086(E-RECIPE-1, 유나 design 실측 2026-09-21) — AC3 pin.

0385 마이그(``0385_recipe_video_production_stage_label_resolve.py``)는
``event_definitions.block_template``(순수 렌더 템플릿)만 UPDATE한다. 이 테스트는 그
docstring이 주장하는 "``get_recipe_start_candidates``는 block_template을 안 읽는다"는
구조적 근거를 실측으로 pin한다 — grep(코드에 ``block_template`` 참조 0건)만으로는
"우연히 안 읽는다"와 "구조적으로 못 읽는다"를 구분 못 하므로, 실제로 block_template을
NEW→OLD로 되돌린 뒤 같은 호출의 응답이 byte-identical한지 직접 비교한다.

뮤테이션 pin: 만약 ``get_recipe_start_candidates``(또는 그 하위 ``_find_existing_stage_
publish``/``_find_latest_stage_publish``)가 나중에 block_template을 읽게 개조되면, 이
테스트의 A/B 응답이 달라져 RED가 된다."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

_KEY = "preset.marketing.video_production"

ORG = uuid.UUID("40860000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("40860000-0000-0000-0000-0000000000c1")
STORY_ID = uuid.UUID("40860000-0000-0000-0000-0000000000d1")
CONV = uuid.UUID("40860000-0000-0000-0000-0000000000e1")

_OLD_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "영상 제작 레시피"},
        {"type": "text", "text": "**{{payload.stage}}** 로 넘어갔습니다"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_type}} {{payload.work_item_id}}"},
        ]},
    ],
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> uuid.UUID:
    """org(owner 1)/project/RecipeRoleBinding(draft stage)/이미 draft 발행된 conversation
    메시지 1건 — role_bound·started·current_stage/next_stage/role 전부 채워진 실제 응답을
    끌어내(빈 후보 리스트가 아니라) block_template 토글이 정말 무해한지 넓게 확認한다."""
    for sql in [
        f"DELETE FROM recipe_role_bindings WHERE org_id='{ORG}'",
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM stories WHERE id='{STORY_ID}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE id='{PROJ}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S4086','s4086-org','free')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s4086-proj','warn')",
        f"INSERT INTO conversations (id,org_id,project_id,type,status) VALUES "
        f"('{CONV}','{ORG}','{PROJ}','group','open')",
    ]:
        await s.execute(text(sql))

    await s.execute(text(
        "INSERT INTO org_members (id, org_id, user_id, role) VALUES "
        "(gen_random_uuid(), :org, gen_random_uuid(), 'owner')"
    ), {"org": ORG})
    user_id = (await s.execute(text(
        "SELECT user_id FROM org_members WHERE org_id = :org AND role = 'owner' LIMIT 1"
    ), {"org": ORG})).scalar_one()

    await s.execute(text(
        "INSERT INTO recipe_role_bindings "
        "(id, org_id, project_id, event_definition_key, stage, agent_member_id) "
        "VALUES (gen_random_uuid(), :org, :proj, :key, 'draft', gen_random_uuid())"
    ), {"org": ORG, "proj": PROJ, "key": _KEY})

    await s.execute(text(
        "INSERT INTO conversation_messages (id, conversation_id, content, mentioned_ids, "
        "reply_count, created_at, metadata, attachments) VALUES ("
        "gen_random_uuid(), :conv, 'draft published', ARRAY[]::uuid[], 0, now(), "
        "jsonb_build_object('event', jsonb_build_object("
        "  'event_key', CAST(:key AS text),"
        "  'payload', jsonb_build_object("
        "    'work_item_type', 'story', 'work_item_id', CAST(:wid AS text), 'stage', 'draft'"
        "  )"
        ")), '[]'::jsonb"
        ")"
    ), {"conv": CONV, "key": _KEY, "wid": str(STORY_ID)})
    await s.commit()
    return user_id


def _to_plain(resp) -> dict:
    return resp.model_dump(mode="json")


@pytest.mark.anyio
async def test_start_candidates_response_unaffected_by_block_template_rewrite():
    """⭐⭐AC3 핵심 pin — block_template을 0385(NEW, {{label.*}})↔0381(OLD, {{payload.*}})
    로 직접 되돌려가며 같은 조회(get_recipe_start_candidates)의 응답을 비교한다. 이 DB는
    이미 alembic head(0385 적용 완료) 상태다."""
    from app.dependencies.auth import AuthContext
    from app.routers.events import get_recipe_start_candidates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            user_id = await _seed(s)
            auth = AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))

            row_before = (await s.execute(text(
                "SELECT block_template->'blocks'->1->>'text' FROM event_definitions "
                "WHERE key=:key AND org_id IS NULL"
            ), {"key": _KEY})).scalar_one()
            assert "{{label.stage}}" in row_before, (
                f"이 DB가 alembic head(0385 적용)가 아닌 것으로 의심 — 실측값: {row_before!r}"
            )
            # ⭐PO CHANGES pin(PR #4463 코멘트 5756079751) — 조사 「로」가 라벨에 직접
            # 붙으면 받침 있는 라벨(초안·확정 등)에서 틀린다. 「단계로」 고정 접미어(받침
            # 없는 "계" 뒤 결합이라 항상 맞음)로 우회했는지 실측.
            assert "{{label.stage}}** 단계로" in row_before, (
                f"조사 결합 우회(「단계로」 고정 접미어)가 없음 — 실측값: {row_before!r}"
            )

            response_new_template = await get_recipe_start_candidates(
                project_id=PROJ, work_item_type="story", work_item_id=STORY_ID,
                db=s, auth=auth, org_id=ORG,
            )

            import json as _json
            await s.execute(text(
                "UPDATE event_definitions SET block_template = :bt, version = version - 1 "
                "WHERE key = :key AND org_id IS NULL"
            ), {"bt": _json.dumps(_OLD_BLOCK_TEMPLATE), "key": _KEY})
            await s.commit()

            response_old_template = await get_recipe_start_candidates(
                project_id=PROJ, work_item_type="story", work_item_id=STORY_ID,
                db=s, auth=auth, org_id=ORG,
            )

            # 되돌리기 — 이 throwaway DB가 다음 테스트에서도 head 상태 전제를 유지하게.
            await s.execute(text(
                "UPDATE event_definitions SET block_template = :bt, version = version + 1 "
                "WHERE key = :key AND org_id IS NULL"
            ), {"bt": _json.dumps({
                "blocks": [
                    {"type": "header", "text": "영상 제작 레시피"},
                    # 유나 design CHANGES(PR #4463 코멘트 5756079751) — 조사 「로」 결합
                    # 오류 처방으로 "단계로" 고정 접미어(migration _NEW_BLOCK_TEMPLATE과
                    # 동일 텍스트 유지).
                    {"type": "text", "text": "**{{label.stage}}** 단계로 넘어갔습니다"},
                    {"type": "fields", "fields": [
                        {"label": "대상", "value": "{{label.work_item_target}}"},
                    ]},
                ],
            }), "key": _KEY})
            await s.commit()

        assert len(response_new_template.candidates) == 1, "후보 1건 시드했는데 안 잡힘 — seed 확認"
        plain_before = _to_plain(response_new_template)
        plain_after = _to_plain(response_old_template)
        assert plain_before == plain_after, (
            "block_template을 되돌렸는데 get_recipe_start_candidates 응답이 달라짐 — "
            "AC3(block_template 변경이 RecipeRoleBinding/start-candidates에 무관하다는 구조적 "
            "근거)가 깨짐.\n"
            f"NEW-template 응답: {plain_before}\nOLD-template 응답: {plain_after}"
        )
        c = response_new_template.candidates[0]
        assert c.role_bound is True
        assert c.started is True
        assert c.current_stage == "draft"
        assert c.current_role == "Creator"
        assert c.next_stage == "concept_confirmed"
    finally:
        await eng.dispose()
