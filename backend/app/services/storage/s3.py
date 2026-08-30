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

    async def signed_write_url(
        self, container: str, object_path: str, *, ttl: timedelta, content_type: str | None = None,
        create_only: bool = False,
    ) -> str | None:
        """create_only: 카디르/codex 재발견(story #3249 2라운드) — S3/MinIO는 self-host 배포의
        정식 1급 provider(factory.py, dead code 아님)라 create_only=True를 조용히 no-op하면
        "create-only 보호가 있다"는 거짓 보장이 된다(cap 우회 재현 가능). 실제 조건부-쓰기
        (If-None-Match) 구현 전까지는 **fail-closed** — URL을 아예 미발급(None, 호출부가 502로
        거부)한다. 진짜 구현은 story dc3d62f4 별건."""
        if create_only:
            logger.warning(
                "s3 storage: create_only 미지원 — URL 미발급(fail-closed) path=%s", object_path
            )
            return None

        def _blocking() -> str:
            params: dict = {"Bucket": container, "Key": object_path}
            if content_type:
                params["ContentType"] = content_type
            return _client().generate_presigned_url(
                "put_object", Params=params, ExpiresIn=int(ttl.total_seconds()),
            )

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("s3 storage: signed write url 생성 실패 path=%s", object_path, exc_info=True)
            return None

    async def delete_object(self, container: str, object_path: str) -> bool:
        def _blocking() -> bool:
            _client().delete_object(Bucket=container, Key=object_path)  # S3 delete=멱등(없어도 성공)
            return True

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("s3 storage: delete 실패 path=%s", object_path, exc_info=True)
            return False

    async def head_object(self, container: str, object_path: str) -> int | None:
        def _blocking() -> int | None:
            try:
                resp = _client().head_object(Bucket=container, Key=object_path)
                return int(resp["ContentLength"])
            except Exception:
                return None  # 404/absent

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("s3 storage: head 실패 path=%s", object_path, exc_info=True)
            return None

    async def put_object(
        self, container: str, object_path: str, data: bytes, *, content_type: str | None = None
    ) -> bool:
        def _blocking() -> bool:
            kwargs: dict = {"Bucket": container, "Key": object_path, "Body": data}
            if content_type:
                kwargs["ContentType"] = content_type
            _client().put_object(**kwargs)
            return True

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("s3 storage: put 실패 path=%s", object_path, exc_info=True)
            return False
