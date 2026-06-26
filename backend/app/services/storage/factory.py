"""storage provider 셀렉션 — `STORAGE_PROVIDER` env 주도(OSS 기본 local).

⚠️ 기존 GCS 배포(dev/prod)는 반드시 `STORAGE_PROVIDER=gcs` 명시(미설정 default local → 첨부
read/sign 이 로컬 디스크를 보아 무회귀 위반). provider 모듈은 lazy import(boto3/google SDK 는
선택된 provider 일 때만 로드). env 는 호출 시점 read(테스트 setenv 정합).
"""
from __future__ import annotations

import os

from .base import StorageProvider


def get_storage_provider() -> StorageProvider:
    # 미설정/공백 → local(zero-config 보존·unset≠unknown). 인식 못 하는 값(오타 `gcx` 등)은
    # fail-closed(raise) — silent local 추락→첨부 ephemeral 적재 data-loss 방지.
    provider = os.environ.get("STORAGE_PROVIDER", "").strip().lower() or "local"
    if provider == "local":
        from .local import LocalStorageProvider

        return LocalStorageProvider()
    if provider == "gcs":
        from .gcs import GcsStorageProvider

        return GcsStorageProvider()
    if provider in ("s3", "minio"):
        from .s3 import S3StorageProvider

        return S3StorageProvider()
    raise ValueError(
        f'unknown STORAGE_PROVIDER: "{provider}". valid values: local | gcs | s3 | minio'
    )
