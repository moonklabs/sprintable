"""S3(및 minio 호환) storage provider. `boto3` 는 이 모듈에서만 lazy import
(STORAGE_PROVIDER=s3 일 때만 로드). minio = S3_ENDPOINT override. self-host(OSS) 배포의 정식
1급 provider — 우리 SaaS(dev/prod)는 GCS를 쓰므로 이 provider 자체는 여기서 미가동이지만
dead code 아님(story dc3d62f4, #3254 재확認). env 는 호출 시점 read(테스트 setenv 정합).
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
    from botocore.config import Config

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
    # story dc3d62f4 — SigV4 명시 강제. boto3가 리전(특히 us-east-1)에 따라 SigV2로 조용히
    # 떨어지면 아래 signed_write_url의 IfNoneMatch가 서명에 안 묶인다(직접 실측: SigV2
    # 프리사인 URL엔 조건부 헤더가 아예 안 실림 — "서명은 됐는데 조건은 서버가 검증 안 함"이
    # 되어 create_only=True가 조용히 무력화된다). MinIO도 SigV4 전제라 이 강제가 둘 다 해결.
    kwargs["config"] = Config(signature_version="s3v4")
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
        """create_only: story #3249(카디르/codex HIGH) 처방을 GCS와 동형으로 실구현(story
        dc3d62f4) — gcs.py가 `x-goog-if-generation-match: 0`을 서명에 묶는 것과 동형으로,
        여기선 `If-None-Match: *`(AWS S3 조건부 쓰기, PutObject 표준 파라미터 — boto3
        operation model에 `IfNoneMatch`→헤더 `If-None-Match`로 실측 확認)를 서명에 묶는다.
        "객체가 아직 없을 때만 생성" 조건이 presigned URL 자체에 바인딩돼, 같은 URL로 재PUT하면
        412 Precondition Failed로 거부된다(cap 우회 재PUT 체인 차단, GCS와 동일 방어).

        ⚠️SigV4 강제가 전제(위 `_client()`) — SigV2로 서명하면 `IfNoneMatch`가 조용히
        시그니처 밖으로 빠져(직접 실측: SigV2 프리사인 URL의 쿼리스트링엔 조건부 헤더 흔적이
        아예 없음) "서명은 유효한데 조건은 서버가 검증 안 하는" 무력화된 create_only가 된다
        — 이게 원래 no-op 결함과 같은 결과를 조용히 재현하는 자리라 SigV4 강제 없이 이 분기만
        추가하면 안 됨."""

        def _blocking() -> str:
            params: dict = {"Bucket": container, "Key": object_path}
            if content_type:
                params["ContentType"] = content_type
            if create_only:
                params["IfNoneMatch"] = "*"
            return _client().generate_presigned_url(
                "put_object", Params=params, ExpiresIn=int(ttl.total_seconds()),
            )

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("s3 storage: signed write url 생성 실패 path=%s", object_path, exc_info=True)
            return None

    def required_write_headers(self, *, create_only: bool = False) -> dict[str, str]:
        return {"If-None-Match": "*"} if create_only else {}

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
