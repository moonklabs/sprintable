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
import logging
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

logger = logging.getLogger(__name__)

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


class ChannelImageAspectRatioTooNarrowError(Exception):
    """story #3320(Phase2·마케팅운영) — Instagram 4:5(0.8)~1.91:1처럼 «세로가 너무
    길어도» 거부하는 하한이 있는 채널용(Threads류 상한-only 채널은 image_aspect_min=
    0.0 기본값이라 이 경로 자체를 안 탄다, 아래 검증 함수 참고 — 회귀 0)."""

    def __init__(self, *, width_height_ratio: float, min_width_height_ratio: float):
        self.width_height_ratio = width_height_ratio
        self.min_width_height_ratio = min_width_height_ratio
        super().__init__(
            f"세로가 너무 길어(width/height {width_height_ratio:.2f}) 한도 "
            f"{min_width_height_ratio:.2f}에 못 미칩니다(변환으로 고칠 수 없음)"
        )


class ChannelCoverAspectRatioRejectedError(Exception):
    """story #3578(Phase2·BE·급·결함, 페드루 PO 確定 2026-09-06) — 캐러셀 이미지
    규격(`image_aspect_min`/`image_aspect_max`)과 완전히 다른 축: 영상이 이미
    붙어 있는 버전에 이미지 confirm이 오면 그건 캐러셀 첨부가 아니라 "커버
    교체"라, 커버는 그 영상과 같은 비율(`video_aspect_target±video_aspect_
    tolerance`, 어댑터 선언)이어야 한다는 완전히 다른 제약을 받는다. 유나
    §17-16 ⑥과 짝 문구 형(현재값 노출)."""

    def __init__(self, *, aspect_ratio: float, target: float, tolerance: float):
        self.aspect_ratio = aspect_ratio
        self.target = target
        self.tolerance = tolerance
        super().__init__(
            f"커버는 영상과 같은 비율({target:.4f}±{tolerance:.2f})이어야 합니다 — 현재 {aspect_ratio:.4f}"
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


class ChannelPostImageCountExceededError(Exception):
    """story #3550(Phase2, 페드루 PO 確定 2026-09-06 ③) — 어댑터 `image_max_count`
    초과 첨부 시도(예: Threads/Facebook은 여전히 1장, Instagram은 10장). 변환으로
    못 고치는 축(ASPECT/UNDECODABLE과 동형 판단) — 서버가 명시 거부한다. 이 검사가
    처음 생기기 前엔 `UniqueConstraint(version_id)`가 스키마 레벨에서 2번째 이미지
    자체를 IntegrityError로 막아 이런 명시 코드가 필요 없었다(마이그 0343으로 그
    제약이 (version_id, position)으로 완화되며 이 축이 새로 필요해졌다)."""

    def __init__(self, *, image_max_count: int):
        self.image_max_count = image_max_count
        super().__init__(f"이미지는 최대 {image_max_count}장까지 첨부할 수 있습니다")


class ChannelPostImageNotFoundError(Exception):
    """story #3550(Phase2 BE 2/2, 페드루 PO 確定 2026-09-06) — 삭제 대상 image_id가
    이 draft 최신 버전의 이미지 집합에 없음(이미 삭제됐거나 다른 draft 소속 등)."""

    def __init__(self, *, image_id: uuid.UUID):
        self.image_id = image_id
        super().__init__(f"이미지를 찾을 수 없습니다: {image_id}")


class ChannelPostImageReorderInvalidSetError(Exception):
    """전달된 image_ids 집합이 최신 버전의 실제 이미지 집합과 정확히 일치하지 않음
    (누락·중복·다른 버전/미존재 id 포함 등) — 부분 재정렬은 허용하지 않는다("나머지는
    그대로"라는 암묵 규칙을 두지 않기 위해 항상 전체 집합을 명시로 받는다)."""

    def __init__(self):
        super().__init__("image_ids가 현재 이미지 집합과 정확히 일치해야 합니다(누락·중복·불일치 없이)")


def compute_image_seal_hash(ordered_final_sha256s: list[str]) -> str:
    """story #3550(Phase2, 페드루 PO 確定 2026-09-06 ①) — `ChannelPostVersion.
    image_sha256`(→`Gate.sealed_media_sha256`)에 담을 값. **N=1은 항등**(그 이미지의
    sha256 그대로) — 이미 승인된 단일-이미지 게이트·버전이 이 스토리 배포 순간
    "변조"로 뒤집히면 안 된다(기존 봉인 의미 무변경, PO 明示 못박음). N≥2부터
    position 순으로 이어붙인 각 sha256 문자열을 그대로 합쳐 재해시 — 어느 한 장이
    바뀌거나 두 장의 순서가 바뀌면 합성 입력 문자열 자체가 달라져 합성값도 달라진다
    (「이미지 1장 바꿔치기」·「순서 재배열」 둘 다 승인 불변화 #3291 규율의 양성대조
    통과 — 디디 설계 메모에서 실측 확認)."""
    if len(ordered_final_sha256s) == 1:
        return ordered_final_sha256s[0]
    return hashlib.sha256("".join(ordered_final_sha256s).encode("utf-8")).hexdigest()


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

    # story #3550(PO 確定 ③) — 개수 상한은 다운로드·디코드·변환(비용 큰 작업) 前에
    # 즉시 거부한다(어차피 실패할 요청에 GCS 다운로드+PIL 변환을 낭비 안 함).
    latest_for_count = (await db.execute(
        select(ChannelPostVersion)
        .where(ChannelPostVersion.draft_id == draft_id)
        .order_by(ChannelPostVersion.version.desc())
        .limit(1)
    )).scalar_one_or_none()
    existing_images: list[ChannelPostImage] = []
    if latest_for_count is not None:
        existing_images = await list_channel_post_images_for_version(db, version_id=latest_for_count.id)
    if len(existing_images) >= adapter.image_max_count:
        raise ChannelPostImageCountExceededError(image_max_count=adapter.image_max_count)

    bucket = _require_bucket()
    expected_prefix = f"channel-media/{org_id}/{draft_id}/"
    if not object_path.startswith(expected_prefix) or "/" in object_path[len(expected_prefix):]:
        raise ChannelImagePathNotScopedError(object_path=object_path)

    provider = get_storage_provider()
    size = await provider.head_object(bucket, object_path)
    if size is None:
        raise ChannelImageObjectNotFoundError(object_path=object_path)

    # story #3589(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-06) — head_object가
    # 객체 존재를 확認한 뒤부터는, 아래 어떤 검증이든 거부(422)로 끝나면 원본(과
    # 이미 업로드됐을 수 있는 파생본)이 고아로 남는다 — "용량 초과" 갈래 하나에만
    # delete_object가 있어 나머지(디코드 실패·애니메이션·종횡비·파생 업로드 실패)가
    # 전부 샜다(channel_post_videos.py와 동일 클래스, 같은 처방 — 구간 전체를 한
    # 자리에서 감싼다). 삭제 자체가 실패해도 원래 거부 사유를 가리지 않는다.
    derived_object_path: str | None = None
    try:
        if size > _MAX_ORIGINAL_UPLOAD_BYTES:
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

        # story #3578(Phase2·BE·급·결함, 페드루 PO 確定 2026-09-06) — 분기(영상 유무)를
        # 비율 검증보다 먼저 결정한다. 지연 import는 channel_post_videos.py가 이
        # 모듈을 모듈 레벨에서 import하는 순환을 피하기 위함(story #3554 기존 관례,
        # 아래 캐리 로직이 쓰던 것을 여기로 당김 — 신규 순환 0). 이전엔 이 검증이
        # "이게 캐러셀 이미지인지 커버인지" 조차 모른 채 image_aspect_min(0.80)
        # 하나로 먼저 돌아, 릴스 커버(9:16=0.5625)가 그 하한을 구조적으로 못 넘어
        # 어떤 실제 커버도 통과 못 하던 결함(유나 §17-23 ④ 실측)의 근본원인이었다.
        from app.services.channel_post_videos import _copy_video_row, get_channel_post_video_for_version

        latest_for_cover_check = latest_for_count
        if latest_for_cover_check is None:
            raise ChannelPostDraftNotFoundError(draft_id)
        existing_video = await get_channel_post_video_for_version(db, version_id=latest_for_cover_check.id)

        if existing_video is not None:
            # story #3578 — 커버 규격(video_aspect_target±video_aspect_tolerance,
            # 어댑터 선언 — 하드코딩 0). 캐러셀 image_aspect_min/max와 완전히 다른
            # 축(캐러셀=정지 이미지 앨범 규격·커버=그 영상과 같은 비율이어야 하는
            # 제약)이라 아래 캐러셀 분기와 절대 안 섞는다.
            if width > 0 and height > 0 and adapter.video_aspect_target > 0:
                cover_ratio = width / height
                if abs(cover_ratio - adapter.video_aspect_target) > adapter.video_aspect_tolerance:
                    raise ChannelCoverAspectRatioRejectedError(
                        aspect_ratio=cover_ratio, target=adapter.video_aspect_target,
                        tolerance=adapter.video_aspect_tolerance,
                    )
        elif adapter.image_aspect_min > 0 and height > 0:
            # story #3320 — Instagram류(orientation-aware, 방향별 한도가 다름: 가로
            # 최대 1.91:1·세로 최대 4:5=0.8). 아래(Threads 등) 정규화(long/short, 항상
            # ≥1) 검사를 그대로 쓰면 image_aspect_max(1.91)가 방향 구분 없이 양쪽에
            # 다 적용돼 세로쪽 실제 한도(0.8)보다 훨씬 느슨해진다(정규화 1.91 ==
            # width/height 1/1.91=0.52까지 통과) — 원시 width/height 비율 하나로
            # 위(가로 초과)·아래(세로 초과) 두 한도를 각각 직접 비교해야 정확하다.
            # Threads 등 image_aspect_min=0.0(기본값)인 채널은 이 분기 자체를 안 타
            # 아래의 기존 정규화 검사 그대로(회귀 0).
            width_height_ratio = width / height
            if width_height_ratio > adapter.image_aspect_max:
                raise ChannelImageAspectRatioExceededError(
                    aspect_ratio=width_height_ratio, max_aspect_ratio=adapter.image_aspect_max,
                )
            if width_height_ratio < adapter.image_aspect_min:
                raise ChannelImageAspectRatioTooNarrowError(
                    width_height_ratio=width_height_ratio, min_width_height_ratio=adapter.image_aspect_min,
                )
        else:
            aspect_ratio = (max(width, height) / min(width, height)) if min(width, height) > 0 else 0.0
            if aspect_ratio > adapter.image_aspect_max:
                raise ChannelImageAspectRatioExceededError(
                    aspect_ratio=aspect_ratio, max_aspect_ratio=adapter.image_aspect_max,
                )

        derived_bytes, derived_content_type, derived_width, derived_height, _out_format = _derive_image(
            raw, adapter=adapter,
        )
        derived_sha256: str | None = None
        if derived_bytes is not None:
            ext = "png" if derived_content_type == "image/png" else "jpg"
            derived_object_path = _object_path(org_id=org_id, draft_id=draft_id, ext=ext)
            ok = await provider.put_object(bucket, derived_object_path, derived_bytes, content_type=derived_content_type)
            if not ok:
                raise ChannelImageUploadFailedError(object_path=derived_object_path)
            derived_sha256 = hashlib.sha256(derived_bytes).hexdigest()

        final_sha256 = derived_sha256 or original_sha256

        latest = latest_for_cover_check
    except Exception:
        try:
            await provider.delete_object(bucket, object_path)
            if derived_object_path is not None:
                await provider.delete_object(bucket, derived_object_path)
        except Exception:
            logger.exception("이미지 confirm 거부 후 GCS 객체 정리 실패 object_path=%s", object_path)
        raise

    # story #3554(Phase2, 페드루 PO 確定 2026-09-06③) — 이 draft에 영상이 이미
    # 붙어 있으면 이 호출은 캐러셀 첨부가 아니라 "커버 교체"다(PO 明示 "커버=별개
    # 이미지 에셋·기존 이미지 파이프" — 새 업로드 경로를 안 만드는 대신, 여기서
    # 영상 유무로 두 모드를 가른다). 커버는 항상 position=0 슬롯 하나뿐 — 옛
    # 커버를 캐리포워드하지 않고 이번 것으로 완전히 대체한다(캐러셀의 "추가"와
    # 다른 의미 축). 봉인은 `[video_sha256, cover_sha256]`(순서 고정). `existing_
    # video`는 story #3578에서 비율 검증 분기 결정을 위해 위로 옮긴 조회를 그대로
    # 재사용(중복 쿼리 0).
    if existing_video is not None:
        new_position = 0
        composite_sha256 = compute_image_seal_hash([existing_video.original_sha256, final_sha256])
    else:
        # story #3550(PO 確定 ①) — 기존(=carry-forward 대상) 이미지들의 sha256 + 이번에
        # 새로 붙는 이미지의 sha256을 position 순으로 이어 합성 봉인 해시를 만든다. N=1
        # (existing_images가 0장이던 첫 첨부)이면 compute_image_seal_hash가 항등을 돌려줘
        # Phase1 단일-이미지 봉인 의미와 완전히 같다(회귀 0).
        new_position = len(existing_images)
        ordered_hashes = [img.final_sha256 for img in existing_images] + [final_sha256]
        composite_sha256 = compute_image_seal_hash(ordered_hashes)

    new_version, _channel, _violations = await create_channel_post_draft_version(
        db, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        text=latest.text, link_url=latest.link_url,
        author_member_id=member_id, author_kind=member_kind, image_sha256=composite_sha256,
    )

    if existing_video is not None:
        db.add(_copy_video_row(existing_video, new_version_id=new_version.id))
    else:
        # story #3550(PO 確定 ②) — create_channel_post_draft_version()의 자체 carry-forward
        # 훅(image_sha256이 sentinel일 때만 발동)은 여기서 안 탄다(위에서 합성값을 명시로
        # 넘겼으므로) — 기존 이미지 행들을 새 version_id로 직접 복제한다(파일 재업로드·
        # 재변환 없음, object_path·sha256·position 그대로 — 단일 이미지 carry-forward
        # 패턴(channel_posts.py::create_channel_post_draft_version)을 N장으로 그대로 확장).
        for existing in existing_images:
            db.add(_copy_image_row(existing, new_version_id=new_version.id, new_position=existing.position))

    image_row = ChannelPostImage(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=new_version.id, position=new_position,
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
    """story #3550 — N장(캐러셀) 버전에서도 안 죽게 position=0(첫 장)만 대표로
    돌려준다. 이 함수·`GET .../asset` 엔드포인트의 단일-이미지 계약은 무변경(FE
    다중 슬롯 UI는 별도 스토리, PO 明示 — 마이그 0343 前엔 `.scalar_one_or_none()`
    이었으나 그 제약(UNIQUE(version_id))이 완화된 지금 N>1에 그대로 두면
    MultipleResultsFound로 죽는다)."""
    return (await db.execute(
        select(ChannelPostImage).where(ChannelPostImage.version_id == version_id)
        .order_by(ChannelPostImage.position).limit(1)
    )).scalars().first()


async def list_channel_post_images_for_version(
    db: AsyncSession, *, version_id: uuid.UUID,
) -> list[ChannelPostImage]:
    """story #3550 — 캐러셀 소비부(발행 오케스트레이션·carry-forward·봉인 재계산)용
    position 순 전체 목록. `get_channel_post_image_for_version`(단일, FE 기존 계약)
    과 별도 함수로 분리 — 호출부가 "대표 1장"과 "전체 N장"을 헷갈리지 않게."""
    return list((await db.execute(
        select(ChannelPostImage).where(ChannelPostImage.version_id == version_id)
        .order_by(ChannelPostImage.position)
    )).scalars().all())


def _copy_image_row(existing: ChannelPostImage, *, new_version_id: uuid.UUID, new_position: int) -> ChannelPostImage:
    """attach(confirm_channel_post_image_upload)·delete·reorder 셋이 공유하는 유일한
    행 복제 지점(계보 필드 나열이 세 곳에서 각자 드리프트하지 않게 — 파일 재업로드·
    재변환 없음, object_path·sha256는 그대로 복제)."""
    return ChannelPostImage(
        id=uuid.uuid4(), org_id=existing.org_id, draft_id=existing.draft_id,
        version_id=new_version_id, position=new_position,
        original_object_path=existing.original_object_path, original_sha256=existing.original_sha256,
        original_content_type=existing.original_content_type, original_bytes=existing.original_bytes,
        original_width=existing.original_width, original_height=existing.original_height,
        derived_object_path=existing.derived_object_path, derived_sha256=existing.derived_sha256,
        derived_content_type=existing.derived_content_type, derived_bytes=existing.derived_bytes,
        derived_width=existing.derived_width, derived_height=existing.derived_height,
        created_by=existing.created_by,
    )


async def delete_channel_post_image(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, image_id: uuid.UUID,
    member_id: uuid.UUID, member_kind: str,
) -> tuple[ChannelPostVersion, list[ChannelPostImage]]:
    """story #3550(Phase2 BE 2/2, 페드루 PO 確定 2026-09-06) — 이미지 1장 삭제.
    attach와 대칭축: 원본 행을 지우지 않고 **새 불변 버전**을 만들어 나머지 이미지를
    position 0..N-2로 재부여+복제하고 합성 해시를 재계산한다(#3291 승인 불변화
    규율 — 이미지 집합이 바뀌면 그 자체가 재승인 트리거, delete도 attach와 동형).
    남는 이미지가 0장이면 image_sha256=None(첫 draft의 "이미지 없음" 상태와 동일 —
    compute_image_seal_hash에 빈 리스트를 주지 않는다, sha256("")은 그 의미가 아니다)."""
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    latest = (await db.execute(
        select(ChannelPostVersion)
        .where(ChannelPostVersion.draft_id == draft_id)
        .order_by(ChannelPostVersion.version.desc())
        .limit(1)
    )).scalar_one_or_none()
    existing_images = await list_channel_post_images_for_version(db, version_id=latest.id) if latest else []
    remaining = [img for img in existing_images if img.id != image_id]
    if len(remaining) == len(existing_images):
        raise ChannelPostImageNotFoundError(image_id=image_id)

    composite_sha256 = (
        compute_image_seal_hash([img.final_sha256 for img in remaining]) if remaining else None
    )

    new_version, _channel, _violations = await create_channel_post_draft_version(
        db, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        text=latest.text, link_url=latest.link_url,
        author_member_id=member_id, author_kind=member_kind, image_sha256=composite_sha256,
    )

    new_rows = [
        _copy_image_row(existing, new_version_id=new_version.id, new_position=position)
        for position, existing in enumerate(remaining)
    ]
    for row in new_rows:
        db.add(row)
    await db.commit()
    for row in new_rows:
        await db.refresh(row)
    return new_version, new_rows


async def reorder_channel_post_images(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, image_ids: list[uuid.UUID],
    member_id: uuid.UUID, member_kind: str,
) -> tuple[ChannelPostVersion, list[ChannelPostImage]]:
    """story #3550(Phase2 BE 2/2, 페드루 PO 確定 2026-09-06) — 이미지 순서 재배열.
    `image_ids`는 새 순서 그대로 **전체 집합**(현재 버전의 이미지 id 전부, 누락·중복
    ·불일치 없이)을 받는다(부분 재정렬 불허). delete와 동형으로 새 버전을 만들어
    반영 — 순서 자체가 합성 해시 입력이라 재정렬도 재승인 트리거(#3291 규율,
    compute_image_seal_hash 모듈 docstring의 "순서 재배열도 바꿔치기와 동형" 그대로)."""
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    latest = (await db.execute(
        select(ChannelPostVersion)
        .where(ChannelPostVersion.draft_id == draft_id)
        .order_by(ChannelPostVersion.version.desc())
        .limit(1)
    )).scalar_one_or_none()
    existing_images = await list_channel_post_images_for_version(db, version_id=latest.id) if latest else []
    existing_by_id = {img.id: img for img in existing_images}
    if (
        len(image_ids) != len(existing_images)
        or len(set(image_ids)) != len(image_ids)
        or set(image_ids) != set(existing_by_id.keys())
    ):
        raise ChannelPostImageReorderInvalidSetError()

    ordered = [existing_by_id[image_id] for image_id in image_ids]
    composite_sha256 = compute_image_seal_hash([img.final_sha256 for img in ordered])

    new_version, _channel, _violations = await create_channel_post_draft_version(
        db, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        text=latest.text, link_url=latest.link_url,
        author_member_id=member_id, author_kind=member_kind, image_sha256=composite_sha256,
    )

    new_rows = [
        _copy_image_row(existing, new_version_id=new_version.id, new_position=position)
        for position, existing in enumerate(ordered)
    ]
    for row in new_rows:
        db.add(row)
    await db.commit()
    for row in new_rows:
        await db.refresh(row)
    return new_version, new_rows
