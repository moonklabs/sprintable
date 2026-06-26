"""blob storage provider 추상(E-STORAGE-SSOT S1·catch#1 BE 양면).

D3 결정: BE 범위 = attachment_context 실사용인 **read + sign 만**. put/delete 는 FE 업로드
경로 전담(BE 미사용) → dead surface 회피(YAGNI). 후속에서 필요 시 확장.
"""
from __future__ import annotations

import abc
from datetime import timedelta


class StorageProvider(abc.ABC):
    """provider(gcs|s3|minio|local)별 read/sign 구현을 이 계약 뒤로 숨긴다."""

    @abc.abstractmethod
    async def download_object(self, container: str, object_path: str) -> bytes:
        """객체 bytes 다운로드. blocking client 는 호출부가 thread 격리하거나 구현이 격리한다."""

    @abc.abstractmethod
    async def signed_read_url(
        self, container: str, object_path: str, *, ttl: timedelta
    ) -> str | None:
        """단기 만료 read 서명 URL. 실패 시 None(best-effort)."""
