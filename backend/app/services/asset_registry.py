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


def _prefix_segments_match(object_path: str, segments: list[str]) -> bool:
    """object_path 의 앞 segment 들이 `segments` 와 **정확히 일치** + 그 뒤에 비어있지 않은 file segment.

    까심 LOW(robustness): `startswith(문자열)` 대신 segment 단위 정확 비교 — 빈 trailing(`.../chat/<conv>/`
    파일 없음)·prefix 혼동·UUID 형식 변형을 견고하게 거부한다. 모든 비교값은 str(UUID) canonical 형식.
    """
    parts = object_path.split("/")
    n = len(segments)
    return len(parts) > n and parts[:n] == segments and parts[n] != ""


def path_in_source_scope(
    object_path: str,
    source_type: str,
    project_id: uuid.UUID | None,
    source_id: uuid.UUID,
    org_id: uuid.UUID | None = None,
) -> bool:
    """object_path 가 이 source(=메시지/스토리)에 귀속된 경로인지 검증(IDOR·registry 오염 차단).

    registry(sync)·agent-context(attachment_context)·authorize 가 **공유하는 단일 SSOT**(까심: 규칙
    단일화). 업로드 경로가 resource 에 스코프돼야 통과(유저가 타 org/project/conv 경로 심어 오염/IDOR
    차단). 두 namespace 인식(S7·AC3 무회귀)·**org/project/source 전 tenancy segment exact 바인딩**:
    - legacy: `chat/<project>/<conversation>/<file>` · `story/<project>/<story>/<file>`
    - S7 신: `org/<org>/project/<project>/chat/<conversation>/<file>` · `.../story/<story>/<file>`
    신 namespace 의 org segment 도 반드시 일치(미검증 시 cross-org IDOR·CRITICAL). **doc(S4)**도 동일
    스코프 강제(`org/<org>/project/<project>/doc/<doc_id>/`·register endpoint IDOR 핵심·FE 임의/타org path
    register 차단). manual 만 경로 제약 없음(신뢰 등록). segment 단위 정확 비교(_prefix_segments_match)로 견고.
    """
    pid, sid = str(project_id), str(source_id)
    kind = {"conversation_message": "chat", "story": "story", "doc": "doc"}.get(source_type)
    if kind is None:
        return True  # manual 등 경로 제약 없는 source(신뢰 등록)
    # legacy: <kind>/<project>/<source>/<file>
    if _prefix_segments_match(object_path, [kind, pid, sid]):
        return True
    # S7 신: org/<org>/project/<project>/<kind>/<source>/<file> — org 까지 exact 바인딩.
    return org_id is not None and _prefix_segments_match(
        object_path, ["org", str(org_id), "project", pid, kind, sid]
    )


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
    path_scope_id: uuid.UUID | None = None,
    reconcile: bool = True,
) -> dict[str, uuid.UUID]:
    """첨부 목록을 asset registry 로 동기화(upsert) + asset_link 재조정(reconcile).

    - 각 첨부 → asset upsert(멱등 키 container/object_path) → asset_link upsert.
    - source 의 현재 첨부 집합에 없는 기존 link 는 삭제(update 의 attachments 교체 의미 반영·SSOT 정확).
    - 외부 URL/타 버킷 첨부는 우리 객체가 아니므로 스킵.
    반환: {원본 첨부 url → asset_id} (S7: 호출부가 JSONB 에 asset_id 역기입·denorm·catch#4).

    ⚠️ path_scope_id (S7 AC1 핫픽스): path 스코프 검증용 id — **asset_link.source_id 와 분리**된다.
    conversation_message 는 업로드 path 가 conversation_id 로 스코프되는데(업로드가 메시지 생성 前이라
    conv 단위일 수밖에) asset_link.source_id 는 message_id(S5 메시지 deeplink·링크 의미)라 축이 다르다.
    둘을 같은 값으로 쓰면 `chat/{msg.id}/` 기대 vs `chat/{conv_id}/` 실제 → 영구 mismatch → 등록 0(AC1
    fail). None 이면 source_id 폴백(story 는 source_id=story_id 가 path 와 일치하므로 무변경).
    """
    if source_type not in ASSET_LINK_SOURCE_TYPES:
        raise ValueError(f"invalid asset link source_type: {source_type}")

    scope_id = path_scope_id if path_scope_id is not None else source_id
    asset_ids: list[uuid.UUID] = []
    url_map: dict[str, uuid.UUID] = {}
    for att in attachments or []:
        if not isinstance(att, dict):
            continue
        raw_url = att.get("url") or ""
        obj = canonical_object_path(raw_url, container)
        if obj is None:
            continue  # 외부/비정상 — 우리 객체 아님
        if not path_in_source_scope(obj, source_type, project_id, scope_id, org_id):
            continue  # 이 source 귀속 경로 아님 — registry 오염/IDOR 차단(까심)
        name = (att.get("name") or "").strip() or obj.rsplit("/", 1)[-1] or "file"
        content_type = (att.get("content_type") or "").strip() or None
        # 까심 ①: size 는 client-trust 금지 — 실 object size(head_object) **authoritative**(size:0 quota
        # 우회·음수 size_bytes 오염 차단). 객체 부재(head None)=FE putObject 안 함/오염 → 등록 안 함(skip·
        # phantom asset 0). 전 경로(doc register·chat send_message·story) 동시 적용=client-trust 완전 제거.
        from app.services.storage import get_storage_provider

        size_bytes = await get_storage_provider().head_object(container, obj)
        if size_bytes is None:
            continue

        # asset upsert — 멱등. project_id null/non-null 별 partial unique 로 ON CONFLICT 분기(까심 R3).
        base_ins = pg_insert(Asset).values(
            org_id=org_id,
            project_id=project_id,
            container=container,
            object_path=obj,
            name=name,
            content_type=content_type,
            size_bytes=size_bytes,
            created_by=created_by,
        )
        if project_id is not None:
            ins = base_ins.on_conflict_do_nothing(
                index_elements=[Asset.org_id, Asset.project_id, Asset.container, Asset.object_path],
                index_where=Asset.project_id.isnot(None),
            ).returning(Asset.id)
        else:
            ins = base_ins.on_conflict_do_nothing(
                index_elements=[Asset.org_id, Asset.container, Asset.object_path],
                index_where=Asset.project_id.is_(None),
            ).returning(Asset.id)
        asset_id = (await session.execute(ins)).scalar_one_or_none()
        if asset_id is None:
            # conflict(이미 존재) → org+project-scoped 재조회(타 org/project row 매핑 금지·누수 차단).
            sel = select(Asset.id).where(
                Asset.org_id == org_id, Asset.container == container, Asset.object_path == obj
            )
            sel = sel.where(Asset.project_id == project_id) if project_id is not None \
                else sel.where(Asset.project_id.is_(None))
            asset_id = (await session.execute(sel)).scalar_one()
        asset_ids.append(asset_id)
        url_map[raw_url] = asset_id  # JSONB asset_id 역기입용(denorm)

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
    # ⚠️ S4 backfill 은 reconcile=False(additive) — base64-derived 만 넘기는데 reconcile 하면 같은 doc 의
    # 기존 FE-업로드 asset_link 까지 삭제(clobber)된다. backfill 은 추가만·삭제 금지.
    if reconcile:
        stale = delete(AssetLink).where(
            AssetLink.source_type == source_type,
            AssetLink.source_id == source_id,
        )
        if asset_ids:
            stale = stale.where(AssetLink.asset_id.not_in(asset_ids))
        await session.execute(stale)

    return url_map
