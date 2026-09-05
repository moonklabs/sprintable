"""story 620beefc(Phase1·마케팅운영, 페드루 PO 決定 2026-09-04) — 채널 포스트 이미지
업로드·자동 변환·계보(원본+파생본).

`avatar_upload.py`(story #2887) 관례 그대로: signed_write_url 발급(FE가 GCS에 직접
PUT, `storage/base.py` D3 원칙 — BE는 read+sign만, put은 서버측 파생본 업로드에만 예외)
→ confirm(head_object로 실 크기 검증, client-trust 금지)→**public-read 격리 버킷**
(Threads가 image_url을 서버 인증 없이 직접 curl하므로, 그라운딩 §①). uuid4 오브젝트
키(추측 불가), 원본 보존+파생본은 항상 새 키.

**서버 자동 변환**(PO 決定 ③, 온보딩 철학 "최저 지능 에이전트도 척척") — 너비·용량·
포맷·색공간은 서버가 고친다. 422로 거부하는 건 변환으로 못 고치는 것만: 종횡비 10:1
초과·디코드 불가·애니메이션(다중 프레임 GIF/WEBP 등, 단일 정지 이미지로 flatten하면
사용자 의도가 바뀐다 — Threads IMAGE 컨테이너 자체도 애니메이션 미지원, 그라운딩 §②).

색공간 정합은 Phase1 단순화: 임베디드 ICC 프로파일이 있거나 RGB/RGBA가 아닌 모드면
표준 RGB(A)로 변환+저장 시 ICC를 실지 않는다(진짜 색상관리 변환이 아니라 "sRGB로
간주하고 그렇게 저장"— 육안 색차가 있을 수 있는 알려진 단순화, 코드로 명시).

이미지는 **버전 단위**(그라운딩 §④·AC4) — 첨부/교체는 그 자체로 새
`ChannelPostVersion`을 만든다(텍스트 편집과 동형: 매 변경이 새 불변 버전). 새 버전의
`image_sha256`이 「나가는 파생본」sha256이 되고, `create_channel_post_draft_version`의
기존 재봉인 훅(`_reseal_gate_on_new_version`)이 그대로 media 축 재승인 판정까지
처리한다(새 메커니즘 발명 없음)."""
from __future__ import annotations

import hashlib
import io
import os
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_image import ChannelPostImage
from app.models.channel_post_version import ChannelPostVersion
from app.services.channel_adapters import get_channel_adapter
from app.services.channel_posts import (
    ChannelPostDraftNotFoundError,
    create_channel_post_draft_version,
    get_channel_post_draft,
)
from app.services.storage import get_storage_provider

CHANNEL_MEDIA_BUCKET = os.environ.get("GCS_CHANNEL_MEDIA_BUCKET") or None
_PUBLIC_BASE = f"https://storage.googleapis.com/{CHANNEL_MEDIA_BUCKET}/" if CHANNEL_MEDIA_BUCKET else None

# story 620beefc — 원본 업로드 상한(Threads의 8MB는 **파생본**(최종 전송분) 상한이지 원본
# 상한이 아니다 — 큰 원본을 받아 서버가 다운스케일/재인코딩해 8MB 밑으로 낮추는 것이 이
# 스토리의 요지). 그래도 무제한 업로드는 남용 표면이라 넉넉한 별도 안전선을 둔다.
_MAX_ORIGINAL_UPLOAD_BYTES = 25 * 1024 * 1024
UPLOAD_URL_TTL = timedelta(minutes=10)

_MIME_TO_EXT: dict[str, str] = {"image/jpeg": "jpg", "image/png": "png"}
_PIL_FORMAT_TO_MIME: dict[str, str] = {"JPEG": "image/jpeg", "PNG": "image/png"}

# story 620beefc — JPEG 재인코딩 시 8MB를 못 맞추면(1440px 다운스케일 뒤엔 극히 드문
# 케이스) quality를 이 순서로 낮춰가며 재시도. 바닥까지 가도 안 되면 변환 실패로 거부
# (원본 자체가 지나치게 고밀도 — 사용자에게 알리는 것이 조용히 화질을 더 망치는 것보다
# 정직하다).
_JPEG_QUALITY_STEPS = (90, 80, 70, 60, 50, 40)


class ChannelImageUnsupportedError(Exception):
    """AC1/2 — 이 채널 어댑터가 이미지를 아예 선언 안 함(image_max_count<=0)."""

    def __init__(self, *, channel: str):
        self.channel = channel
        super().__init__(f"채널 {channel!r}은 이미지 첨부를 지원하지 않습니다")


class ChannelImageStorageNotConfiguredError(Exception):
    """story 620beefc(페드루 리뷰 B5) — avatar_upload.py::AvatarUploadError(503,
    "AVATAR_UPLOAD_NOT_CONFIGURED", ...)와 동형 축. `GCS_CHANNEL_MEDIA_BUCKET` 미설정은
    "이 채널이 이미지를 지원 안 함"(422, ChannelImageUnsupportedError·제품/어댑터 성질)과
    다른 이유의 실패다 — 채널은 이미지를 지원하는데 **이 환경(dev/prod)이 아직 배선 안
    됐을 뿐**(배포 설정 갭). fail-closed 503으로 구별한다."""

    def __init__(self):
        super().__init__("채널 이미지 업로드가 이 환경에 구성되지 않았습니다(GCS_CHANNEL_MEDIA_BUCKET 미설정)")


class ChannelImageUnsupportedFormatError(Exception):
    """업로드-URL 발급 시점 content_type이 어댑터 선언 형식 밖."""

    def __init__(self, *, content_type: str, allowed: tuple[str, ...]):
        self.content_type = content_type
        self.allowed = allowed
        super().__init__(f"지원하지 않는 형식입니다: {content_type!r}(허용: {list(allowed)})")


class ChannelImagePathNotScopedError(Exception):
    def __init__(self, *, object_path: str):
        self.object_path = object_path
        super().__init__(f"이 draft 소유 업로드 경로가 아님: {object_path}")


class ChannelImageObjectNotFoundError(Exception):
    def __init__(self, *, object_path: str):
        self.object_path = object_path
        super().__init__(f"업로드된 객체를 찾을 수 없습니다(PUT 미완료?): {object_path}")


class ChannelImageTooLargeError(Exception):
    """원본이 안전 상한(_MAX_ORIGINAL_UPLOAD_BYTES)을 넘음 — 파생본 8MB 한도와는 다른 축."""

    def __init__(self, *, size_bytes: int, max_bytes: int):
        self.size_bytes = size_bytes
        self.max_bytes = max_bytes
        super().__init__(f"{size_bytes}bytes가 원본 업로드 상한 {max_bytes}bytes를 초과했습니다")


class ChannelImageUndecodableError(Exception):
    def __init__(self):
        super().__init__("이미지를 해독할 수 없습니다(손상됐거나 지원하지 않는 파일)")


class ChannelImageAnimatedUnsupportedError(Exception):
    """§13 3요소 — "무엇이"(애니메이션 이미지)만 실린다(얼마까지/지금 얼마가 의미 없는
    종류의 거부라 그 둘은 생략, ASPECT/UNDECODABLE과 동형 판단)."""

    def __init__(self, *, frame_count: int):
        self.frame_count = frame_count
        super().__init__(f"애니메이션 이미지는 지원하지 않습니다({frame_count}프레임)")


class ChannelImageAspectRatioExceededError(Exception):
    def __init__(self, *, aspect_ratio: float, max_aspect_ratio: float):
        self.aspect_ratio = aspect_ratio
        self.max_aspect_ratio = max_aspect_ratio
        super().__init__(
            f"종횡비 {aspect_ratio:.2f}:1이 한도 {max_aspect_ratio:.1f}:1을 초과했습니다(변환으로 고칠 수 없음)"
        )


class ChannelImageConversionFailedError(Exception):
    """재인코딩해도 어댑터 한도(image_max_bytes) 밑으로 못 낮춘 극히 드문 경우."""

    def __init__(self, *, final_bytes: int, max_bytes: int):
        self.final_bytes = final_bytes
        self.max_bytes = max_bytes
        super().__init__(f"자동 변환 후에도 {final_bytes}bytes가 한도 {max_bytes}bytes를 초과했습니다")


class ChannelImageUploadFailedError(Exception):
    def __init__(self, *, object_path: str):
        self.object_path = object_path
        super().__init__(f"파생본 업로드 실패: {object_path}")


def _require_bucket() -> str:
    if not CHANNEL_MEDIA_BUCKET:
        raise ChannelImageStorageNotConfiguredError()
    return CHANNEL_MEDIA_BUCKET


def _object_path(*, org_id: uuid.UUID, draft_id: uuid.UUID, ext: str) -> str:
    # avatar_upload.py::_object_path와 동형(uuid4 hex — 추측 불가). org/draft 스코프는
    # 소유권 감사·confirm 단계의 오사용 차단용(공개 버킷이라 접근제어 자체는 아님).
    return f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.{ext}"


async def create_channel_post_image_upload_url(
    *, org_id: uuid.UUID, draft_id: uuid.UUID, channel: str, content_type: str,
) -> dict:
    bucket = _require_bucket()
    adapter = get_channel_adapter(channel)
    if adapter is None or adapter.image_max_count <= 0:
        raise ChannelImageUnsupportedError(channel=channel)
    if content_type not in adapter.image_formats:
        raise ChannelImageUnsupportedFormatError(content_type=content_type, allowed=adapter.image_formats)
    ext = _MIME_TO_EXT.get(content_type, "bin")
    object_path = _object_path(org_id=org_id, draft_id=draft_id, ext=ext)
    provider = get_storage_provider()
    # story 620beefc(페드루 리뷰 블로커 B4·보안) — create_only=True 없이는 TTL(10분) 안에
    # 같은 서명 URL로 원본을 재PUT할 수 있다: confirm()이 이미 원본을 읽어 sha256·derive를
    # 끝낸 **뒤** 다른 바이트로 재PUT되면, 실제로 GCS에 저장된 객체와 우리가 해시·봉인한
    # 값이 어긋난다(발행되는 바이트≠봉인된 바이트). story #3249(assets.py 선례)와 동일
    # 처방 — GCS는 `x-goog-if-generation-match: 0`을 서명에 바인딩해 두 번째 PUT을
    # 412로 거부한다.
    upload_url = await provider.signed_write_url(
        bucket, object_path, ttl=UPLOAD_URL_TTL, content_type=content_type, create_only=True,
    )
    if upload_url is None:
        raise ChannelImageUploadFailedError(object_path=object_path)
    return {
        "upload_url": upload_url,
        "object_path": object_path,
        "expires_at": (datetime.now(timezone.utc) + UPLOAD_URL_TTL).isoformat(),
        "max_bytes": _MAX_ORIGINAL_UPLOAD_BYTES,
        # story #3249/dc3d62f4 관례 — provider별 조건부 헤더 이름이 다르다(GCS:
        # x-goog-if-generation-match·S3/MinIO: If-None-Match). FE는 PUT에 이 헤더를
        # 정확히 실어야 한다(안 실으면 서명 불일치로 PUT 자체가 깨진다).
        "required_put_headers": provider.required_write_headers(create_only=True),
    }


def _derive_image(raw: bytes, *, adapter) -> tuple[bytes | None, str | None, int | None, int | None, str | None]:
    """규격 위반 원본을 자동 변환한다. 반환: (derived_bytes, derived_content_type,
    derived_width, derived_height, out_format) — 변환 불요면 전부 None.

    호출부가 이미 UnidentifiedImageError/애니메이션/종횡비 검사를 마친 뒤에만 부른다
    (이 함수 자체는 "변환 가능"이 이미 확定된 입력만 다룬다).

    story 620beefc(페드루 리뷰 — EXIF 방향) — 휴대폰 카메라가 흔히 심는 EXIF
    Orientation 태그(회전 90/180/270도 등)를 픽셀에 굽지 않으면, 태그를 존중 안 하는
    뷰어(Threads가 그럴 것으로 가정 — 공식 문서에 EXIF 존중 언급 없음)에서 옆으로/
    거꾸로 보인다. `exif_orientation != 1`이면 다른 조건이 전부 규격 안이어도 변환을
    강제한다. `.format`은 transpose **前**에 챙긴다 — 회전이 실제로 필요하면
    `ImageOps.exif_transpose`가 새 Image 객체를 반환하는데 그 객체는 `.format`을
    안 물려받는다(Pillow 자체 동작, 여기서 안 챙기면 이후 전부 None이 된다)."""
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(raw))
    img.load()
    original_format = (img.format or "").upper()
    exif_orientation = img.getexif().get(0x0112, 1)  # 0x0112 = EXIF Orientation 태그
    img = ImageOps.exif_transpose(img)  # 방향을 픽셀에 굽는다(회전 불요면 원본 그대로 반환)
    width, height = img.size
    original_mime = _PIL_FORMAT_TO_MIME.get(original_format)
    has_icc = "icc_profile" in img.info
    needs_convert = (
        exif_orientation != 1
        or original_mime not in adapter.image_formats
        or len(raw) > adapter.image_max_bytes
        or width < adapter.image_width_min or width > adapter.image_width_max
        or img.mode not in ("RGB", "RGBA")
        or has_icc
    )
    if not needs_convert:
        return None, None, None, None, None

    has_alpha = img.mode == "RGBA" or (img.mode == "P" and "transparency" in img.info)
    if has_alpha:
        work = img.convert("RGBA")
        out_format = "PNG"
    else:
        work = img.convert("RGB")
        out_format = "JPEG"

    target_width = width
    if width > adapter.image_width_max:
        target_width = adapter.image_width_max
    elif width < adapter.image_width_min:
        target_width = adapter.image_width_min
    if target_width != width:
        target_height = max(1, round(height * (target_width / width)))
        work = work.resize((target_width, target_height), Image.LANCZOS)

    # story 620beefc(페드루 리뷰 — sRGB) — 아래 save() 호출 둘 다 `icc_profile` kwarg를
    # 의도적으로 안 넘긴다. work가 img.convert("RGB"/"RGBA")로 이미 만들어진 뒤라 원본에
    # 임베디드 ICC가 있었어도 그 프로파일 자체는 여기서 새로 저장되는 바이트에 실리지
    # 않는다 — "sRGB로 간주하고 그렇게 저장"(파일 최상단 docstring의 알려진 단순화,
    # 진짜 색상관리 변환이 아니다)이 여기 이 두 줄에서 실제로 일어나는 지점.
    buf = io.BytesIO()
    if out_format == "JPEG":
        for quality in _JPEG_QUALITY_STEPS:
            buf.seek(0)
            buf.truncate()
            work.save(buf, format="JPEG", quality=quality, optimize=True)
            if buf.tell() <= adapter.image_max_bytes:
                break
    else:
        work.save(buf, format="PNG", optimize=True)

    derived_bytes = buf.getvalue()
    if len(derived_bytes) > adapter.image_max_bytes:
        raise ChannelImageConversionFailedError(final_bytes=len(derived_bytes), max_bytes=adapter.image_max_bytes)
    derived_content_type = "image/png" if out_format == "PNG" else "image/jpeg"
    return derived_bytes, derived_content_type, work.width, work.height, out_format


async def confirm_channel_post_image_upload(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, object_path: str,
    member_id: uuid.UUID, member_kind: str,
) -> tuple[ChannelPostVersion, ChannelPostImage]:
    from PIL import Image, UnidentifiedImageError

    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    adapter = get_channel_adapter(draft.channel)
    if adapter is None or adapter.image_max_count <= 0:
        raise ChannelImageUnsupportedError(channel=draft.channel)

    bucket = _require_bucket()
    expected_prefix = f"channel-media/{org_id}/{draft_id}/"
    if not object_path.startswith(expected_prefix) or "/" in object_path[len(expected_prefix):]:
        raise ChannelImagePathNotScopedError(object_path=object_path)

    provider = get_storage_provider()
    size = await provider.head_object(bucket, object_path)
    if size is None:
        raise ChannelImageObjectNotFoundError(object_path=object_path)
    if size > _MAX_ORIGINAL_UPLOAD_BYTES:
        await provider.delete_object(bucket, object_path)
        raise ChannelImageTooLargeError(size_bytes=size, max_bytes=_MAX_ORIGINAL_UPLOAD_BYTES)

    raw = await provider.download_object(bucket, object_path)
    original_sha256 = hashlib.sha256(raw).hexdigest()

    try:
        probe = Image.open(io.BytesIO(raw))
        probe.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ChannelImageUndecodableError() from exc

    frame_count = getattr(probe, "n_frames", 1)
    if frame_count > 1:
        raise ChannelImageAnimatedUnsupportedError(frame_count=frame_count)

    # story 620beefc(페드루 리뷰 — EXIF 방향) — .format을 transpose 前에 챙긴다(회전이
    # 실제로 필요하면 exif_transpose가 .format 없는 새 객체를 반환한다, _derive_image와
    # 동일 함정). 종횡비·저장 메타(original_width/height)는 픽셀 그리드가 아니라 사람이
    # 보는 방향 기준이어야 정확하다 — 회전된 원본을 안 굽고 재면 종횡비 오판정 가능.
    original_mime = _PIL_FORMAT_TO_MIME.get((probe.format or "").upper()) or "application/octet-stream"
    from PIL import ImageOps

    probe = ImageOps.exif_transpose(probe)
    width, height = probe.size
    aspect_ratio = (max(width, height) / min(width, height)) if min(width, height) > 0 else 0.0
    if aspect_ratio > adapter.image_aspect_max:
        raise ChannelImageAspectRatioExceededError(
            aspect_ratio=aspect_ratio, max_aspect_ratio=adapter.image_aspect_max,
        )

    derived_bytes, derived_content_type, derived_width, derived_height, _out_format = _derive_image(
        raw, adapter=adapter,
    )
    derived_object_path: str | None = None
    derived_sha256: str | None = None
    if derived_bytes is not None:
        ext = "png" if derived_content_type == "image/png" else "jpg"
        derived_object_path = _object_path(org_id=org_id, draft_id=draft_id, ext=ext)
        ok = await provider.put_object(bucket, derived_object_path, derived_bytes, content_type=derived_content_type)
        if not ok:
            raise ChannelImageUploadFailedError(object_path=derived_object_path)
        derived_sha256 = hashlib.sha256(derived_bytes).hexdigest()

    final_sha256 = derived_sha256 or original_sha256

    latest = (await db.execute(
        select(ChannelPostVersion)
        .where(ChannelPostVersion.draft_id == draft_id)
        .order_by(ChannelPostVersion.version.desc())
        .limit(1)
    )).scalar_one_or_none()
    if latest is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    new_version, _channel, _violations = await create_channel_post_draft_version(
        db, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        text=latest.text, link_url=latest.link_url,
        author_member_id=member_id, author_kind=member_kind, image_sha256=final_sha256,
    )

    image_row = ChannelPostImage(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=new_version.id,
        original_object_path=object_path, original_sha256=original_sha256,
        original_content_type=original_mime, original_bytes=size,
        original_width=width, original_height=height,
        derived_object_path=derived_object_path, derived_sha256=derived_sha256,
        derived_content_type=derived_content_type, derived_bytes=len(derived_bytes) if derived_bytes else None,
        derived_width=derived_width, derived_height=derived_height,
        created_by=member_id,
    )
    db.add(image_row)
    await db.commit()
    await db.refresh(image_row)
    return new_version, image_row


def public_url_for_object_path(object_path: str) -> str | None:
    if _PUBLIC_BASE is None:
        return None
    return _PUBLIC_BASE + object_path


async def get_channel_post_image_for_version(
    db: AsyncSession, *, version_id: uuid.UUID,
) -> ChannelPostImage | None:
    return (await db.execute(
        select(ChannelPostImage).where(ChannelPostImage.version_id == version_id)
    )).scalar_one_or_none()
