"""story 5b27b32f(Phase1·BE·테스트 인프라, 페드루 PO 확定 2026-09-04) — dev 전용 샌드박스
채널 발행 클라이언트. `threads_publish.py`(Threads 실 provider)와 **정확히 같은 함수
시그니처**를 가진 결정적 가짜 provider — `channel_adapters.py::get_publish_client_module`
이 `draft.channel == "sandbox"`일 때만 threads_publish 대신 이 모듈을 골라 쓴다(오케스트
레이션(channel_posts.py)은 어느 쪽이 골렸는지 모른다, 신규 판정 로직 0). Threads 어댑터
코드는 이 스토리에서 한 글자도 안 건드린다.

**결정적·상태 없음(stateless)** — 이 클라이언트는 실 HTTP 호출을 전혀 하지 않는다
(`client`/`access_token` 인자는 시그니처 정합을 위해서만 받고 안 쓴다). 여러 Cloud Run
인스턴스가 같은 creation_id를 나중에 다시 물어봐도(폴링 tick마다 다른 인스턴스가 받을 수
있다) 같은 답을 내야 하므로, 필요한 모든 상태(폴링 완료 시각·에러 모드)를 서버 메모리가
아니라 **`creation_id` 문자열 자체**에 인코딩한다(`sandbox:{mode}:{ready_at_epoch}:
{uuid}` — 방식은 story #3383류 stateless-encoding 관례와 동형).

## 본문 마커(story 본문 AC3, 정본) — `create_container`가 받는 `text`에서만 읽는다
(publish_container/get_container_status/delete_media는 원문을 다시 안 받으므로, 이
마커들이 결정하는 행동은 전부 `create_container`가 만드는 creation_id 인코딩 또는
`create_container` 자신의 즉시 예외로 표현된다):

- (마커 없음) — 기본 성공. 컨테이너는 즉시 FINISHED, permalink는
  `https://sandbox.invalid/{media_id}`.
- `[sandbox:429]` — `create_container`가 즉시 429로 실패(Threads 한도 초과 시뮬레이션).
  channel_posts.py::_classify_threads_error의 신규 429 분기(이 스토리에서 추가, Threads
  실 provider가 create_container 단계에서 429를 낼 가능성에도 마찬가지로 유효한 일반
  개선)가 `ChannelRateLimitedError`로 승격한다.
- `[sandbox:provider-error]` — `create_container`가 502로 실패(미분류 provider 오류
  시뮬레이션, 기존 _classify_threads_error가 이미 CHANNEL_PUBLISH_PROVIDER_ERROR로
  분류).
- `[sandbox:expired-token]` — `create_container`가 401로 실패(기존 _classify_threads_
  error가 이미 CHANNEL_TOKEN_EXPIRED로 분류).
- `[sandbox:container-error]` — 컨테이너 생성 자체는 성공하지만, 폴링(get_container_
  status)이 ERROR를 낸다(AC3 "컨테이너 ERROR"). ⚠️**이미지 첨부 초안 전용** — 오케스트
  레이션(channel_posts.py::publish_channel_post_draft)이 `has_image`일 때만 폴링을
  타므로(story 620beefc AC5), 이미지 없는 TEXT 초안에서는 create_container가 이 마커를
  creation_id에 인코딩해도 아무도 안 읽어 즉시 published로 끝난다(마커가 조용히
  inert — 결함 아님, 발행 오케스트레이션의 기존 분기 구조).
- `[sandbox:container-slow]` — 컨테이너가 즉시 안 끝나고 `_CONTAINER_SLOW_DELAY_SECONDS`
  뒤에야 FINISHED로 전환된다(AC3 "container IN_PROGRESS→FINISHED 2 tick" — 발행 오케스트
  레이션의 최초 30초 대기+이후 폴링 주기를 감안해 첫 poll엔 아직 IN_PROGRESS, 두 번째
  poll에서 FINISHED가 나오게 지연을 잡았다). ⚠️위와 동일하게 **이미지 첨부 초안 전용**.

마커는 서로 배타적으로 다루지 않는다(먼저 매치되는 것을 그대로 적용) — 실패 마커 3종은
텍스트 안 어디에든, 컨테이너 마커 2종과 자유롭게 조합 가능(단, 컨테이너 마커 2종은
이미지 첨부 초안에서만 의미 있음, 위 참고)."""
from __future__ import annotations

import time
import uuid

import httpx

from app.services.threads_publish import ThreadsPublishError

_MARKER_429 = "[sandbox:429]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_EXPIRED_TOKEN = "[sandbox:expired-token]"
_MARKER_CONTAINER_ERROR = "[sandbox:container-error]"
_MARKER_CONTAINER_SLOW = "[sandbox:container-slow]"

# story 5b27b32f — cron 워커의 발행 오케스트레이션(channel_posts.py)은 컨테이너 생성 직후
# 곧바로 폴링하지 않고(Meta 권장 30초 대기, story 620beefc B3) 그 다음 tick부터 폴링한다.
# 40초로 잡으면: 최초 폴링(≈30초 후)엔 아직 IN_PROGRESS, 두 번째 폴링(≈60초 후)엔 FINISHED
# — AC3 "2 tick"을 실측 오케스트레이션 타이밍과 어긋나지 않게 재현한다.
_CONTAINER_SLOW_DELAY_SECONDS = 40


def _encode_creation_id(*, mode: str, ready_at_epoch: int) -> str:
    return f"sandbox:{mode}:{ready_at_epoch}:{uuid.uuid4().hex}"


def _decode_creation_id(creation_id: str) -> tuple[str, int]:
    """(mode, ready_at_epoch). 형식이 어긋나면(외부에서 만든 값 등) 방어적으로 즉시
    FINISHED 취급 — 샌드박스가 알 수 없는 입력에 영원히 멈춰 있는 것보다 낫다."""
    parts = creation_id.split(":")
    if len(parts) != 4 or parts[0] != "sandbox" or parts[1] not in ("ok", "error"):
        return "ok", 0
    try:
        return parts[1], int(parts[2])
    except ValueError:
        return "ok", 0


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_RATE_LIMITED", "sandbox: [sandbox:429] 마커 시뮬레이션", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] 마커 시뮬레이션", status_code=401,
        )

    mode = "error" if _MARKER_CONTAINER_ERROR in text else "ok"
    delay = _CONTAINER_SLOW_DELAY_SECONDS if _MARKER_CONTAINER_SLOW in text else 0
    return _encode_creation_id(mode=mode, ready_at_epoch=int(time.time()) + delay)


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    mode, ready_at_epoch = _decode_creation_id(creation_id)
    if time.time() < ready_at_epoch:
        return "IN_PROGRESS", None
    if mode == "error":
        return "ERROR", "SANDBOX_SIMULATED_CONTAINER_ERROR"
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    # 여기 도달했다는 것 자체가 오케스트레이션이 이미 FINISHED를 확인했다는 뜻(AC3
    # "기본 성공") — media_id는 새 uuid4(진짜 미디어처럼 creation_id와 다른 값).
    return f"sandbox-media-{uuid.uuid4().hex}"


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    # 항상 넉넉한 잔량 — 429 시뮬레이션은 create_container 마커로만 유발한다(모듈 상단
    # docstring 참고 — 이 함수는 text를 못 받아 마커를 볼 수 없다).
    return 0, 100, 3600


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return f"https://sandbox.invalid/{media_id}"


async def delete_media(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> None:
    # AC3 "기본 성공" — 회수(unpublish) 실패 시뮬레이션은 이 스토리 스코프 밖으로 명시
    # 배제(story 본문 마커 목록에 unpublish용 마커가 없다).
    return None


# story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 조회/답변. 결정적
# (media_id 하나에 항상 같은 2건) — "삭제됨" 상태 재현은 이 함수 자체가 흉내내지 않는다
# (media_id만 받아 텍스트 마커 채널이 없다). 대신 이 파일의 어느 함수도 서버 메모리를
# 안 쓰는 설계 그대로 유지하고, 수집 서비스(channel_post_comments.py)가 "이전엔 잡혔는데
# 이번 fetch엔 없다"를 diff로 판정해 soft-delete한다(테스트는 두 번째 호출을
# monkeypatch로 comment 하나 뺀 리스트로 바꿔 이 경로를 재현한다) — 일반적인 리컨실
# 로직이라 sandbox뿐 아니라 실 Threads 응답에도 그대로 먹힌다.
def _deterministic_comment(*, media_id: str, index: int) -> dict:
    seed = int(uuid.uuid5(uuid.NAMESPACE_URL, f"{media_id}:{index}").hex[:8], 16)
    return {
        "id": f"sandbox-comment-{media_id}-{index}",
        "text": f"샌드박스 댓글 {index}(seed={seed % 1000})",
        "username": f"sandbox_user_{index}",
        "timestamp": "2026-09-05T00:00:00+00:00",
    }


async def fetch_replies(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> tuple[list[dict], bool]:
    """AC(조각①) "기본 2건" — media_id 하나엔 항상 같은 2건(순서도 고정, 테스트가
    인덱스로 단언 가능). 페드루 PO REQUIRED(2026-09-05, PR#3865 리뷰) — threads가
    커서 상한에 걸리면 `complete=False`를 낼 수 있어 `(items, complete)` 튜플
    계약으로 통일했다. sandbox는 언제나 2건 전체를 한 번에 주니 `complete=True`
    고정(페이지네이션 개념 자체가 없다)."""
    return [_deterministic_comment(media_id=media_id, index=i) for i in (1, 2)], True


async def reply(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, reply_to_id: str, text: str,
) -> tuple[str, str | None]:
    """조각①은 write 0(선언만) — 이 함수는 조각②가 실제로 호출한다. 시그니처를 지금
    확정해 두는 이유는 `get_publish_client_module` 디스패치가 이미 이 모듈을 아는
    채로 조각② 코드가 바로 얹히게(신규 디스패치 로직 0)."""
    return f"sandbox-reply-{uuid.uuid4().hex}", f"https://sandbox.invalid/reply/{reply_to_id}"
