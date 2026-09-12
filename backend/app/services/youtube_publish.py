"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — YouTube Data API v3
resumable 업로드 클라이언트. `threads_publish.py::ThreadsPublishError`를 그대로
재사용한다(신규 예외 클래스 0 — x_publish.py 선례와 동형: `channel_posts.py`
오케스트레이션의 모든 `except ThreadsPublishError` 지점·error_code 매핑을 그대로
물려받는다).

## `create_reels_container`/`get_container_status`/`publish_container` 매핑
YouTube의 `videos.insert`는 **단일 호출로 이미 발행까지 끝난다**(Meta의 create→
publish 2단과 다른 자리 — privacyStatus를 insert 시점에 이미 지정하므로 별도
"publish" API가 없다). 그래도 기존 5(6)-함수 파사드에 맞춰 스스로 접는다(신규
오케스트레이션 로직 0, x_publish.py가 X의 무-컨테이너 API를 접은 것과 동형):
- `create_reels_container`가 실제로 resumable 업로드 세션을 열고 영상을 다
  보내 YouTube 비디오 리소스를 만든다(creation_id=video id 그 자체, JSON 봉투
  불요 — X처럼 두 호출 사이에 들고 다닐 상태가 없다).
- `get_container_status`가 `videos.list(part=status)`로 `uploadStatus`를 확認
  (processing이면 IN_PROGRESS — channel_posts.py의 5분 폴링 상한 재사용).
- `publish_container`는 이미 끝난 일을 확인만 하는 근사 no-op(creation_id를
  그대로 반환) — "진짜 발행 순간"이 insert 그 시점이었기 때문.

## 감사 미완=강제 비공개(페드루 PO 決定②, 2026-09-12 10:46Z)
`settings.youtube_api_audit_incomplete=True`(fail-closed 기본)면 요청된
privacyStatus와 무관하게 `videos.insert`에 항상 `privacyStatus="private"`를
싣는다 — 우리 GCP 프로젝트의 API 등급(고객 자격 아님, `app/core/config.py`
상단 딱지 참고)이라 연결(ChannelConnection.status) 축과는 별개다(페드루 明示
④ — 연결 status 4값 무변, 이 잠금은 그 밖의 별도 사실).

⚠️미확認(threads_oauth.py/x_oauth.py 상단 딱지와 동형 원칙, 착수 시 재확認
필요) — resumable 업로드 세션 프로토콜의 정확한 요청/응답 헤더명(`X-Upload-
Content-Length` 등)·videos.insert 응답 스키마·`uploadStatus` enum 값
(uploaded/processed/rejected/failed 등)은 지식 컷오프(2026-01) 기준 최선
추정이다. 실 앱 왕복 전까지 "코드는 정확한 형태로 존재하되 라이브 미검증"
상태로 남는다. 챕터(description 안 MM:SS 타임스탬프) 형식 요건은 PR1
그라운딩에서 이미 "API 필드 아님(클라이언트 관례)"으로 확認됐고, 정확한
줄 수·최소 길이 요건은 여전히 ⚠️미확認이라 이 파일은 그 형식을 검증하지
않는다(지어내지 않는다, 페드루 明示③)."""
from __future__ import annotations

import httpx

from app.services.threads_publish import ThreadsPublishError
from app.services.youtube_privacy import resolve_youtube_privacy_lock

_UPLOAD_INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

_GENEROUS_QUOTA_USAGE = 0
_GENEROUS_QUOTA_TOTAL = 10_000
_GENEROUS_QUOTA_DURATION_SECONDS = 86_400


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def _error_from_response(code: str, resp: httpx.Response) -> ThreadsPublishError:
    """x_publish.py::_error_from_response와 동형 — YouTube 오류 envelope도 Meta
    Graph 형이 아니라(`{"error": {"errors": [...], "code": ..., "message": ...}}`)
    Meta 파서 관할 밖이라 provider_error_* 3필드는 None."""
    return ThreadsPublishError(code, resp.text[:500], status_code=resp.status_code)


async def _initiate_resumable_session(
    client: httpx.AsyncClient, *, access_token: str, video_bytes: bytes, mime_type: str,
    title: str, description: str, tags: list[str], category_id: str | None, privacy_status: str,
) -> str:
    """resumable 업로드 세션 열기 — 성공하면 `Location` 헤더(청크 PUT 대상 URL)를
    낸다. ⚠️미확認 — 정확한 요청 헤더/바디 형태는 모듈 상단 딱지 참고."""
    snippet: dict = {"title": title, "description": description}
    if tags:
        snippet["tags"] = tags
    if category_id is not None:
        snippet["categoryId"] = category_id
    resp = await client.post(
        _UPLOAD_INIT_URL,
        params={"uploadType": "resumable", "part": "snippet,status"},
        json={"snippet": snippet, "status": {"privacyStatus": privacy_status}},
        headers={
            **_auth_headers(access_token),
            "X-Upload-Content-Length": str(len(video_bytes)),
            "X-Upload-Content-Type": mime_type,
        },
    )
    if resp.status_code not in (200, 201):
        raise _error_from_response("YOUTUBE_UPLOAD_SESSION_INIT_FAILED", resp)
    session_url = resp.headers.get("Location")
    if not session_url:
        raise ThreadsPublishError(
            "YOUTUBE_UPLOAD_SESSION_MISSING_LOCATION", "Location header missing in response",
            status_code=resp.status_code,
        )
    return session_url


async def _put_video_bytes(
    client: httpx.AsyncClient, *, session_url: str, video_bytes: bytes, mime_type: str,
) -> dict:
    """단일 PUT(재시도 1회 — 첫 시도가 실패하면 세션 진행 상황을 `Content-Range:
    bytes */{total}` 조회 없이 그냥 처음부터 한 번 더 보낸다, 대용량 다중-청크
    분할은 이 카드 범위 밖으로 남긴다 — 모듈 상단 딱지 "청크 PUT" 참고, 후속
    개선 대상). 성공하면 최종 video 리소스 JSON을 낸다."""
    last_exc: ThreadsPublishError | None = None
    for _attempt in range(2):
        resp = await client.put(
            session_url, content=video_bytes,
            headers={"Content-Type": mime_type, "Content-Length": str(len(video_bytes))},
        )
        if resp.status_code in (200, 201):
            return resp.json()
        last_exc = _error_from_response("YOUTUBE_UPLOAD_PUT_FAILED", resp)
    assert last_exc is not None
    raise last_exc


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """발견 즉시 수정(PR2 CHANGES② 대응 중 자체 발견) — `channel_posts.py:1711`이
    `_publish_client.create_container`를 has_video 값과 무관하게 무조건
    속성-접근한다(video_required=True 전용 채널을 처음 만나며 드러난 기존
    가정 — Reels 등 기존 영상-지원 채널은 전부 이미지도 같이 지원해 이
    함수가 항상 존재했다). YouTube는 이미지 컨테이너 개념 자체가 없어 호출
    되면 안 되는 경로 — fail-closed로 명시 실패(조용한 500 대신)."""
    raise ThreadsPublishError(
        "YOUTUBE_IMAGE_CONTAINER_UNSUPPORTED",
        "YouTube publish-client has no image container concept (video_required=True channel) — "
        "create_container should never be called; has_video detection may be broken.",
        status_code=500,
    )


async def create_reels_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    video_url: str, cover_url: str | None = None, channel_payload: dict | None = None,
) -> str:
    """`channel_posts.py`의 `has_video` 분기 진입점(image_max_count=0류 관례로
    다른 릴스 채널과 같은 함수명 재사용). `text`=video description(재그라운딩
    정정, PR 본문 참고) · `channel_payload`={title, tags, categoryId,
    privacyStatus} — `_validate_youtube_metadata`가 이미 발행 直前 재검사를
    끝낸 값이라 여기서 재검증하지 않는다. `cover_url`(썸네일)은 이 PR 범위
    밖 — YouTube 자동 생성 썸네일에 맡긴다(⚠️갭, 후속)."""
    payload = channel_payload or {}
    video_resp = await client.get(video_url)
    if video_resp.status_code != 200:
        raise ThreadsPublishError(
            "YOUTUBE_VIDEO_SOURCE_FETCH_FAILED", f"video_url fetch failed: {video_resp.status_code}",
            status_code=502,
        )
    mime_type = video_resp.headers.get("content-type", "video/mp4")
    privacy_status, _privacy_locked = resolve_youtube_privacy_lock(
        requested_privacy_status=payload.get("privacyStatus"), text=text,
    )
    session_url = await _initiate_resumable_session(
        client, access_token=access_token, video_bytes=video_resp.content, mime_type=mime_type,
        title=payload.get("title", ""), description=text, tags=list(payload.get("tags") or []),
        category_id=payload.get("categoryId"), privacy_status=privacy_status,
    )
    video_resource = await _put_video_bytes(
        client, session_url=session_url, video_bytes=video_resp.content, mime_type=mime_type,
    )
    video_id = video_resource.get("id")
    if not video_id:
        raise ThreadsPublishError(
            "YOUTUBE_UPLOAD_MISSING_VIDEO_ID", "id missing in videos.insert response", status_code=200,
        )
    return str(video_id)


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    """`videos.list(part=status)` — `uploadStatus`를 threads_publish.py 어휘
    (IN_PROGRESS/FINISHED/ERROR)로 옮긴다. ⚠️미확認 — 정확한 enum 값은 모듈
    상단 딱지 참고."""
    resp = await client.get(
        _VIDEOS_URL, params={"part": "status", "id": creation_id}, headers=_auth_headers(access_token),
    )
    if resp.status_code != 200:
        raise _error_from_response("YOUTUBE_VIDEO_STATUS_FAILED", resp)
    items = resp.json().get("items") or []
    if not items:
        return "ERROR", "video resource not found (videos.list returned no items)"
    upload_status = ((items[0].get("status") or {}).get("uploadStatus"))
    if upload_status == "processed":
        return "FINISHED", None
    if upload_status in ("rejected", "failed"):
        failure_reason = (items[0].get("status") or {}).get("failureReason")
        return "ERROR", failure_reason or f"uploadStatus={upload_status}"
    return "IN_PROGRESS", None  # "uploaded"(트랜스코딩 대기) 등 그 외 전부.


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    """모듈 상단 딱지 — videos.insert 시점에 이미 발행이 끝나 있어 이 함수는
    creation_id(=video id)를 그대로 확정할 뿐(신규 API 호출 0, x_publish.py의
    "posted" 지름길과 동형 사상)."""
    return creation_id


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    """watch URL은 video id만으로 결정적으로 구성된다(공개 문서 안정 사실) — X의
    permalink 조회(별도 API 필요)와 다른 자리, HTTP 호출 0."""
    return f"https://www.youtube.com/watch?v={media_id}"


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    """x_publish.py와 동형 — 연결별 사전조회 quota 엔드포인트가 없다(YouTube의
    실 quota는 프로젝트 전체 축이라 `youtube_quota.py`가 별도로 담당, 이 함수는
    항상 여유 있는 고정값)."""
    return _GENEROUS_QUOTA_USAGE, _GENEROUS_QUOTA_TOTAL, _GENEROUS_QUOTA_DURATION_SECONDS
