"""S3(및 minio 호환) storage provider. `boto3` 는 이 모듈에서만 lazy import
(STORAGE_PROVIDER=s3 일 때만 로드). minio = S3_ENDPOINT override. 범위 = AC2 "동작"(prod 미가동).
env 는 호출 시점 read(테스트 setenv 정합).
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import timedelta

from .base import StorageProvider

logger = logging.getLogger(__name__)


def _client():
    import boto3  # 지연 import(provider=s3 일 때만)

    kwargs: dict = {}
    region = os.environ.get("S3_REGION")
    endpoint = os.environ.get("S3_ENDPOINT")
    if region:
        kwargs["region_name"] = region
    if endpoint:
        kwargs["endpoint_url"] = endpoint  # minio/호환 스토리지
    access_key = os.environ.get("S3_ACCESS_KEY_ID")
    secret_key = os.environ.get("S3_SECRET_ACCESS_KEY")
    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key
    return boto3.client("s3", **kwargs)


class S3StorageProvider(StorageProvider):
    async def download_object(self, container: str, object_path: str) -> bytes:
        def _blocking() -> bytes:
            obj = _client().get_object(Bucket=container, Key=object_path)
            return obj["Body"].read()

        return await asyncio.to_thread(_blocking)

    async def signed_read_url(
        self, container: str, object_path: str, *, ttl: timedelta
    ) -> str | None:
        def _blocking() -> str:
            return _client().generate_presigned_url(
                "get_object",
                Params={"Bucket": container, "Key": object_path},
                ExpiresIn=int(ttl.total_seconds()),
            )

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("s3 storage: signed url 생성 실패 path=%s", object_path, exc_info=True)
            return None
