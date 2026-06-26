"""E-STORAGE-SSOT S2 — asset registry real-DB(0139 적용 DB 전제).

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡 env에서 실행/로컬 PG.
커버: SAVE-time sync(AC1)·idempotent·reconcile·external skip·source_type 다형(AC6)·
list scope IDOR(AC2/D3 HARD)·legacy backfill(AC3).
"""
from __future__ import annotations

import importlib.util
import json
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
_SYNC = _RAW.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
    "postgresql://", "postgresql+psycopg2://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("a2000000-0000-0000-0000-000000000001")
USER = uuid.UUID("a2000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("a2000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("a2000000-0000-0000-0000-0000000000c1")
PROJ_B = uuid.UUID("a2000000-0000-0000-0000-0000000000c2")
BUCKET = "sprintable-memo-attachments"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _reset_and_seed(session):
    # 멱등 클린업 후 org/projects/user/grant 시드. assets/asset_links 는 본 org 범위만 정리.
    for sql in [
        f"DELETE FROM asset_links WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A2','a2org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{USER}','u@a2.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        # USER 는 PROJ_A 에만 grant(PROJ_B 접근 없음 — IDOR 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await session.execute(text(sql))
    await session.commit()


def _att(path, name="a.png", ctype="image/png", size=10):
    return {"url": path, "name": name, "content_type": ctype, "size": size}


@pytest.mark.anyio
async def test_sync_creates_asset_and_link_idempotent_reconcile():
    from app.services.asset_registry import sync_attachment_assets

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            src = uuid.uuid4()
            base = f"story/{PROJ_A}/{src}"  # 이 story 귀속 스코프(까심#2)
            # 1) create: bare + GCS-prefixed + 외부(skip) + 타-source 경로(skip) 혼합
            ids = await sync_attachment_assets(
                s, org_id=ORG, project_id=PROJ_A, source_type="story", source_id=src,
                attachments=[
                    _att(f"{base}/u-a.png"),
                    _att(f"https://storage.googleapis.com/{BUCKET}/{base}/u-b.png", name="b.png"),
                    _att("https://evil.example/x.png", name="ext.png"),  # 외부 → skip
                    _att(f"story/{PROJ_B}/{uuid.uuid4()}/u-c.png", name="c.png"),  # 타 story/project → skip(#2)
                ],
            )
            await s.commit()
            assert len(ids) == 2  # 외부 1 + 타-source 1 제외
            cnt = (await s.execute(text(
                f"SELECT count(*) FROM asset_links WHERE source_type='story' AND source_id='{src}'"
            ))).scalar_one()
            assert cnt == 2
            # source_type 다형 CHECK 유효(AC6)
            st = (await s.execute(text(
                f"SELECT DISTINCT source_type FROM asset_links WHERE source_id='{src}'"
            ))).scalar_one()
            assert st == "story"

            # 2) idempotent: 같은 첨부 재동기화 → row 증가 0
            await sync_attachment_assets(
                s, org_id=ORG, project_id=PROJ_A, source_type="story", source_id=src,
                attachments=[_att(f"{base}/u-a.png"), _att(f"https://storage.googleapis.com/{BUCKET}/{base}/u-b.png", name="b.png")],
            )
            await s.commit()
            cnt2 = (await s.execute(text(
                f"SELECT count(*) FROM asset_links WHERE source_id='{src}'"
            ))).scalar_one()
            assert cnt2 == 2

            # 3) reconcile: 첨부 하나로 교체 → 나머지 link 제거(SSOT 정확)
            await sync_attachment_assets(
                s, org_id=ORG, project_id=PROJ_A, source_type="story", source_id=src,
                attachments=[_att(f"{base}/u-a.png")],
            )
            await s.commit()
            cnt3 = (await s.execute(text(
                f"SELECT count(*) FROM asset_links WHERE source_id='{src}'"
            ))).scalar_one()
            assert cnt3 == 1

            # 4) 전체 제거 → link 0
            await sync_attachment_assets(
                s, org_id=ORG, project_id=PROJ_A, source_type="story", source_id=src, attachments=[],
            )
            await s.commit()
            cnt4 = (await s.execute(text(
                f"SELECT count(*) FROM asset_links WHERE source_id='{src}'"
            ))).scalar_one()
            assert cnt4 == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_assets_scope_idor():
    from app.dependencies.auth import AuthContext
    from app.routers.assets import list_assets
    from app.services.asset_registry import sync_attachment_assets

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            # A 프로젝트 asset, B 프로젝트 asset, org-level(NULL) asset
            await sync_attachment_assets(s, org_id=ORG, project_id=PROJ_A, source_type="manual",
                                         source_id=uuid.uuid4(), attachments=[_att("a/x.png")])
            await sync_attachment_assets(s, org_id=ORG, project_id=PROJ_B, source_type="manual",
                                         source_id=uuid.uuid4(), attachments=[_att("b/x.png")])
            await sync_attachment_assets(s, org_id=ORG, project_id=None, source_type="manual",
                                         source_id=uuid.uuid4(), attachments=[_att("org/x.png")])
            await s.commit()

            auth = AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))

            async def _paths(**kw):
                page = await list_assets(project_id=kw.get("project_id"), folder_id=None, mime=None,
                                         q=None, sort="date", order="desc", cursor=None, limit=200,
                                         db=s, auth=auth, org_id=ORG)
                return {r.object_path for r in page.items}

            # project 미지정 → 접근 가능(A) + org-level만. B 미노출(IDOR 차단).
            paths = await _paths(project_id=None)
            assert "a/x.png" in paths
            assert "org/x.png" in paths
            assert "b/x.png" not in paths  # 접근권 없는 project asset 0 노출

            # project_id=A → 접근 OK, A asset만
            assert await _paths(project_id=PROJ_A) == {"a/x.png"}

            # project_id=B → 접근권 없음 → 403(IDOR)
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as ei:
                await _paths(project_id=PROJ_B)
            assert ei.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_assets_enrich_and_cursor():
    """S5 계약: source_links(story title+deeplink)·created_by enrich·cursor 페이지네이션."""
    from app.dependencies.auth import AuthContext
    from app.routers.assets import list_assets, list_folders
    from app.services.asset_registry import sync_attachment_assets

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            story_id = uuid.uuid4()
            await s.execute(text(
                f"INSERT INTO stories (id,org_id,project_id,title,status,priority) "
                f"VALUES ('{story_id}','{ORG}','{PROJ_A}','My Story','backlog','medium')"
            ))
            await s.commit()
            base = f"story/{PROJ_A}/{story_id}"
            await sync_attachment_assets(s, org_id=ORG, project_id=PROJ_A, source_type="story",
                                         source_id=story_id, attachments=[_att(f"{base}/u-a.png")])
            await s.commit()

            auth = AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))
            page = await list_assets(project_id=PROJ_A, folder_id=None, mime=None, q=None,
                                     sort="date", order="desc", cursor=None, limit=50,
                                     db=s, auth=auth, org_id=ORG)
            assert len(page.items) == 1
            sl = page.items[0].source_links
            assert len(sl) == 1
            assert sl[0].type == "story" and sl[0].title == "My Story"
            assert sl[0].deeplink == {"story_id": str(story_id)}

            # cursor: limit=1 두 자산서 페이지 경계 동작
            await sync_attachment_assets(s, org_id=ORG, project_id=PROJ_A, source_type="story",
                                         source_id=story_id, attachments=[_att(f"{base}/u-a.png"), _att(f"{base}/u-b.png")])
            await s.commit()
            p1 = await list_assets(project_id=PROJ_A, folder_id=None, mime=None, q=None,
                                   sort="name", order="asc", cursor=None, limit=1,
                                   db=s, auth=auth, org_id=ORG)
            assert len(p1.items) == 1 and p1.next_cursor
            p2 = await list_assets(project_id=PROJ_A, folder_id=None, mime=None, q=None,
                                   sort="name", order="asc", cursor=p1.next_cursor, limit=1,
                                   db=s, auth=auth, org_id=ORG)
            assert len(p2.items) == 1
            assert p1.items[0].id != p2.items[0].id  # 커서가 다음 페이지로 진행

            # folders endpoint scope(빈 결과여도 200·접근권 가드)
            folders = await list_folders(project_id=PROJ_A, db=s, auth=auth, org_id=ORG)
            assert isinstance(folders, list)
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as ei:
                await list_folders(project_id=PROJ_B, db=s, auth=auth, org_id=ORG)
            assert ei.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_same_path_isolated_no_dangling_link():
    """같은 object_path 를 두 org 에서 등록 → org 별 별도 asset row + org-정합 link(까심#1 blocker).

    전역 UNIQUE 였다면 2번째 org save 가 1번째 org asset_id 에 conflict→매핑되어 cross-org
    dangling link(al.org_id <> a.org_id) 발생. org-scoped 키로 0 임을 실증.
    """
    from app.services.asset_registry import sync_attachment_assets

    ORG2 = uuid.UUID("a2000000-0000-0000-0000-000000000002")
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            for sql in [
                f"DELETE FROM asset_links WHERE org_id='{ORG2}'",
                f"DELETE FROM assets WHERE org_id='{ORG2}'",
                f"DELETE FROM organizations WHERE id='{ORG2}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG2}','A2b','a2borg','free')",
            ]:
                await s.execute(text(sql))
            await s.commit()

            shared = "manual/shared/same-path.png"  # manual=경로 제약 없음(#2). 양 org 동일 경로.
            await sync_attachment_assets(s, org_id=ORG, project_id=None, source_type="manual",
                                         source_id=uuid.uuid4(), attachments=[_att(shared)])
            await sync_attachment_assets(s, org_id=ORG2, project_id=None, source_type="manual",
                                         source_id=uuid.uuid4(), attachments=[_att(shared)])
            await s.commit()

            n_assets = (await s.execute(text(
                f"SELECT count(*) FROM assets WHERE object_path='{shared}' AND org_id IN ('{ORG}','{ORG2}')"
            ))).scalar_one()
            assert n_assets == 2  # org 별 별도 row

            dangling = (await s.execute(text(
                "SELECT count(*) FROM asset_links al JOIN assets a ON a.id=al.asset_id "
                "WHERE al.org_id <> a.org_id"
            ))).scalar_one()
            assert dangling == 0  # cross-org dangling link 0(SSOT 정합)

            await s.execute(text(f"DELETE FROM asset_links WHERE org_id='{ORG2}'"))
            await s.execute(text(f"DELETE FROM assets WHERE org_id='{ORG2}'"))
            await s.execute(text(f"DELETE FROM organizations WHERE id='{ORG2}'"))
            await s.commit()
    finally:
        await engine.dispose()


def test_backfill_legacy_attachments_idempotent():
    """legacy conversation_messages 첨부 → migration _backfill 멱등 편입(AC3). sync 엔진."""
    # 0139 마이그 모듈 로드(_backfill).
    mig_path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0139_add_asset_registry.py"
    spec = importlib.util.spec_from_file_location("mig_0139", mig_path)
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)

    conv = uuid.uuid4()
    msg = uuid.uuid4()
    engine = create_engine(_SYNC)
    try:
        with engine.begin() as conn:
            # 멱등 클린업 + org/project/conversation/message(첨부) 시드
            conn.execute(text(f"DELETE FROM asset_links WHERE org_id='{ORG}'"))
            conn.execute(text(f"DELETE FROM assets WHERE org_id='{ORG}'"))
            conn.execute(text(f"DELETE FROM conversation_messages WHERE id='{msg}'"))
            conn.execute(text(f"DELETE FROM conversations WHERE id='{conv}'"))
            conn.execute(text(f"DELETE FROM projects WHERE id='{PROJ_A}'"))
            conn.execute(text(f"DELETE FROM organizations WHERE id='{ORG}'"))
            conn.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A2','a2org','free')"))
            conn.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')"))
            conn.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type,status) "
                f"VALUES ('{conv}','{ORG}','{PROJ_A}','group','open')"
            ))
            att_json = json.dumps([
                # 이 conversation 귀속 경로(까심#2 scope) + size 비숫자 오염(까심#3 안전캐스팅)
                {"url": f"chat/{PROJ_A}/{conv}/u-a.png", "name": "a.png", "content_type": "image/png", "size": "12 bytes"},
                {"url": "https://evil.example/x.png", "name": "ext", "content_type": "image/png", "size": 1},
                {"url": f"chat/{PROJ_A}/{uuid.uuid4()}/u-z.png", "name": "z", "content_type": "image/png", "size": 1},
            ])
            # ⚠️ JSON 리터럴의 `:3` 등이 text() bind 로 오인되므로 반드시 bound param + CAST(jsonb).
            conn.execute(
                text(
                    "INSERT INTO conversation_messages "
                    "(id,conversation_id,content,mentioned_ids,reply_count,attachments) "
                    "VALUES (:id,:conv,'hi','{}',0, CAST(:att AS jsonb))"
                ),
                {"id": str(msg), "conv": str(conv), "att": att_json},
            )

        with engine.begin() as conn:
            mig._backfill(conn)
        with engine.begin() as conn:
            assets = conn.execute(text(f"SELECT count(*) FROM assets WHERE org_id='{ORG}'")).scalar_one()
            links = conn.execute(text(
                f"SELECT count(*) FROM asset_links WHERE source_type='conversation_message' AND source_id='{msg}'"
            )).scalar_one()
        assert assets == 1  # 외부 url 1건 제외
        assert links == 1

        # 멱등: 재실행 → 증가 0
        with engine.begin() as conn:
            mig._backfill(conn)
        with engine.begin() as conn:
            assets2 = conn.execute(text(f"SELECT count(*) FROM assets WHERE org_id='{ORG}'")).scalar_one()
            links2 = conn.execute(text(f"SELECT count(*) FROM asset_links WHERE source_id='{msg}'")).scalar_one()
        assert assets2 == 1 and links2 == 1
    finally:
        engine.dispose()
