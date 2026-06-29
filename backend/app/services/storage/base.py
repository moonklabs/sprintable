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

    @abc.abstractmethod
    async def delete_object(self, container: str, object_path: str) -> bool:
        """객체 hard-delete(S8 grace cron). 이미 없으면 True(멱등)·실패 시 False(best-effort·호출부 계속)."""

    @abc.abstractmethod
    async def head_object(self, container: str, object_path: str) -> int | None:
        """객체 실 크기(bytes) — 부재/실패 시 None. capacity/size_bytes **authoritative source**(까심 ①:
        client-제공 size 신뢰 금지·size:0 quota 우회+음수 size_bytes 오염 차단). None=객체 미존재=미등록."""

    @abc.abstractmethod
    async def put_object(
        self, container: str, object_path: str, data: bytes, *, content_type: str | None = None
    ) -> bool:
        """객체 업로드(S4 Phase2 backfill: doc 본문 base64→GCS 이관). 성공 True·실패 False(best-effort·
        호출부가 실패 노드 base64 유지). D3(put=FE)의 후속 확장 — BE backfill 만 사용(런타임 업로드는 FE)."""
