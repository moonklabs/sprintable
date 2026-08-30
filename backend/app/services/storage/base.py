"""blob storage provider 추상(E-STORAGE-SSOT S1·catch#1 BE 양면).

D3 결정: BE 범위 = attachment_context 실사용인 **read + sign 만**. put/delete 는 FE 업로드
경로 전담(BE 미사용) → dead surface 회피(YAGNI). 후속에서 필요 시 확장.

story b6b9c52d(2026-08-17, #2707 후속) — 그 "후속"이 처음 실현됐다. MCP 서버는 FastAPI
백엔드와 HTTP로만 통신하는 별도 프로세스라 Next.js FE의 put 경로를 호출할 방법이 없어,
`POST /api/v2/visual-artifacts/import-image`(sprintable_import_image_artifact MCP 도구
전용, `routers/visual_artifacts.py`)가 BE 런타임에서 처음 `put_object`를 호출한다 — D3의
"put=FE 전담" 원칙에 대한 의도적 예외(구조적으로 불가피, dead surface 아님).
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
    async def signed_write_url(
        self, container: str, object_path: str, *, ttl: timedelta, content_type: str | None = None,
        create_only: bool = False,
    ) -> str | None:
        """단기 만료 write(PUT) 서명 URL — D3(put=FE) 원칙 유지하며 대용량 바이너리가 BE(Cloud Run)를
        경유하지 않게 한다(E-CANVAS C1-S5: FE가 캡처한 PNG를 GCS에 직접 PUT). 실패 시 None(best-effort).

        story #3249(카디르/codex HIGH) — create_only=True 면 "생성 전용"(기존 객체가 있으면 PUT
        거부) 조건이 서명에 바인딩된다. 없으면 GCS 기본이 "생성 또는 덮어쓰기"라, confirm이 작은
        크기로 cap을 통과시킨 뒤 아직 유효한(TTL 內) 같은 signed URL로 더 큰 객체를 재PUT해 DB
        cap 추적을 우회할 수 있었다(실 storage 는 커지는데 confirm 은 재호출 안 됨). 기본값 False
        유지 — avatar/canvas 등 기존 호출부는 인자 안 넘기면 기존 동작 그대로(무회귀)."""

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
