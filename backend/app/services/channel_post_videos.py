"""story #3554(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Instagram 릴스(영상)
마스터 업로드·규격 검증·계보.

`channel_post_images.py`(620beefc)와 같은 2단계(signed URL 발급 → FE 직접 PUT →
confirm)를 그대로 재사용한다(같은 GCS 버킷·같은 object_path 스코프 관례). 유일한
구조 차이 — **서버 자동 변환을 하지 않는다**(ffmpeg류 의존 0, 페드루 PO 決定
2026-09-06④ — Cloud Run 이미지·빌드 반경 확대를 피함). 대신 순수 파이썬 MP4/MOV
박스(ISO Base Media File Format) 파서로 규격(길이·해상도·비디오 코덱 fourcc)만
읽어 어댑터 선언과 대조한다 — 파싱 실패는 fail-closed 422(「조용한 통과 0」, PO
明示). **오디오 코덱은 미검증 선언**(문구에 그대로 노출, 파서가 audio track을
안 읽는다).

봉인 축 — `ChannelPostVersion.image_sha256`(→`Gate.sealed_media_sha256`, #3550
안 A와 같은 컬럼·같은 재사용 관례) 하나에 **항상 2원소 합성**
`compute_image_seal_hash([video_sha256, cover_sha256 or ""])`을 담는다(순서
고정 — 영상=0·커버=1). 이미지 캐러셀의 N=1 항등 분기와 겹치지 않는다(영상
모드는 원소가 항상 2개라 그 분기를 절대 안 탄다 — 두 모드가 값 공간에서
자연히 분리).

커버는 **새 테이블이 아니라 기존 `ChannelPostImage`(position=0) 그대로 재사용**
(PO 明示 "커버=별개 이미지 에셋·기존 이미지 파이프") — `channel_post_images.py::
confirm_channel_post_image_upload`가 "이 draft에 영상이 이미 있으면 캐러셀이
아니라 커버 교체"로 분기해 이 모듈의 봉인 재계산 규칙을 그대로 따른다."""
from __future__ import annotations

import hashlib
import logging
import struct
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_video import ChannelPostVideo
from app.models.channel_post_version import ChannelPostVersion
from app.services.channel_adapters import get_channel_adapter
from app.services.channel_post_images import (
    UPLOAD_URL_TTL,
    _copy_image_row,
    _require_bucket,
    compute_image_seal_hash,
    get_channel_post_image_for_version,
    list_channel_post_images_for_version,
)
from app.services.channel_posts import (
    ChannelPostDraftNotFoundError,
    create_channel_post_draft_version,
    get_channel_post_draft,
)
from app.services.storage import get_storage_provider

logger = logging.getLogger(__name__)

_MIME_TO_EXT: dict[str, str] = {"video/mp4": "mp4", "video/quicktime": "mov"}


class ChannelVideoUnsupportedError(Exception):
    """이 채널 어댑터가 영상을 아예 선언 안 함(video_max_bytes<=0) — image_max_
    count<=0과 동형 판단."""

    def __init__(self, *, channel: str):
        self.channel = channel
        super().__init__(f"채널 {channel!r}은 영상 첨부를 지원하지 않습니다")


class ChannelVideoUnsupportedFormatError(Exception):
    def __init__(self, *, content_type: str, allowed: tuple[str, ...]):
        self.content_type = content_type
        self.allowed = allowed
        super().__init__(f"지원하지 않는 영상 형식입니다: {content_type!r}(허용: {list(allowed)})")


class ChannelVideoPathNotScopedError(Exception):
    def __init__(self, *, object_path: str):
        self.object_path = object_path
        super().__init__(f"이 draft 소유 업로드 경로가 아님: {object_path}")


class ChannelVideoObjectNotFoundError(Exception):
    def __init__(self, *, object_path: str):
        self.object_path = object_path
        super().__init__(f"업로드된 객체를 찾을 수 없습니다(PUT 미완료?): {object_path}")


class ChannelVideoTooLargeError(Exception):
    def __init__(self, *, size_bytes: int, max_bytes: int):
        self.size_bytes = size_bytes
        self.max_bytes = max_bytes
        super().__init__(f"{size_bytes}bytes가 영상 업로드 상한 {max_bytes}bytes를 초과했습니다")


class ChannelVideoUnparsableError(Exception):
    """MP4/MOV 박스 구조를 읽을 수 없음(손상됐거나 지원하지 않는 컨테이너 —
    fail-closed, PO 明示 「조용한 통과 0」)."""

    def __init__(self):
        super().__init__("영상 규격을 읽을 수 없습니다")


class ChannelVideoDurationExceededError(Exception):
    def __init__(self, *, duration_seconds: float, max_seconds: float):
        self.duration_seconds = duration_seconds
        self.max_seconds = max_seconds
        super().__init__(f"영상 길이 {duration_seconds:.1f}초가 상한 {max_seconds:.0f}초를 초과했습니다")


class ChannelVideoDurationTooShortError(Exception):
    def __init__(self, *, duration_seconds: float, min_seconds: float):
        self.duration_seconds = duration_seconds
        self.min_seconds = min_seconds
        super().__init__(f"영상 길이 {duration_seconds:.1f}초가 하한 {min_seconds:.0f}초에 못 미칩니다")


class ChannelVideoAspectRatioError(Exception):
    def __init__(self, *, aspect_ratio: float, target: float, tolerance: float):
        self.aspect_ratio = aspect_ratio
        self.target = target
        self.tolerance = tolerance
        super().__init__(
            f"영상 비율 {aspect_ratio:.3f}이 목표 {target:.3f}(±{tolerance:.2f})를 벗어났습니다(변환 불가)"
        )


class ChannelVideoCodecUnsupportedError(Exception):
    def __init__(self, *, codec: str, allowed: tuple[str, ...]):
        self.codec = codec
        self.allowed = allowed
        super().__init__(f"지원하지 않는 영상 코덱입니다: {codec!r}(허용: {list(allowed)})")


class ChannelVideoUploadFailedError(Exception):
    def __init__(self, *, object_path: str):
        self.object_path = object_path
        super().__init__(f"영상 업로드 실패: {object_path}")


class ChannelVideoRequiresSingleCoverError(Exception):
    """story #3574(Phase2·BE·결함, 페드루 PO 確定 2026-09-06) — 이 함수 아래의
    「단수 getter로 커버 1장만 캐리」가 이미지 N장(N≥2, 캐러셀) 버전에 그대로
    도달하면 나머지 N-1장이 사용자 행동 하나(영상 첨부)로 조용히 사라진다
    (유나 §17-23 ④ 규격 구멍 실측 — `get_channel_post_image_for_version`이
    position=0만 대표로 돌려주는 기존 계약 자체는 옳다, 문제는 그 계약을
    캐러셀 버전에도 무비판 적용한 이 호출부였다). 금지 AC — 트랜잭션(새 버전
    생성) 시작 前에 명시 거부."""

    def __init__(self):
        super().__init__("영상은 커버 이미지 1장과만 함께 갈 수 있습니다 — 이미지를 1장으로 줄인 뒤 첨부하세요.")


@dataclass(frozen=True)
class MP4Metadata:
    duration_seconds: float
    width: int
    height: int
    codec: str


def _iter_boxes(buf: bytes, start: int, end: int):
    """ISO Base Media File Format 박스 순회(top-level만, 재귀 X — 호출부가 필요한
    컨테이너 박스의 payload 범위를 다시 이 함수에 넘겨 한 단계씩 내려간다).
    size==0(파일 끝까지)·size==1(다음 8바이트가 64비트 largesize) 둘 다 처리."""
    pos = start
    while pos + 8 <= end:
        size = struct.unpack(">I", buf[pos:pos + 4])[0]
        box_type = buf[pos + 4:pos + 8]
        header_size = 8
        if size == 1:
            if pos + 16 > end:
                raise ChannelVideoUnparsableError()
            size = struct.unpack(">Q", buf[pos + 8:pos + 16])[0]
            header_size = 16
        elif size == 0:
            size = end - pos
        if size < header_size or pos + size > end:
            raise ChannelVideoUnparsableError()
        yield box_type, pos + header_size, pos + size
        pos += size


def _find_box(buf: bytes, box_type: bytes, start: int, end: int) -> tuple[int, int] | None:
    for bt, p_start, p_end in _iter_boxes(buf, start, end):
        if bt == box_type:
            return p_start, p_end
    return None


def _find_all_boxes(buf: bytes, box_type: bytes, start: int, end: int) -> list[tuple[int, int]]:
    return [(p_start, p_end) for bt, p_start, p_end in _iter_boxes(buf, start, end) if bt == box_type]


def _parse_mvhd_duration_seconds(buf: bytes, start: int, end: int) -> float:
    if end - start < 4:
        raise ChannelVideoUnparsableError()
    version = buf[start]
    if version == 1:
        off = start + 4 + 8 + 8  # version+flags, creation_time(8), modification_time(8)
        if off + 4 + 8 > end:
            raise ChannelVideoUnparsableError()
        timescale = struct.unpack(">I", buf[off:off + 4])[0]
        duration = struct.unpack(">Q", buf[off + 4:off + 12])[0]
    else:
        off = start + 4 + 4 + 4  # version+flags, creation_time(4), modification_time(4)
        if off + 4 + 4 > end:
            raise ChannelVideoUnparsableError()
        timescale = struct.unpack(">I", buf[off:off + 4])[0]
        duration = struct.unpack(">I", buf[off + 4:off + 8])[0]
    if timescale <= 0:
        raise ChannelVideoUnparsableError()
    return duration / timescale


def _parse_tkhd_dimensions(buf: bytes, start: int, end: int) -> tuple[int, int]:
    if end - start < 4:
        raise ChannelVideoUnparsableError()
    version = buf[start]
    # version+flags(4) + creation+modification+track_ID+reserved+duration
    fixed = 4 + (8 + 8 + 4 + 4 + 8) if version == 1 else 4 + (4 + 4 + 4 + 4 + 4)
    # + reserved(8) + layer(2) + alternate_group(2) + volume(2) + reserved(2) + matrix(36)
    offset = start + fixed + 8 + 2 + 2 + 2 + 2 + 36
    if offset + 8 > end:
        raise ChannelVideoUnparsableError()
    width_fixed = struct.unpack(">I", buf[offset:offset + 4])[0]
    height_fixed = struct.unpack(">I", buf[offset + 4:offset + 8])[0]
    return width_fixed >> 16, height_fixed >> 16


def _parse_hdlr_handler_type(buf: bytes, start: int, end: int) -> bytes:
    offset = start + 4 + 4  # version+flags(4) + pre_defined(4)
    if offset + 4 > end:
        raise ChannelVideoUnparsableError()
    return buf[offset:offset + 4]


def _parse_stsd_codec(buf: bytes, start: int, end: int) -> str:
    offset = start + 4  # version+flags(4)
    if offset + 4 > end:
        raise ChannelVideoUnparsableError()
    entry_count = struct.unpack(">I", buf[offset:offset + 4])[0]
    offset += 4
    if entry_count < 1 or offset + 8 > end:
        raise ChannelVideoUnparsableError()
    # 첫 샘플 엔트리: size(4) + format fourcc(4).
    fourcc = buf[offset + 4:offset + 8]
    return fourcc.decode("ascii", errors="replace")


def parse_mp4_metadata(raw: bytes) -> MP4Metadata:
    """MP4/MOV(ISOBMFF) 박스 트리에서 `moov/mvhd`(길이)·비디오 `trak`의 `tkhd`
    (해상도)·`stsd`(코덱 fourcc)만 읽는다. 오디오 트랙·코덱은 안 본다(PO 明示
    미검증 선언). 구조가 예상과 다르면(박스 부재·경계 초과·손상) 전부
    `ChannelVideoUnparsableError`로 수렴 — 조용한 통과 0."""
    try:
        n = len(raw)
        moov = _find_box(raw, b"moov", 0, n)
        if moov is None:
            raise ChannelVideoUnparsableError()
        moov_start, moov_end = moov

        mvhd = _find_box(raw, b"mvhd", moov_start, moov_end)
        if mvhd is None:
            raise ChannelVideoUnparsableError()
        duration_seconds = _parse_mvhd_duration_seconds(raw, *mvhd)

        video_trak: tuple[int, int, tuple[int, int]] | None = None
        for trak_start, trak_end in _find_all_boxes(raw, b"trak", moov_start, moov_end):
            mdia = _find_box(raw, b"mdia", trak_start, trak_end)
            if mdia is None:
                continue
            hdlr = _find_box(raw, b"hdlr", *mdia)
            if hdlr is None:
                continue
            if _parse_hdlr_handler_type(raw, *hdlr) == b"vide":
                video_trak = (trak_start, trak_end, mdia)
                break
        if video_trak is None:
            raise ChannelVideoUnparsableError()
        trak_start, trak_end, mdia = video_trak

        tkhd = _find_box(raw, b"tkhd", trak_start, trak_end)
        if tkhd is None:
            raise ChannelVideoUnparsableError()
        width, height = _parse_tkhd_dimensions(raw, *tkhd)
        if width <= 0 or height <= 0:
            raise ChannelVideoUnparsableError()

        minf = _find_box(raw, b"minf", *mdia)
        if minf is None:
            raise ChannelVideoUnparsableError()
        stbl = _find_box(raw, b"stbl", *minf)
        if stbl is None:
            raise ChannelVideoUnparsableError()
        stsd = _find_box(raw, b"stsd", *stbl)
        if stsd is None:
            raise ChannelVideoUnparsableError()
        codec = _parse_stsd_codec(raw, *stsd)
    except (struct.error, IndexError) as exc:
        raise ChannelVideoUnparsableError() from exc

    return MP4Metadata(duration_seconds=duration_seconds, width=width, height=height, codec=codec)


def _object_path(*, org_id: uuid.UUID, draft_id: uuid.UUID, ext: str) -> str:
    return f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.{ext}"


async def create_channel_post_video_upload_url(
    *, org_id: uuid.UUID, draft_id: uuid.UUID, channel: str, content_type: str,
) -> dict:
    bucket = _require_bucket()
    adapter = get_channel_adapter(channel)
    if adapter is None or adapter.video_max_bytes <= 0:
        raise ChannelVideoUnsupportedError(channel=channel)
    if content_type not in _MIME_TO_EXT:
        raise ChannelVideoUnsupportedFormatError(content_type=content_type, allowed=tuple(_MIME_TO_EXT))
    ext = _MIME_TO_EXT[content_type]
    object_path = _object_path(org_id=org_id, draft_id=draft_id, ext=ext)
    provider = get_storage_provider()
    upload_url = await provider.signed_write_url(
        bucket, object_path, ttl=UPLOAD_URL_TTL, content_type=content_type, create_only=True,
    )
    if upload_url is None:
        raise ChannelVideoUploadFailedError(object_path=object_path)
    return {
        "upload_url": upload_url,
        "object_path": object_path,
        "expires_at": (datetime.now(timezone.utc) + UPLOAD_URL_TTL).isoformat(),
        "max_bytes": adapter.video_max_bytes,
        "required_put_headers": provider.required_write_headers(create_only=True),
    }


async def confirm_channel_post_video_upload(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, object_path: str,
    member_id: uuid.UUID, member_kind: str,
) -> tuple[ChannelPostVersion, ChannelPostVideo]:
    """story #3554(PO 確定①~④) — 업로드 확인+MP4 규격 검증+계보. attach와 동형
    (confirm_channel_post_image_upload의 새-버전 패턴 재사용) — 매 호출이 새
    `ChannelPostVersion`을 만들고, 기존 커버(있으면)를 새 버전으로 복제한 뒤 영상
    행을 추가한다. 봉인 해시는 항상 `[video_sha256, cover_sha256 or ""]`(순서
    고정, N=1 항등 분기를 안 탄다 — compute_image_seal_hash에 늘 2원소를 준다)."""
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    adapter = get_channel_adapter(draft.channel)
    if adapter is None or adapter.video_max_bytes <= 0:
        raise ChannelVideoUnsupportedError(channel=draft.channel)

    bucket = _require_bucket()
    expected_prefix = f"channel-media/{org_id}/{draft_id}/"
    if not object_path.startswith(expected_prefix) or "/" in object_path[len(expected_prefix):]:
        raise ChannelVideoPathNotScopedError(object_path=object_path)

    provider = get_storage_provider()
    size = await provider.head_object(bucket, object_path)
    if size is None:
        raise ChannelVideoObjectNotFoundError(object_path=object_path)

    # story #3589(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-06) — head_object가
    # 객체 존재를 확認한 뒤부터는, 아래 어떤 검증이든 거부(422)로 끝나면 그 객체가
    # 고아로 남는다(사람이 없앨 길 0). "용량 초과" 갈래(원래 위치) 하나에만 delete_
    # object가 있어 나머지(길이·비율·코덱·파싱 실패·이미지≥2)가 전부 샜다 — 갈래마다
    # 손으로 delete_object를 넣는 대신 이 구간 전체를 한 자리에서 감싸 갈래별 누락을
    # 구조적으로 없앤다. 삭제 자체가 실패해도 원래 거부 사유를 가리지 않는다(로그만
    # 남기고 원본 예외 그대로 재던짐).
    try:
        if size > adapter.video_max_bytes:
            raise ChannelVideoTooLargeError(size_bytes=size, max_bytes=adapter.video_max_bytes)

        raw = await provider.download_object(bucket, object_path)
        original_sha256 = hashlib.sha256(raw).hexdigest()

        metadata = parse_mp4_metadata(raw)

        if metadata.duration_seconds > adapter.video_max_seconds:
            raise ChannelVideoDurationExceededError(
                duration_seconds=metadata.duration_seconds, max_seconds=adapter.video_max_seconds,
            )
        if metadata.duration_seconds < adapter.video_min_seconds:
            raise ChannelVideoDurationTooShortError(
                duration_seconds=metadata.duration_seconds, min_seconds=adapter.video_min_seconds,
            )
        aspect_ratio = metadata.width / metadata.height
        if adapter.video_aspect_target > 0 and abs(aspect_ratio - adapter.video_aspect_target) > adapter.video_aspect_tolerance:
            raise ChannelVideoAspectRatioError(
                aspect_ratio=aspect_ratio, target=adapter.video_aspect_target, tolerance=adapter.video_aspect_tolerance,
            )
        if adapter.video_codecs and metadata.codec not in adapter.video_codecs:
            raise ChannelVideoCodecUnsupportedError(codec=metadata.codec, allowed=adapter.video_codecs)

        latest = (await db.execute(
            select(ChannelPostVersion)
            .where(ChannelPostVersion.draft_id == draft_id)
            .order_by(ChannelPostVersion.version.desc())
            .limit(1)
        )).scalar_one_or_none()
        if latest is None:
            raise ChannelPostDraftNotFoundError(draft_id)

        # story #3574(Phase2·BE·결함, 페드루 PO 確定 2026-09-06) — 트랜잭션(새 버전 생성)
        # 시작 前 명시 거부. 이미지 0·1장일 때만 아래 단수 캐리 로직에 도달한다(그 경우
        # 의미가 정확히 일치 — position=0 대표 1장=전체 1장).
        existing_images = await list_channel_post_images_for_version(db, version_id=latest.id)
        if len(existing_images) >= 2:
            raise ChannelVideoRequiresSingleCoverError()
    except Exception:
        try:
            await provider.delete_object(bucket, object_path)
        except Exception:
            logger.exception("영상 confirm 거부 후 GCS 객체 정리 실패 object_path=%s", object_path)
        raise

    existing_cover = await get_channel_post_image_for_version(db, version_id=latest.id)
    cover_sha256 = existing_cover.final_sha256 if existing_cover is not None else ""
    composite_sha256 = compute_image_seal_hash([original_sha256, cover_sha256])

    new_version, _channel, _violations = await create_channel_post_draft_version(
        db, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        text=latest.text, link_url=latest.link_url,
        author_member_id=member_id, author_kind=member_kind, image_sha256=composite_sha256,
    )

    if existing_cover is not None:
        db.add(_copy_image_row(existing_cover, new_version_id=new_version.id, new_position=existing_cover.position))

    video_row = ChannelPostVideo(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=new_version.id,
        original_object_path=object_path, original_sha256=original_sha256,
        original_content_type=_content_type_for_ext(object_path), original_bytes=size,
        duration_seconds=metadata.duration_seconds, width=metadata.width, height=metadata.height,
        codec=metadata.codec, created_by=member_id,
    )
    db.add(video_row)
    await db.commit()
    await db.refresh(video_row)
    return new_version, video_row


def _content_type_for_ext(object_path: str) -> str:
    for content_type, ext in _MIME_TO_EXT.items():
        if object_path.endswith(f".{ext}"):
            return content_type
    return "application/octet-stream"


async def get_channel_post_video_for_version(
    db: AsyncSession, *, version_id: uuid.UUID,
) -> ChannelPostVideo | None:
    return (await db.execute(
        select(ChannelPostVideo).where(ChannelPostVideo.version_id == version_id)
    )).scalar_one_or_none()


def _copy_video_row(existing: ChannelPostVideo, *, new_version_id: uuid.UUID) -> ChannelPostVideo:
    """channel_posts.py의 텍스트-편집 carry-forward·channel_post_images.py의
    커버 교체 두 곳이 공유하는 유일한 영상 행 복제 지점(`channel_post_images.py::
    _copy_image_row`와 동형 관례) — 재업로드·재파싱 없음, object_path·sha256·
    규격 메타 그대로 새 version_id로."""
    return ChannelPostVideo(
        id=uuid.uuid4(), org_id=existing.org_id, draft_id=existing.draft_id, version_id=new_version_id,
        original_object_path=existing.original_object_path, original_sha256=existing.original_sha256,
        original_content_type=existing.original_content_type, original_bytes=existing.original_bytes,
        duration_seconds=existing.duration_seconds, width=existing.width, height=existing.height,
        codec=existing.codec, created_by=existing.created_by,
    )
