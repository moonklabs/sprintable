"""story #2711 — image artifact `props.src`가 raw 무서명 GCS url이라 렌더가 403 나던 결함의
근본수정. `artifact_exports`(PNG export, visual_artifacts.py `_export_response`)가 이미 쓰는
패턴("url은 저장 안 하고 응답 시점마다 signed_read_url을 새로 발급") 그대로 image 노드
`props.src`에도 적용한다.

⚠️ ⓐ(페드루 명시) — 「우리 버킷 host 매칭」 판정은 이 파일의 `_our_bucket_object_path()`
하나로 좁힌다. 외부 이미지 url(사용자가 임의 http url을 props.src에 넣은 경우 등)을 잘못
서명하려 들면 IAM 호출이 엉뚱한 리소스를 겨누거나 조용히 실패한다 — read(서명 발급)·write
(canonicalize) 양쪽이 반드시 이 판정 하나만 거친다(사본 두 곳 발명 금지).

⚠️ ⓑ(페드루 명시) — 왕복 오염 가드. get(서명 url 포함 응답)을 받은 클라이언트가 그 노드를
그대로 edit으로 되보내면, 서명 쿼리스트링(`X-Goog-...`)이 그대로 저장돼 만료 後 깨진 url이
영속화된다. `_canonicalize_props()`가 저장 직전에 항상 raw(무쿼리) 형태로 되돌린다 — 이
모듈이 read/write 양쪽 진입점 전부에서 호출돼야 이 가드가 성립한다(호출 누락 = 결함 재발).
"""
from __future__ import annotations

import os
from datetime import timedelta
from urllib.parse import urlsplit

_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_HOST = "storage.googleapis.com"
_PREFIX = f"/{_BUCKET}/"
_SIGNED_READ_TTL = timedelta(minutes=15)


def _our_bucket_object_path(url: str) -> str | None:
    """url이 우리 버킷을 가리키면(raw든 서명 쿼리가 붙었든) canonical object_path를
    반환(쿼리스트링은 urlsplit이 이미 분리해 자동 배제) — 아니면(외부 url·빈 값 등) None.
    read(서명)·write(canonicalize) 양쪽이 이 함수 하나만 거친다(ⓐ)."""
    if not url:
        return None
    parts = urlsplit(url)
    if parts.netloc != _HOST or not parts.path.startswith(_PREFIX):
        return None
    return parts.path[len(_PREFIX):]


def _canonicalize_props(props: dict | None) -> dict | None:
    """저장 직전 호출(write 경로) — props.src가 우리 버킷 url(서명 쿼리 포함 가능)이면
    raw canonical url로 되돌린다(ⓑ 왕복 오염 가드). 외부 url·src 없음·이미 raw면 원본
    그대로(불필요한 dict 복사 회피)."""
    if not props or not isinstance(props.get("src"), str):
        return props
    object_path = _our_bucket_object_path(props["src"])
    if object_path is None:
        return props
    canonical_url = f"https://{_HOST}/{_BUCKET}/{object_path}"
    if canonical_url == props["src"]:
        return props
    return {**props, "src": canonical_url}


async def _sign_image_props(props: dict | None) -> dict | None:
    """응답 직전 호출(read 경로) — props.src가 우리 버킷 raw url이면 signed_read_url로
    교체(AC1). url 자체는 저장 안 하므로(canonicalize_props가 write에서 항상 raw로 되돌림)
    매 응답마다 신선하게 발급 — export 경로(list_artifact_exports)와 동일 메커니즘이라
    만료 문제가 원천적으로 없다. 서명 실패는 best-effort(기존 raw url 반환 유지, export
    경로의 signed_read_url 자체가 실패 시 None을 주는 것과 동형 관례)."""
    if not props or not isinstance(props.get("src"), str):
        return props
    object_path = _our_bucket_object_path(props["src"])
    if object_path is None:
        return props
    from app.services.storage import get_storage_provider

    signed = await get_storage_provider().signed_read_url(_BUCKET, object_path, ttl=_SIGNED_READ_TTL)
    if signed is None:
        return props
    return {**props, "src": signed}


async def sign_image_srcs_in_nodes(nodes: list) -> None:
    """`ArtifactNodeOut` 리스트를 in-place로 순회하며 각 노드의 props.src를 서명 url로
    교체(AC1) — get_artifact/get_artifact_version/create_artifact 응답·list_artifacts가
    이 함수 하나만 호출하면 된다."""
    for node in nodes:
        node.props = await _sign_image_props(node.props)
