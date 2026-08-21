"""story #2906(선생님 확定 2026-08-21) — storage quota 서버측 강제, 실PG 검증.

그라운딩 정정(스토리 본문 참고) — `ee/plan_limits.py::check_storage_capacity()`는 이미
존재·이미 4개 choke point(conversations.py·docs.py 문서저장·stories.py×2)에 wired돼
있었다. 이 PR의 실 작업은 ①진짜 미커버 갭 2곳(docs.py MCP 첨부·visual_artifacts export)
wiring ②SSOT를 `plan_tier_limits`(구 twin)에서 `offering_versions`(seats 선례와 동일
카탈로그)로 이관 ③기존 데이터 무변화 음성대조.

커버:
  AC① — docs.py MCP JSON/base64 첨부 엔드포인트, 쿼터 초과 시 402.
  AC② — visual_artifacts PNG export 완결 엔드포인트, 쿼터 초과 시 402.
  AC③(SSOT 이관, load-bearing) — offering_versions 값만 바꿔도 판정이 바뀜(plan_tier_limits
       가 여전히 구값이어도).
  AC④(페드루군 조건ⓐ) — 402 문구가 한국어로 현재 사용량/한도+행동 안내.
  AC⑤(페드루군 조건ⓑ, 음성대조) — 이미 쿼터 초과 상태 org의 기존 자산 접근/다운로드는
       무변화(차단 없음).
  AC⑥ — storage-usage-warn cron도 같은 SSOT(offering_versions)를 읽는다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

GB = 1024 * 1024 * 1024
MB = 1024 * 1024
BUCKET = "sprintable-memo-attachments"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _mock_storage_head(monkeypatch):
    """까심① — check_storage_capacity/sync_attachment_assets 둘 다 call-time import로
    storage provider를 가져온다(test_asset_registry_realdb.py와 동일 규율)."""
    from unittest.mock import AsyncMock, MagicMock

    import app.services.storage as _storage_mod

    sizes: dict[str, int] = {}

    async def _head(container, object_path):
        return sizes.get(object_path, 10)

    prov = MagicMock()
    prov.head_object = AsyncMock(side_effect=_head)

    async def _put(container, object_path, data, content_type=None):
        sizes[object_path] = len(data)
        return True

    prov.put_object = AsyncMock(side_effect=_put)
    prov.signed_write_url = AsyncMock(return_value="https://fake-signed-url.example/upload")
    monkeypatch.setattr(_storage_mod, "get_storage_provider", lambda: prov)
    yield sizes


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


async def _seed_org(session, *, tier="free", used_bytes=0):
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    project_id = uuid.uuid4()
    om_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id,name,slug,plan) VALUES (:id,:name,:slug,'free')"),
        {"id": org_id, "name": f"org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.execute(
        text(
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
            "login_fail_count,totp_enabled,totp_fail_count) VALUES "
            "(:id,:email,'x','U',true,true,0,false,0)"
        ),
        {"id": user_id, "email": f"u-{org_id}@test.local"},
    )
    await session.execute(
        text("INSERT INTO org_members (id,org_id,user_id,role) VALUES (:id,:org_id,:uid,'owner')"),
        {"id": om_id, "org_id": org_id, "uid": user_id},
    )
    await session.execute(
        text("INSERT INTO projects (id,org_id,name) VALUES (:id,:org_id,'P')"),
        {"id": project_id, "org_id": org_id},
    )
    await session.execute(
        text("INSERT INTO project_access (id,project_id,org_member_id,permission) VALUES (gen_random_uuid(),:p,:om,'granted')"),
        {"p": project_id, "om": om_id},
    )
    if tier != "free":
        await session.execute(
            text("INSERT INTO org_subscriptions (id,org_id,tier,status,currency,provider) VALUES (gen_random_uuid(),:o,:t,'active','krw','toss')"),
            {"o": org_id, "t": tier},
        )
    if used_bytes:
        await session.execute(
            text(
                "INSERT INTO assets (id,org_id,project_id,container,object_path,name,size_bytes,deleted_at)"
                " VALUES (gen_random_uuid(),:o,:p,:c,:path,'existing',:sz,NULL)"
            ),
            {"o": org_id, "p": project_id, "c": BUCKET, "path": f"pre-existing/{uuid.uuid4()}", "sz": used_bytes},
        )
    await session.commit()
    return {"org_id": org_id, "user_id": user_id, "project_id": project_id}


async def _get_offering_id(session, tier):
    row = (await session.execute(
        text("SELECT id FROM offering_versions WHERE tier=:t AND currency='krw' AND effective_to IS NULL"),
        {"t": tier},
    )).first()
    assert row is not None, f"offering_version(tier={tier!r}) 시드 없음"
    return row.id


@pytest.mark.anyio
async def test_ssot_migrated_to_offering_version_not_plan_tier_limits_realdb(_mock_storage_head):
    """AC③(load-bearing) — plan_tier_limits는 구값(5GB) 그대로 두고 offering_versions만
    1MB로 낮추면, check_storage_capacity가 새 값(1MB)을 따라야 한다(구 twin을 계속 읽고
    있었다면 5GB 여유로 통과했을 요청이, SSOT 이관 後엔 즉시 거부돼야 한다)."""
    from fastapi import HTTPException

    from ee.plan_limits import check_storage_capacity

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org(s, tier="free")
            offering_id = await _get_offering_id(s, "free")

            plan_tier_limit_mb = (await s.execute(
                text("SELECT max_storage_mb FROM plan_tier_limits WHERE tier='free'")
            )).scalar_one()
            assert plan_tier_limit_mb >= 5 * 1024, "구 twin이 여전히 5GB대여야 이 테스트가 의미 있음"

            # offering_versions.storage_mb_limit은 org별 행이 아니라 tier당 공유 카탈로그 행 —
            # CI가 전체 스위트를 하나의 공유 PG에 돌리므로(feedback_disposable_pg_reuse_pollution
            # 동형 클래스) 반드시 원복해야 다른 테스트(test_asset_registry_realdb.py 등)를
            # 오염시키지 않는다.
            original_limit_mb = (await s.execute(
                text("SELECT storage_mb_limit FROM offering_versions WHERE id=:id"), {"id": offering_id},
            )).scalar_one()
            try:
                await s.execute(
                    text("UPDATE offering_versions SET storage_mb_limit=1 WHERE id=:id"), {"id": offering_id},
                )
                await s.commit()

                url = f"org/{seeded['org_id']}/project/{seeded['project_id']}/chat/{uuid.uuid4()}/big.png"
                att = {"url": url, "name": "big.png", "content_type": "image/png", "size": 0}
                _mock_storage_head[url] = 2 * 1024 * 1024  # 2MB — head_object가 authoritative(까심①)

                with pytest.raises(HTTPException) as exc_info:
                    await check_storage_capacity(s, seeded["org_id"], [att])
                assert exc_info.value.status_code == 402
                # storage_mb_limit=1(offering_versions 새 한도) 초과 — max_file_mb는 안 건드렸으니
                # file_size가 아니라 총량(storage) 축에서 걸려야 SSOT가 실제로 이 필드를 읽었다는 증거.
                assert exc_info.value.detail["resource"] == "storage"
                assert exc_info.value.detail["limit_mb"] == 1
            finally:
                await s.execute(
                    text("UPDATE offering_versions SET storage_mb_limit=:mb WHERE id=:id"),
                    {"mb": original_limit_mb, "id": offering_id},
                )
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_storage_limit_error_korean_usage_and_action_realdb(_mock_storage_head):
    """AC④(페드루군 조건ⓐ) — 402 문구는 한국어로 현재 사용량/한도+행동(정리 or 업그레이드)을 명시."""
    from fastapi import HTTPException

    from ee.plan_limits import check_storage_capacity

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org(s, tier="free", used_bytes=5 * GB - 100)
            url = f"org/{seeded['org_id']}/project/{seeded['project_id']}/chat/{uuid.uuid4()}/f.png"
            _mock_storage_head[url] = 200  # 기존 사용량(5GB-100)+200 > 5GB 한도 — 확실히 초과.

            with pytest.raises(HTTPException) as exc_info:
                await check_storage_capacity(s, seeded["org_id"], [{"url": url, "name": "f", "content_type": "image/png", "size": 0}])
            msg = exc_info.value.detail["message"]
            assert any(ch >= "가" and ch <= "힣" for ch in msg), f"메일과 동일 규율 — 한국어 문구여야 함: {msg!r}"
            assert "한도" in msg
            assert ("정리" in msg) or ("업그레이드" in msg), "행동 안내(무엇을 하면 되는지)가 없음"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_over_quota_org_existing_asset_access_unaffected_realdb():
    """AC⑤(페드루군 조건ⓑ, 음성대조 필수) — 이미 쿼터 초과 상태 org라도 기존 자산 접근
    (list/read)은 무변화 — 「신규 업로드만 차단」의 반쪽. check_storage_capacity 자체가
    신규 첨부 없이는(no-op) 절대 호출되지 않는 경로(list/read엔 attachments 인자가 없다)
    임을 직접 실증한다."""
    from app.routers.assets import list_assets
    from unittest.mock import MagicMock

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org(s, tier="free", used_bytes=6 * GB)  # 이미 free 5GB 초과

            auth = MagicMock()
            auth.user_id = str(seeded["user_id"])
            # FastAPI Query(...) 기본값은 함수를 직접 호출하면 resolve 안 됨(Query 객체 그대로
            # 남는다) — 전부 명시로 넘겨야 실제 no-filter 조회와 동치가 된다.
            resp = await list_assets(
                project_id=None, folder_id=None, mime=None, q=None,
                sort="date", order="desc", cursor=None, limit=50,
                db=s, auth=auth, org_id=seeded["org_id"],
            )
            assert len(resp.items) == 1, "쿼터 초과 상태에서도 기존 자산은 그대로 조회됨(삭제·차단 없음)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_docs_mcp_attachment_upload_rejected_over_quota_realdb(monkeypatch):
    """AC① — docs.py MCP JSON/base64 첨부 엔드포인트(진짜 미커버 갭)가 쿼터 초과 시 402."""
    import base64

    from fastapi import HTTPException

    from app.core.config import settings
    from app.dependencies.auth import AuthContext
    from app.models.doc import Doc
    from app.routers.docs import UploadDocAttachmentRequest, upload_doc_attachment

    monkeypatch.setattr(settings, "license_consent", "agreed")  # is_ee_enabled 게이트 통과
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org(s, tier="free", used_bytes=5 * GB - 100)
            doc_id = uuid.uuid4()
            s.add(Doc(
                id=doc_id, org_id=seeded["org_id"], project_id=seeded["project_id"], title="D",
                slug=f"doc-{doc_id.hex[:8]}",
            ))
            await s.commit()

            auth = AuthContext(user_id=str(seeded["user_id"]), email=None, claims={})
            body = UploadDocAttachmentRequest(
                content_base64=base64.b64encode(b"x" * 300).decode(), name="big.bin", content_type="application/octet-stream",
            )
            # 200바이트 여유인데 300바이트 파일 → 총량 초과.
            with pytest.raises(HTTPException) as exc_info:
                await upload_doc_attachment(doc_id=doc_id, body=body, session=s, auth=auth, org_id=seeded["org_id"])
            assert exc_info.value.status_code == 402
            assert exc_info.value.detail["resource"] == "storage"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_visual_artifact_png_export_rejected_over_quota_realdb(monkeypatch):
    """AC② — visual_artifacts PNG export 완결 엔드포인트(별도 asset upsert 경로, 진짜
    미커버 갭)가 쿼터 초과 시 402."""
    from httpx import ASGITransport, AsyncClient

    from app.core.config import settings
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact
    from app.services.asset_registry import DEFAULT_CONTAINER
    from app.services.storage import get_storage_provider
    from tests.conftest import override_db_and_read

    monkeypatch.setattr(settings, "license_consent", "agreed")  # is_ee_enabled 게이트 통과
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org(s, tier="free", used_bytes=5 * GB - 100)
            # project는 _seed_org가 만들었지만 Project 모델 row 자체가 필요(visual_artifacts scope).
            proj = (await s.execute(text("SELECT id FROM projects WHERE id=:p"), {"p": seeded["project_id"]})).first()
            assert proj is not None

            creator = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="exporter", is_active=True)
            s.add(creator)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=seeded["project_id"], member_id=creator.id, permission="granted", role="member"))
            await s.commit()

            artifact = VisualArtifact(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"], title="Export",
                source="created", latest_version_number=1, created_by=creator.id,
            )
            s.add(artifact)
            await s.commit()
            version = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=creator.id)
            s.add(version)
            await s.commit()
            artifact_id, org_id, project_id = artifact.id, seeded["org_id"], seeded["project_id"]

        async def _db():
            async with Session() as s2:
                try:
                    yield s2
                    await s2.commit()
                except Exception:
                    await s2.rollback()
                    raise

        async def _auth():
            return AuthContext(
                user_id=str(creator.id), email=None,
                claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            url_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/versions/1/export/png/upload-url",
                json={"content_type": "image/png"},
            )
            assert url_resp.status_code == 200, url_resp.text
            object_path = url_resp.json()["data"]["object_path"]

            # 200바이트 여유인데 300바이트 "PNG" → 총량 초과 기대.
            put_ok = await get_storage_provider().put_object(
                DEFAULT_CONTAINER, object_path, b"\x89" * 300, content_type="image/png",
            )
            assert put_ok

            complete_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/versions/1/export/png/complete",
                json={"object_path": object_path},
            )
            assert complete_resp.status_code == 402, complete_resp.text
            assert complete_resp.json()["error"]["code"] == "PLAN_LIMIT_EXCEEDED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_storage_warn_cron_uses_offering_version_ssot_realdb(monkeypatch):
    """AC⑥ — storage-usage-warn cron도 offering_versions를 읽는다(check_storage_capacity와
    같은 소스로 통일 — «경고 임계≠거부 임계» split-brain 방지). plan_tier_limits는 구값
    (5GB) 그대로 두고 offering_versions만 낮추면, 훨씬 적은 사용량에서도 80% 경고가 떠야
    한다(구 twin을 계속 읽고 있었다면 안 떴을 것)."""
    from unittest.mock import MagicMock

    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org(s, tier="free", used_bytes=int(90 * MB))  # 5GB 기준 2%뿐
            # cron 대상은 org_subscriptions(status='active') 스캔 — free tier는 _seed_org가
            # 구독 행을 안 만든다(실 운영과 동형, _get_org_tier의 "행 없음=free" fallback과 짝).
            # 이 cron 자체는 애초에 구독 행 없는 free org는 안 본다(#2906 스코프 밖 기존 한계) —
            # 이 테스트는 «구독 행이 있는» free org에서 SSOT가 맞는지만 검증한다.
            await s.execute(
                text(
                    "INSERT INTO org_subscriptions (id,org_id,tier,status,currency,provider) "
                    "VALUES (gen_random_uuid(),:o,'free','active','krw','toss')"
                ),
                {"o": seeded["org_id"]},
            )
            await s.commit()
            offering_id = await _get_offering_id(s, "free")
            original_limit_mb = (await s.execute(
                text("SELECT storage_mb_limit FROM offering_versions WHERE id=:id"), {"id": offering_id},
            )).scalar_one()
            owner_email = (await s.execute(
                text("SELECT email FROM users WHERE id=:id"), {"id": seeded["user_id"]},
            )).scalar_one()
            try:
                # 100MB로 낮추면 90MB 사용은 90% — 80% 임계 초과.
                await s.execute(text("UPDATE offering_versions SET storage_mb_limit=100 WHERE id=:id"), {"id": offering_id})
                await s.commit()

                sent: list = []
                monkeypatch.setattr(cron, "send_email", lambda to, subject, html: sent.append(to) or True)

                await cron.storage_usage_warn(MagicMock(), session=s)
                # 전역 스캔(org_subscriptions 전체) — CI 공유 PG엔 다른 테스트의 active 구독이
                # 동시에 있을 수 있다(feedback_failure_triage_by_signature 동형: 정확한 길이가
                # 아니라 «이 org의 owner에게 갔는가»만 판별력 있다).
                assert owner_email in sent, "90MB/100MB(offering_versions 새 한도)=90% — 이 org 경고 떴어야 함"
            finally:
                await s.execute(
                    text("UPDATE offering_versions SET storage_mb_limit=:mb WHERE id=:id"),
                    {"mb": original_limit_mb, "id": offering_id},
                )
                await s.commit()
    finally:
        await engine.dispose()
