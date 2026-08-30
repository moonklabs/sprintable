"""story #2887(BE) — app/services/avatar_upload.py 순수 로직 검증. DB 불요(이 서비스는
세션을 받지 않는다 — object storage 계약만) — LocalStorageProvider(zero-config, 실 로컬
디스크)로 GCS 없이 head_object/delete_object/put_object 실물 검증.

핵심 축: ①content_type 화이트리스트 거부 ②confirm이 client-trust 없이 head_object 실물
크기로 상한(5MB) 판정 + 초과 시 객체 삭제(까심 ① 원칙, asset_registry.py와 동형) ③confirm의
object_path가 발급 스코프(org/member) 밖이면 거부(PATH_NOT_SCOPED) ④교체 시 구 blob 삭제
(페드루 조건ⓑ) ⑤미설정(GCS_AVATARS_BUCKET 없음) 시 503 fail-closed."""
from __future__ import annotations

import importlib
import os
import shutil
import tempfile
import uuid

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def avatar_service(monkeypatch):
    """매 테스트 격리된 STORAGE_LOCAL_ROOT + STORAGE_PROVIDER=local + GCS_AVATARS_BUCKET.
    avatar_upload.py는 모듈 로드 시점에 AVATARS_BUCKET을 read하므로 매 테스트 reload 필요."""
    tmp_root = tempfile.mkdtemp(prefix="avatar-test-")
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", tmp_root)
    monkeypatch.setenv("GCS_AVATARS_BUCKET", "test-avatars-bucket")
    import app.services.avatar_upload as mod
    importlib.reload(mod)
    yield mod
    shutil.rmtree(tmp_root, ignore_errors=True)


@pytest.fixture
def avatar_service_unconfigured(monkeypatch):
    monkeypatch.delenv("GCS_AVATARS_BUCKET", raising=False)
    import app.services.avatar_upload as mod
    importlib.reload(mod)
    yield mod


@pytest.mark.asyncio
async def test_create_upload_url_rejects_unsupported_content_type(avatar_service):
    with pytest.raises(avatar_service.AvatarUploadError) as exc_info:
        await avatar_service.create_upload_url(
            org_id=uuid.uuid4(), member_id=uuid.uuid4(), content_type="application/pdf",
        )
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "UNSUPPORTED_CONTENT_TYPE"


@pytest.mark.asyncio
async def test_create_upload_url_unconfigured_bucket_is_503(avatar_service_unconfigured):
    with pytest.raises(avatar_service_unconfigured.AvatarUploadError) as exc_info:
        await avatar_service_unconfigured.create_upload_url(
            org_id=uuid.uuid4(), member_id=uuid.uuid4(), content_type="image/png",
        )
    assert exc_info.value.status_code == 503
    assert exc_info.value.code == "AVATAR_UPLOAD_NOT_CONFIGURED"


@pytest.mark.asyncio
async def test_confirm_upload_rejects_when_object_not_uploaded(avatar_service):
    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    object_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
    with pytest.raises(avatar_service.AvatarUploadError) as exc_info:
        await avatar_service.confirm_upload(
            org_id=org_id, member_id=member_id, object_path=object_path, previous_avatar_url=None,
        )
    assert exc_info.value.status_code == 404
    assert exc_info.value.code == "OBJECT_NOT_FOUND"


@pytest.mark.asyncio
async def test_confirm_upload_rejects_path_not_scoped_to_member(avatar_service):
    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    other_member_id = uuid.uuid4()
    foreign_path = f"avatar/{org_id}/{other_member_id}/{uuid.uuid4().hex}.png"
    provider = avatar_service.get_storage_provider()
    await provider.put_object(avatar_service.AVATARS_BUCKET, foreign_path, b"x", content_type="image/png")

    with pytest.raises(avatar_service.AvatarUploadError) as exc_info:
        await avatar_service.confirm_upload(
            org_id=org_id, member_id=member_id, object_path=foreign_path, previous_avatar_url=None,
        )
    assert exc_info.value.status_code == 403
    assert exc_info.value.code == "PATH_NOT_SCOPED"


@pytest.mark.asyncio
async def test_confirm_upload_rejects_oversized_and_deletes_object(avatar_service):
    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    object_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
    provider = avatar_service.get_storage_provider()
    oversized = b"x" * (avatar_service.MAX_AVATAR_BYTES + 1)
    await provider.put_object(avatar_service.AVATARS_BUCKET, object_path, oversized, content_type="image/png")

    with pytest.raises(avatar_service.AvatarUploadError) as exc_info:
        await avatar_service.confirm_upload(
            org_id=org_id, member_id=member_id, object_path=object_path, previous_avatar_url=None,
        )
    assert exc_info.value.status_code == 413
    assert exc_info.value.code == "AVATAR_TOO_LARGE"

    # 상한 초과 객체는 client 재시도로 남지 않도록 confirm이 직접 삭제해야 한다.
    size_after = await provider.head_object(avatar_service.AVATARS_BUCKET, object_path)
    assert size_after is None, "상한 초과 avatar 객체가 confirm 실패 후에도 버킷에 남아있음"


@pytest.mark.asyncio
async def test_confirm_upload_succeeds_and_returns_public_url(avatar_service):
    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    object_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
    provider = avatar_service.get_storage_provider()
    await provider.put_object(avatar_service.AVATARS_BUCKET, object_path, b"small-image-bytes", content_type="image/png")

    new_url = await avatar_service.confirm_upload(
        org_id=org_id, member_id=member_id, object_path=object_path, previous_avatar_url=None,
    )
    assert new_url == f"https://storage.googleapis.com/test-avatars-bucket/{object_path}"


@pytest.mark.asyncio
async def test_confirm_upload_deletes_old_blob_on_replace():
    """페드루 조건ⓑ — 교체는 새 키로 쓰고 avatar_url만 갱신, 구 키는 confirm이 삭제한다."""
    tmp_root = tempfile.mkdtemp(prefix="avatar-test-replace-")
    old_env = {k: os.environ.get(k) for k in ("STORAGE_PROVIDER", "STORAGE_LOCAL_ROOT", "GCS_AVATARS_BUCKET")}
    try:
        os.environ["STORAGE_PROVIDER"] = "local"
        os.environ["STORAGE_LOCAL_ROOT"] = tmp_root
        os.environ["GCS_AVATARS_BUCKET"] = "test-avatars-bucket"
        import app.services.avatar_upload as avatar_service
        importlib.reload(avatar_service)

        org_id, member_id = uuid.uuid4(), uuid.uuid4()
        provider = avatar_service.get_storage_provider()

        old_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
        await provider.put_object(avatar_service.AVATARS_BUCKET, old_path, b"old", content_type="image/png")
        old_url = f"https://storage.googleapis.com/test-avatars-bucket/{old_path}"

        new_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
        await provider.put_object(avatar_service.AVATARS_BUCKET, new_path, b"new", content_type="image/png")

        new_url = await avatar_service.confirm_upload(
            org_id=org_id, member_id=member_id, object_path=new_path, previous_avatar_url=old_url,
        )
        assert new_url.endswith(new_path)

        assert (await provider.head_object(avatar_service.AVATARS_BUCKET, old_path)) is None, (
            "교체 후 구 avatar blob이 삭제되지 않음 — 페드루 조건ⓑ 위반"
        )
        assert (await provider.head_object(avatar_service.AVATARS_BUCKET, new_path)) is not None
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        import app.services.avatar_upload as avatar_service
        importlib.reload(avatar_service)


@pytest.mark.asyncio
async def test_confirm_upload_survives_transient_old_blob_delete_failure(avatar_service, monkeypatch):
    """페드루 QA 정정(2026-08-21, LOW) — 구 blob 삭제는 주석상 best-effort인데 코드는
    try 없는 await라 delete_object가 예외를 던지면(transient GCS 에러 등) confirm 전체가
    죽는다. 실제로 예외를 던지는 delete_object로 재현 — confirm은 그래도 새 avatar_url을
    반환해야 한다(신규 반영은 계속)."""
    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    provider = avatar_service.get_storage_provider()

    old_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
    await provider.put_object(avatar_service.AVATARS_BUCKET, old_path, b"old", content_type="image/png")
    old_url = f"https://storage.googleapis.com/test-avatars-bucket/{old_path}"

    new_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
    await provider.put_object(avatar_service.AVATARS_BUCKET, new_path, b"new", content_type="image/png")

    async def _raising_delete(container, object_path):
        raise RuntimeError("transient GCS error(재현용)")

    monkeypatch.setattr(provider, "delete_object", _raising_delete)
    monkeypatch.setattr(avatar_service, "get_storage_provider", lambda: provider)

    new_url = await avatar_service.confirm_upload(
        org_id=org_id, member_id=member_id, object_path=new_path, previous_avatar_url=old_url,
    )
    assert new_url.endswith(new_path), "구 blob 삭제 실패가 confirm 전체를 넘어뜨림 — best-effort 계약 위반"


@pytest.mark.asyncio
async def test_delete_avatar_removes_blob(avatar_service):
    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    object_path = f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.png"
    provider = avatar_service.get_storage_provider()
    await provider.put_object(avatar_service.AVATARS_BUCKET, object_path, b"x", content_type="image/png")
    url = f"https://storage.googleapis.com/test-avatars-bucket/{object_path}"

    await avatar_service.delete_avatar(current_avatar_url=url)

    assert (await provider.head_object(avatar_service.AVATARS_BUCKET, object_path)) is None


@pytest.mark.asyncio
async def test_delete_avatar_ignores_external_url(avatar_service):
    """우리 버킷이 아닌 avatar_url(레거시/외부값)은 delete_object 호출 없이 그냥 통과 —
    canonical_avatar_object_path가 None을 반환하는 값에 대해 예외 없이 조용히 no-op."""
    await avatar_service.delete_avatar(current_avatar_url="https://example.com/someone-elses-avatar.png")


@pytest.mark.asyncio
async def test_delete_avatar_unconfigured_bucket_is_503(avatar_service_unconfigured):
    """story #2890(카디르 QA MEDIUM, PR #3297) — delete_avatar만 create_upload_url/
    confirm_upload와 달리 버킷 미설정 시 예외 없이 조용히 return해 모듈 docstring의
    계약(⑤미설정 시 503 fail-closed)을 어기고 있었다. 라우터(team_members.py
    delete_avatar_endpoint)는 그 침묵을 성공과 구별 못 하고 avatar_url을 그대로
    null化해, storage 객체가 orphan으로 남을 수 있었다(원 재현). 이제 다른 두 함수와
    동일하게 503+AVATAR_UPLOAD_NOT_CONFIGURED를 던진다."""
    with pytest.raises(avatar_service_unconfigured.AvatarUploadError) as exc_info:
        await avatar_service_unconfigured.delete_avatar(
            current_avatar_url="https://storage.googleapis.com/some-bucket/avatar/x/y/z.png",
        )
    assert exc_info.value.status_code == 503
    assert exc_info.value.code == "AVATAR_UPLOAD_NOT_CONFIGURED"
    # no exception = pass
