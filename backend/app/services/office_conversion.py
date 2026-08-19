"""pptx 서버 변환 — Gotenberg 자체호스팅 파이프 (#2771).

story #2771 §7 구현 그라운딩(doc 84ef0cb7) 결정 반영:
- 트리거 = 열람 시(lazy) + 결정적 object_path 캐시. `assets` 테이블 기존 멱등 upsert
  유니크 인덱스(org+project+container+object_path)가 캐시 키 역할을 그대로 한다 —
  신규 스키마 불요.
- 입력 = raw bytes multipart POST. Gotenberg에 URL을 주지 않는다(스스로 fetch 안 함) —
  §3-A가 반복 지적한 SSRF CVE 클래스가 발동할 표면 자체가 없다.
- 변환 결과 asset은 AssetLink 0건(orphan) — `/authorize`의 asset_id 분기가 link 0건이면
  그대로 통과하는 기존 로직을 그대로 탄다(신규 인가 게이트 불요).

⚠️ 배포 전제(인프라 lane): `GOTENBERG_SERVICE_URL` 미설정 시 변환은 `ConversionUnavailable`
(호출부가 503으로 매핑) — 가짜 렌더 금지 원칙 유지, 인프라 배치 전엔 그냥 비활성.
"""
from __future__ import annotations

import os
import uuid

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset

_GOTENBERG_URL = os.environ.get("GOTENBERG_SERVICE_URL", "").rstrip("/")
_CONVERTIBLE_EXTS = frozenset({"pptx"})
_TIMEOUT = httpx.Timeout(120.0)  # §7-4: 대형 pptx 변환 지연 흡수


class ConversionUnavailable(Exception):
    """GOTENBERG_SERVICE_URL 미배선."""


class ConversionFailed(Exception):
    """Gotenberg 변환 실패(비-2xx 응답/네트워크 오류)."""


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def is_convertible(name: str, content_type: str | None) -> bool:
    """이 파이프가 다루는 형식인지 — 이 스토리 범위는 pptx만(docx는 클라이언트 렌더 별도 트랙)."""
    return _ext(name) in _CONVERTIBLE_EXTS


def converted_object_path(
    org_id: uuid.UUID, project_id: uuid.UUID | None, source_asset_id: uuid.UUID
) -> str:
    """원본 asset id로부터 결정적 변환물 경로 — 캐시 키(§7-2)."""
    proj_seg = str(project_id) if project_id is not None else "org"
    return f"converted/{org_id}/{proj_seg}/{source_asset_id}.pdf"


def _id_token_header() -> dict[str, str]:
    """office-converter Cloud Run 서비스는 `--no-allow-unauthenticated`(§7-4) — 호출부가 자신의
    런타임 SA로 audience=office-converter URL인 Google-서명 ID 토큰을 떠서 Authorization에
    실어야 IAM 게이트를 통과한다. 로컬(ADC 미가용) 등에서 발급 실패 시 헤더 없이 진행(gotenberg가
    403을 주면 ConversionFailed로 귀결 — best-effort가 아니라 정직한 실패)."""
    try:
        import google.auth.transport.requests
        from google.oauth2 import id_token as _id_token

        req = google.auth.transport.requests.Request()
        token = _id_token.fetch_id_token(req, _GOTENBERG_URL)
        return {"Authorization": f"Bearer {token}"}
    except Exception:
        return {}


async def _call_gotenberg(filename: str, data: bytes) -> bytes:
    if not _GOTENBERG_URL:
        raise ConversionUnavailable("GOTENBERG_SERVICE_URL not configured")
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            resp = await client.post(
                f"{_GOTENBERG_URL}/forms/libreoffice/convert",
                files={"files": (filename, data, "application/octet-stream")},
                headers=_id_token_header(),
            )
        except httpx.HTTPError as exc:
            raise ConversionFailed(f"gotenberg request error: {exc}") from exc
    if resp.status_code != 200:
        raise ConversionFailed(f"gotenberg returned {resp.status_code}")
    return resp.content


def _pdf_name(source_name: str) -> str:
    stem = source_name.rsplit(".", 1)[0] if "." in source_name else source_name
    return f"{stem}.pdf"


async def get_or_convert_pdf(db: AsyncSession, *, source_asset: Asset) -> Asset:
    """source_asset(pptx) → 변환된 pdf Asset(캐시 hit 또는 변환).

    호출부가 authz(org 매치 + has_project_access)를 이미 통과시킨 asset만 넘길 것 — 이 함수는
    authz를 하지 않는다(라우터 책임, asset_registry.py 패턴과 동일 관심사 분리).
    """
    container = source_asset.container
    obj_path = converted_object_path(source_asset.org_id, source_asset.project_id, source_asset.id)

    def _select_cached():
        sel = select(Asset).where(
            Asset.org_id == source_asset.org_id,
            Asset.container == container,
            Asset.object_path == obj_path,
            Asset.deleted_at.is_(None),
        )
        return sel.where(
            Asset.project_id == source_asset.project_id
            if source_asset.project_id is not None
            else Asset.project_id.is_(None)
        )

    cached = (await db.execute(_select_cached())).scalar_one_or_none()
    if cached is not None:
        return cached

    # call-time import(asset_registry.py와 동일 관례) — 테스트가 `app.services.storage.
    # get_storage_provider`를 monkeypatch 하면 이 호출이 그대로 mock 을 픽업한다.
    from app.services.storage import get_storage_provider

    provider = get_storage_provider()
    source_bytes = await provider.download_object(container, source_asset.object_path)
    pdf_bytes = await _call_gotenberg(source_asset.name, source_bytes)

    if not await provider.put_object(container, obj_path, pdf_bytes, content_type="application/pdf"):
        raise ConversionFailed("failed to store converted pdf")

    ins = pg_insert(Asset).values(
        org_id=source_asset.org_id,
        project_id=source_asset.project_id,
        container=container,
        object_path=obj_path,
        name=_pdf_name(source_asset.name),
        content_type="application/pdf",
        size_bytes=len(pdf_bytes),
        created_by=None,
    )
    if source_asset.project_id is not None:
        ins = ins.on_conflict_do_nothing(
            index_elements=[Asset.org_id, Asset.project_id, Asset.container, Asset.object_path],
            index_where=Asset.project_id.isnot(None),
        ).returning(Asset.id)
    else:
        ins = ins.on_conflict_do_nothing(
            index_elements=[Asset.org_id, Asset.container, Asset.object_path],
            index_where=Asset.project_id.is_(None),
        ).returning(Asset.id)
    asset_id = (await db.execute(ins)).scalar_one_or_none()
    if asset_id is None:
        # 동시 요청 레이스로 다른 트랜잭션이 먼저 upsert — 재조회(asset_registry.py와 동일 TOCTOU 대응).
        asset_id = (await db.execute(_select_cached())).scalar_one().id
    await db.commit()

    return (await db.execute(select(Asset).where(Asset.id == asset_id))).scalar_one()
