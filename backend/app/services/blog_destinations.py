"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③a) — 블로그
목적지(BlogDestinationModule) 디스패치. `site_post_drafts.connection_id`가 null이면
hosted_site(내부 저장, credential 불요) — null이 아니면 그 connection이 가리키는
채널(wordpress/webhook, 조각③b·④)로 나간다.

`channel_adapters.py::get_publish_client_module`(social 채널 Threads/sandbox 전용
디스패치)의 블로그판 — 같은 얕은-디스패치 사상(라우팅만 여기, 실 발행 로직은 각
채널 모듈)이지만 별도 파일로 연다(social/blog는 페이로드 형태 자체가 다른 계열이라
그라운딩 결론대로 억지로 한 레지스트리에 안 욱여넣는다)."""
from __future__ import annotations

import uuid
from typing import Awaitable, Callable, Protocol


class BlogDestinationModule(Protocol):
    """publish/unpublish 두 async callable을 갖는 모듈의 최소 형 — `hosted_site_
    publish.py`가 1호 구현체, `wordpress_publish.py`/`webhook_publish.py`(조각③b·④)가
    같은 이름으로 이어붙는다. 실제 파라미터는 목적지마다 다르다(hosted_site는
    db+필드값, wordpress/webhook은 httpx client+credentials가 더 필요) — Protocol은
    "publish/unpublish라는 이름의 async callable 둘을 갖는다"는 최소 계약만 강제한다."""

    publish: Callable[..., Awaitable[object]]
    unpublish: Callable[..., Awaitable[object]]


class BlogDestinationNotImplementedError(NotImplementedError):
    """story e4fc29fa(조각③a) — connection_id가 non-null인 블로그 목적지(wordpress/
    webhook)는 조각③b·④에서 실제로 배선된다. 그 전까지 명시 거부(fail-closed) —
    존재하지 않는 목적지로 조용히 발행을 시도하는 경로를 원천 차단한다(channel_
    adapters.py::BlogChannelDispatchNotImplementedError와 동형 사상)."""

    def __init__(self, *, connection_id: uuid.UUID):
        self.connection_id = connection_id
        super().__init__(
            f"connection_id={connection_id!r} 블로그 목적지는 아직 배선되지 않았습니다"
            "(wordpress=조각③b·webhook=조각④에서 배선 예정)."
        )


def get_blog_destination_module(
    *, connection_id: uuid.UUID | None, channel: str | None = None,
) -> BlogDestinationModule:
    """connection_id=None → hosted_site_publish(항상 사용 가능, credential 불요).
    non-null이면 그 connection이 가리키는 `channel`로 실 모듈을 고른다(호출자가 이미
    connection 행을 읽어야 credential을 꺼낼 수 있어 여기선 DB 재조회 없이 channel
    문자열만 받는다 — channel_adapters.py::get_publish_client_module(channel: str)과
    같은 사상). wordpress=조각③b·webhook=조각④(이 조각에서 배선) — 그 외는 fail-closed."""
    if connection_id is None:
        from app.services import hosted_site_publish
        return hosted_site_publish
    if channel == "wordpress":
        from app.services import wordpress_publish
        return wordpress_publish
    if channel == "webhook":
        from app.services import webhook_publish
        return webhook_publish
    raise BlogDestinationNotImplementedError(connection_id=connection_id)
