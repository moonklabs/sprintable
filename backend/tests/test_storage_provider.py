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


async def test_local_download_blocks_path_traversal(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="traversal"):
        await LocalStorageProvider().download_object("c", "../../etc/passwd")
