"""story #2887(BE) — 아바타(프로필 사진) 업로드: 서명URL 발급→confirm(head_object 실물
검증)→Member.avatar_url 반영, 삭제. 기존 storage provider(signed_write_url/head_object/
delete_object)·권한 게이트(assert_agent_owner/_assert_can_manage_human, team_members.py)
·앵커 write 경로(TeamMemberRepository.apply_anchor_update)를 전부 재사용 — 신규 인프라는
버킷 하나뿐.

페드루 확定(2026-08-21, 서빙 URL): avatar 전용 신규 격리 버킷을 **public-read**로(memo-
attachments 등 민감 버킷과 정책 분리 — uniform bucket-level access + allUsers=objectViewer,
dev=sprintable-avatars-dev). 조건 셋:
  ⓐ오브젝트 키는 uuid4 세그먼트로 추측 불가(열거 방지)
  ⓑ교체는 항상 새 키로 쓰고 avatar_url만 갱신 — 같은 키 덮어쓰기 금지(구 키는 confirm 시
    best-effort 삭제 — CDN/브라우저 캐시 무효화까지 겸함)
  ⓒ버킷은 avatar 전용 격리(다른 버킷과 IAM/정책 미공유)

prod는 버킷 미프로비저닝(심사 후 일괄, cloudbuild.yaml 참고) — GCS_AVATARS_BUCKET 미설정 시
전 함수 503(auth_configured류 fail-closed 원칙, admin_auth.py와 동형)."""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from app.services.storage import get_storage_provider

logger = logging.getLogger("sprintable.avatar_upload")

AVATARS_BUCKET = os.environ.get("GCS_AVATARS_BUCKET") or None
_PUBLIC_BASE = f"https://storage.googleapis.com/{AVATARS_BUCKET}/" if AVATARS_BUCKET else None

# 페드루 확定값(2026-08-21).
MAX_AVATAR_BYTES = 5 * 1024 * 1024
_ALLOWED_CONTENT_TYPES: dict[str, str] = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
UPLOAD_URL_TTL = timedelta(minutes=10)


class AvatarUploadError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


def _require_bucket() -> str:
    if not AVATARS_BUCKET:
        raise AvatarUploadError(503, "AVATAR_UPLOAD_NOT_CONFIGURED", "avatar 업로드가 이 환경에 구성되지 않음")
    return AVATARS_BUCKET


def _object_path(org_id: uuid.UUID, member_id: uuid.UUID, ext: str) -> str:
    # uuid4 hex 세그먼트 — 조건ⓐ(추측 불가). org+member 스코프는 소유권 감사·정리용(접근제어
    # 자체는 public-read라 경로 비밀성에 기대지 않는다 — confirm 단계의 prefix 검증은 IDOR
    # 방지가 아니라 "내 것 아닌 경로로 내 avatar_url을 가리키게" 하는 오사용 차단).
    return f"avatar/{org_id}/{member_id}/{uuid.uuid4().hex}.{ext}"


def canonical_avatar_object_path(url: str | None) -> str | None:
    """avatar_url이 이 avatar 버킷의 객체를 가리키면 그 object_path, 아니면 None(외부 URL·
    레거시 값 등 — 우리가 관리하지 않는 값은 절대 안 건드린다)."""
    if not url or not _PUBLIC_BASE or not url.startswith(_PUBLIC_BASE):
        return None
    return url[len(_PUBLIC_BASE):] or None


async def create_upload_url(*, org_id: uuid.UUID, member_id: uuid.UUID, content_type: str) -> dict:
    bucket = _require_bucket()
    ext = _ALLOWED_CONTENT_TYPES.get(content_type)
    if ext is None:
        raise AvatarUploadError(
            422, "UNSUPPORTED_CONTENT_TYPE",
            f"허용되지 않는 content_type: {content_type!r} (허용: {sorted(_ALLOWED_CONTENT_TYPES)})",
        )
    object_path = _object_path(org_id, member_id, ext)
    upload_url = await get_storage_provider().signed_write_url(
        bucket, object_path, ttl=UPLOAD_URL_TTL, content_type=content_type,
    )
    if upload_url is None:
        raise AvatarUploadError(502, "SIGN_FAILED", "업로드 URL 서명 실패")
    return {
        "upload_url": upload_url,
        "object_path": object_path,
        "public_url": _PUBLIC_BASE + object_path,
        "expires_at": (datetime.now(timezone.utc) + UPLOAD_URL_TTL).isoformat(),
        "max_bytes": MAX_AVATAR_BYTES,
    }


async def confirm_upload(
    *, org_id: uuid.UUID, member_id: uuid.UUID, object_path: str, previous_avatar_url: str | None,
) -> str:
    bucket = _require_bucket()
    # 방금 발급한 upload-url이 아닌 임의 object_path(타인 경로 등)를 confirm에 흘려
    # avatar_url을 오염시키는 것을 차단 — 정확히 이 org/member 스코프 prefix 아래의 단일
    # 파일(추가 "/" 없음)만 허용.
    expected_prefix = f"avatar/{org_id}/{member_id}/"
    if not object_path.startswith(expected_prefix) or "/" in object_path[len(expected_prefix):]:
        raise AvatarUploadError(403, "PATH_NOT_SCOPED", "이 member 소유 업로드 경로가 아님")

    provider = get_storage_provider()
    # 까심 ①과 동일 원칙(asset_registry.py) — client가 아니라 실 객체 크기가 authoritative.
    size = await provider.head_object(bucket, object_path)
    if size is None:
        raise AvatarUploadError(404, "OBJECT_NOT_FOUND", "업로드된 객체를 찾을 수 없음(PUT 미완료?)")
    if size > MAX_AVATAR_BYTES:
        await provider.delete_object(bucket, object_path)
        raise AvatarUploadError(413, "AVATAR_TOO_LARGE", f"{size}bytes가 상한 {MAX_AVATAR_BYTES}bytes 초과")

    new_url = _PUBLIC_BASE + object_path
    # 조건ⓑ: 교체=새 키+구 키 삭제(같은 키 덮어쓰기 금지). best-effort — 실패해도 신규 반영은
    # 진행해야 하는데(주석 원문 그대로) delete_object 자체가 내부 예외를 삼키지만, 그 계약을
    # 이 호출부가 코드로도 보장한다(페드루 QA 정정, 2026-08-21) — transient 에러가 confirm
    # 전체를 넘어뜨리지 않게 명시 방어.
    old_path = canonical_avatar_object_path(previous_avatar_url)
    if old_path and old_path != object_path:
        try:
            await provider.delete_object(bucket, old_path)
        except Exception:
            logger.warning("avatar_upload: 구 blob 삭제 실패(best-effort, 신규 반영은 계속) path=%s", old_path, exc_info=True)
    return new_url


async def delete_avatar(*, current_avatar_url: str | None) -> None:
    if not AVATARS_BUCKET:
        return
    old_path = canonical_avatar_object_path(current_avatar_url)
    if old_path:
        await get_storage_provider().delete_object(AVATARS_BUCKET, old_path)
