"""E-STORAGE-SSOT S2: asset registry 서비스 — 첨부 persist 시 asset/asset_link 동기화(SAVE-time).

D1 결정: upload 엔드포인트가 아니라 메시지/스토리 SAVE 트랜잭션 안에서 asset + asset_link 를
원자 생성(orphan 0). attachments(JSONB) 와 같은 세션·같은 커밋에 묶인다.
"""
from __future__ import annotations

import os
import uuid

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import ASSET_LINK_SOURCE_TYPES, Asset, AssetLink

# S1 GCS_MEMO_ATTACHMENTS_BUCKET 기본과 정합. 현재 단일 컨테이너(첨부 버킷).
DEFAULT_CONTAINER = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_PUBLIC_PREFIX = f"https://storage.googleapis.com/{DEFAULT_CONTAINER}/"


def canonical_object_path(stored_url: str, container: str = DEFAULT_CONTAINER) -> str | None:
    """저장 url → canonical object_path. 우리 객체가 아니면 None.

    S1 `_canonical_object_path` 규칙과 정합: GCS public prefix 제거 / bare 그대로 / 외부 스킴 None.
    """
    if not stored_url:
        return None
    prefix = f"https://storage.googleapis.com/{container}/"
    if stored_url.startswith(prefix):
        return stored_url[len(prefix):] or None
    if "://" in stored_url:
        return None
    return stored_url


async def sync_attachment_assets(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    source_type: str,
    source_id: uuid.UUID,
    attachments: list[dict] | None,
    created_by: uuid.UUID | None = None,
    container: str = DEFAULT_CONTAINER,
) -> list[uuid.UUID]:
    """첨부 목록을 asset registry 로 동기화(upsert) + asset_link 재조정(reconcile).

    - 각 첨부 → asset upsert(멱등 키 container/object_path) → asset_link upsert.
    - source 의 현재 첨부 집합에 없는 기존 link 는 삭제(update 의 attachments 교체 의미 반영·SSOT 정확).
    - 외부 URL/타 버킷 첨부는 우리 객체가 아니므로 스킵.
    반환: 현재 첨부에 대응하는 asset_id 목록.
    """
    if source_type not in ASSET_LINK_SOURCE_TYPES:
        raise ValueError(f"invalid asset link source_type: {source_type}")

    asset_ids: list[uuid.UUID] = []
    for att in attachments or []:
        if not isinstance(att, dict):
            continue
        obj = canonical_object_path(att.get("url") or "", container)
        if obj is None:
            continue  # 외부/비정상 — 우리 객체 아님
        name = (att.get("name") or "").strip() or obj.rsplit("/", 1)[-1] or "file"
        content_type = (att.get("content_type") or "").strip() or None
        try:
            size_bytes = int(att.get("size") or 0)
        except (TypeError, ValueError):
            size_bytes = 0

        # asset upsert — 멱등(container/object_path). 충돌 시 RETURNING 없음 → 후속 SELECT.
        ins = (
            pg_insert(Asset)
            .values(
                org_id=org_id,
                project_id=project_id,
                container=container,
                object_path=obj,
                name=name,
                content_type=content_type,
                size_bytes=size_bytes,
                created_by=created_by,
            )
            .on_conflict_do_nothing(constraint="uq_assets_container_object_path")
            .returning(Asset.id)
        )
        asset_id = (await session.execute(ins)).scalar_one_or_none()
        if asset_id is None:
            asset_id = (
                await session.execute(
                    select(Asset.id).where(
                        Asset.container == container, Asset.object_path == obj
                    )
                )
            ).scalar_one()
        asset_ids.append(asset_id)

        await session.execute(
            pg_insert(AssetLink)
            .values(
                org_id=org_id,
                asset_id=asset_id,
                source_type=source_type,
                source_id=source_id,
                created_by=created_by,
            )
            .on_conflict_do_nothing(constraint="uq_asset_links_asset_source")
        )

    # reconcile: 이 source 의 현재 집합에 없는 link 제거(update 의 attachments 교체 의미).
    stale = delete(AssetLink).where(
        AssetLink.source_type == source_type,
        AssetLink.source_id == source_id,
    )
    if asset_ids:
        stale = stale.where(AssetLink.asset_id.not_in(asset_ids))
    await session.execute(stale)

    return asset_ids
