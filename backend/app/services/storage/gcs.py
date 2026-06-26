"""GCS storage provider. `google.cloud.storage` 직 import 는 이 모듈에만 격리(AC3).

로직은 기존 `attachment_context.py`(_download_object / _signed_read_url·IAM SignBlob V4)에서 이관.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from .base import StorageProvider

logger = logging.getLogger(__name__)


class GcsStorageProvider(StorageProvider):
    async def download_object(self, container: str, object_path: str) -> bytes:
        def _blocking() -> bytes:
            from google.cloud import storage  # 지연 import(의존 없을 때 모듈 로드 무영향)

            client = storage.Client()
            return client.bucket(container).blob(object_path).download_as_bytes()

        return await asyncio.to_thread(_blocking)

    async def signed_read_url(
        self, container: str, object_path: str, *, ttl: timedelta
    ) -> str | None:
        """Cloud Run ADC(키파일 없음)에서 runtime SA 가 자신에 대해 signBlob
        (roles/iam.serviceAccountTokenCreator)을 가지면 IAM SignBlob 으로 V4 서명 가능
        (creds.refresh→service_account_email+access_token 전달). blocking 은 thread 격리."""

        def _blocking() -> str:
            import google.auth
            from google.auth.transport.requests import Request as _AuthRequest
            from google.cloud import storage

            creds, _ = google.auth.default()
            creds.refresh(_AuthRequest())  # access_token 확보(IAM SignBlob 용)
            blob = storage.Client().bucket(container).blob(object_path)
            return blob.generate_signed_url(
                version="v4",
                expiration=ttl,
                method="GET",
                service_account_email=getattr(creds, "service_account_email", None),
                access_token=creds.token,
            )

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("gcs storage: signed url 생성 실패 path=%s", object_path, exc_info=True)
            return None
