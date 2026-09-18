"""E-STORAGE-SSOT S1 — BE storage provider 추상: 팩토리 셀렉션 + local roundtrip + FE HMAC 정합."""
from __future__ import annotations

import hashlib
import hmac
from datetime import timedelta
from urllib.parse import urlparse

import pytest

from app.services.storage import get_storage_provider
from app.services.storage.gcs import GcsStorageProvider
from app.services.storage.local import LocalStorageProvider
from app.services.storage.s3 import S3StorageProvider


def test_factory_defaults_to_local(monkeypatch):
    monkeypatch.delenv("STORAGE_PROVIDER", raising=False)
    assert isinstance(get_storage_provider(), LocalStorageProvider)


def test_factory_selects_gcs(monkeypatch):
    monkeypatch.setenv("STORAGE_PROVIDER", "gcs")
    assert isinstance(get_storage_provider(), GcsStorageProvider)


@pytest.mark.parametrize("value", ["s3", "minio"])
def test_factory_selects_s3(monkeypatch, value):
    monkeypatch.setenv("STORAGE_PROVIDER", value)
    assert isinstance(get_storage_provider(), S3StorageProvider)


def test_factory_blank_is_local_not_unknown(monkeypatch):
    # unset≠unknown: 공백/미설정은 local(zero-config 보존).
    monkeypatch.setenv("STORAGE_PROVIDER", "   ")
    assert isinstance(get_storage_provider(), LocalStorageProvider)


def test_factory_unknown_provider_fail_closed(monkeypatch):
    # 오타 등 미인식 값은 silent local 추락 금지 → raise.
    monkeypatch.setenv("STORAGE_PROVIDER", "gcx")
    with pytest.raises(ValueError, match="unknown STORAGE_PROVIDER"):
        get_storage_provider()


@pytest.mark.parametrize("prod_var", ["APP_ENV", "NODE_ENV"])
async def test_local_secret_fail_closed_in_production(monkeypatch, prod_var):
    # APP_ENV 또는 NODE_ENV 중 하나라도 production 이면 fail-closed(운영 BE NODE_ENV-only 우회 차단).
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.setenv(prod_var, "production")
    monkeypatch.delenv("STORAGE_LOCAL_SIGNING_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="STORAGE_LOCAL_SIGNING_SECRET"):
        await LocalStorageProvider().signed_read_url(
            "c", "chat/p/c/x.png", ttl=timedelta(minutes=5)
        )


async def test_local_secret_dev_default_zero_config(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("STORAGE_LOCAL_SIGNING_SECRET", raising=False)
    url = await LocalStorageProvider().signed_read_url(
        "c", "chat/p/c/x.png", ttl=timedelta(minutes=5)
    )
    assert url is not None and "sig=" in url


async def test_local_download_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    container = "sprintable-memo-attachments"
    object_path = "chat/proj/conv/uuid-hello.txt"
    target = tmp_path / container / "chat" / "proj" / "conv" / "uuid-hello.txt"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"hello be storage")

    data = await LocalStorageProvider().download_object(container, object_path)
    assert data == b"hello be storage"


async def test_local_signed_url_matches_fe_hmac(monkeypatch):
    monkeypatch.setenv("STORAGE_LOCAL_SIGNING_SECRET", "shared-secret")
    monkeypatch.setenv("STORAGE_LOCAL_SERVE_BASE_URL", "https://app.example")
    container = "sprintable-memo-attachments"
    object_path = "chat/p1/c1/img.png"

    url = await LocalStorageProvider().signed_read_url(
        container, object_path, ttl=timedelta(minutes=5)
    )
    assert url is not None
    parsed = urlparse(url)
    assert parsed.scheme == "https" and parsed.netloc == "app.example"
    assert parsed.path == f"/api/storage/local/{container}/{object_path}"

    params = dict(p.split("=", 1) for p in parsed.query.split("&"))
    exp = int(params["exp"])
    # FE local-sign.ts 와 동일 규칙: hex sha256 over `{container}/{path}:{exp}`
    expected = hmac.new(
        b"shared-secret", f"{container}/{object_path}:{exp}".encode(), hashlib.sha256
    ).hexdigest()
    assert params["sig"] == expected


@pytest.mark.anyio
async def test_gcs_signed_write_url_binds_create_only_header(monkeypatch):
    """story #3249(카디르/codex HIGH) — create_only=True 면 x-goog-if-generation-match: 0 이
    generate_signed_url 의 headers kwarg 에 실제로 실려야 한다(이게 GCS 서버가 재PUT을 412로
    거부하게 만드는 유일한 메커니즘 — 여기가 빠지면 cap 우회 재PUT 체인이 그대로 열린다).
    create_only=False(기본, avatar/canvas 무회귀)면 headers 자체가 안 실려야 한다."""
    import google.auth
    from unittest.mock import MagicMock

    captured: list[dict] = []

    class _FakeBlob:
        def generate_signed_url(self, **kwargs):
            captured.append(kwargs)
            return "https://signed.example/fake"

    class _FakeBucket:
        def blob(self, path):
            return _FakeBlob()

    class _FakeClient:
        def bucket(self, name):
            return _FakeBucket()

    fake_creds = MagicMock()
    fake_creds.refresh = MagicMock()
    fake_creds.service_account_email = "sa@example.iam.gserviceaccount.com"
    fake_creds.token = "fake-token"
    monkeypatch.setattr(google.auth, "default", lambda: (fake_creds, "proj"))

    import google.cloud.storage as gcs_storage
    monkeypatch.setattr(gcs_storage, "Client", _FakeClient)

    provider = GcsStorageProvider()

    await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), content_type="image/png", create_only=True,
    )
    assert captured[-1].get("headers") == {"x-goog-if-generation-match": "0"}

    captured.clear()
    await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), content_type="image/png",
    )
    assert "headers" not in captured[-1]  # 기본값(avatar/canvas 무회귀) — 조건 바인딩 없음.


@pytest.mark.anyio
async def test_s3_client_forces_sigv4(monkeypatch):
    """story dc3d62f4 — SigV4 강제가 IfNoneMatch 바인딩의 전제(실측: SigV2 프리사인 URL은
    조건부 헤더가 서명 밖으로 조용히 빠짐 — signature_version 미지정이면 리전에 따라 SigV2로
    떨어질 수 있어 이 강제가 없으면 아래 테스트가 우연히 통과해도 실 배포에서 재발할 수
    있다)."""
    import boto3

    from app.services.storage.s3 import _client

    captured: dict = {}
    real_client = boto3.client

    def _spy(*args, **kwargs):
        captured.update(kwargs)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(boto3, "client", _spy)
    _client()
    assert captured["config"].signature_version == "s3v4"


@pytest.mark.anyio
async def test_s3_signed_write_url_binds_create_only_if_none_match(monkeypatch):
    """story dc3d62f4 — create_only=True면 `IfNoneMatch: "*"`(→ `If-None-Match` 헤더)가
    generate_presigned_url의 Params에 실제로 실려야 한다(boto3 PutObject operation model
    실측 확認: IfNoneMatch→header `If-None-Match`, SigV4 서명에 바인딩됨 — GCS의
    x-goog-if-generation-match:0과 동형 방어). create_only=False(기본, 무회귀)면 실리지
    않아야 한다."""
    captured: list[dict] = []

    class _FakeClient:
        def generate_presigned_url(self, operation, *, Params, ExpiresIn):
            captured.append(Params)
            return "https://signed.example/fake"

    from app.services.storage import s3 as s3_module

    monkeypatch.setattr(s3_module, "_client", lambda: _FakeClient())

    provider = S3StorageProvider()

    url = await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), content_type="image/png", create_only=True,
    )
    assert url == "https://signed.example/fake"
    assert captured[-1].get("IfNoneMatch") == "*"

    captured.clear()
    await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), content_type="image/png",
    )
    assert "IfNoneMatch" not in captured[-1]  # 기본값(무회귀) — 조건 바인딩 없음.


@pytest.mark.anyio
async def test_s3_signed_write_url_create_only_actually_rejects_replay(monkeypatch):
    """story dc3d62f4 통합 pin — 실 boto3(fake 자격증명, 오프라인 서명만)로 프리사인 URL을
    실제로 생성해 `X-Amz-SignedHeaders`에 `if-none-match`가 포함되는지 확認한다(단위 mock이
    아니라 boto3 자체의 서명 동작 — «서명은 됐는데 조건이 실제로 안 실린» 무력화 재발을
    가장 직접적으로 잡는 층). `_client()`가 실제로 읽는 env var(S3_ACCESS_KEY_ID 계열)로
    스코프 한정 — AWS_* 표준 env를 오염시키지 않는다."""
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "AKIAFAKE")
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", "fakefakefakefakefakefakefakefakefakefake")
    monkeypatch.setenv("S3_REGION", "us-east-1")

    provider = S3StorageProvider()
    url = await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), create_only=True,
    )
    assert url is not None
    assert "X-Amz-SignedHeaders=" in url
    signed_headers = url.split("X-Amz-SignedHeaders=")[1].split("&")[0]
    assert "if-none-match" in signed_headers.lower()

    url_no_create_only = await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10),
    )
    assert url_no_create_only is not None
    signed_headers_2 = url_no_create_only.split("X-Amz-SignedHeaders=")[1].split("&")[0]
    assert "if-none-match" not in signed_headers_2.lower()


@pytest.mark.anyio
async def test_local_signed_write_url_create_only_fails_closed(monkeypatch):
    """local 은 PUT 수신 자체가 미구현 — create_only=True 는 같은 이유로 fail-closed."""
    monkeypatch.setenv("STORAGE_LOCAL_SIGNING_SECRET", "shared-secret")
    provider = LocalStorageProvider()
    url = await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), content_type="image/png", create_only=True,
    )
    assert url is None
    # create_only=False(기본)는 기존 동작 무회귀 — URL 발급 계속됨.
    url2 = await provider.signed_write_url(
        "bucket", "obj/path", ttl=timedelta(minutes=10), content_type="image/png",
    )
    assert url2 is not None


def test_required_write_headers_are_provider_specific_not_hardcoded():
    """story dc3d62f4 — assets.py가 GCS 헤더를 하드코딩했었다(응답이 provider 무관하게
    항상 x-goog-if-generation-match). provider가 바뀌면 응답도 바뀌어야 한다 — 그래야
    self-host가 S3/MinIO로 배포됐을 때 FE가 맞는 헤더를 PUT에 실을 수 있다."""
    assert GcsStorageProvider().required_write_headers(create_only=True) == {
        "x-goog-if-generation-match": "0"
    }
    assert GcsStorageProvider().required_write_headers(create_only=False) == {}
    assert S3StorageProvider().required_write_headers(create_only=True) == {"If-None-Match": "*"}
    assert S3StorageProvider().required_write_headers(create_only=False) == {}
    assert LocalStorageProvider().required_write_headers(create_only=True) == {}


async def test_local_download_blocks_path_traversal(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="traversal"):
        await LocalStorageProvider().download_object("c", "../../etc/passwd")
