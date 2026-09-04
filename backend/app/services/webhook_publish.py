"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) — `webhook`
(CHANNEL_ADAPTERS 등재, kind="blog") BlogDestinationAdapter 3호 구현체. `wordpress_
publish.py`(조각③b)와 이름은 같지만(publish/unpublish) **파라미터는 다르다** —
`blog_destinations.py::BlogDestinationModule` Protocol이 明示하듯 목적지마다 필요한
자격 형태가 다르다(WordPress=site_url+username+app_password, webhook=target_url+
shared secret 하나뿐 — 사용자명 개념이 없다).

서명 계약(정본 §4 확定 그대로) — `conversation_webhook.py::_sign_payload`와 동일한
HMAC-SHA256(다만 이 조각은 별도 함수로 재구현 — conversation_webhook.py를 import하면
webhook 발송이라는 무관한 도메인에 결합이 생긴다, 알고리즘만 재사용). 헤더 3종:
`X-Sprintable-Signature`(`sha256=` prefix)·`X-Sprintable-Timestamp`(unix seconds)·
`X-Sprintable-Nonce`(uuid4) — 서명 대상은 body 그 자체(timestamp·nonce는 헤더로만
동행, `_sign_payload` 계약 그대로 재사용). "허용 도메인"은 별도 화이트리스트 컬럼
불요 — 연결 등록 시 고객이 넣은 target_url 자체가 유일한 신뢰축(정본 明示) +
`destination_url_safety.py`(조각④ part A)가 그 URL을 「해석 시점」에 검증.

unpublish — webhook은 WordPress처럼 "그 글의 상태를 바꾸는" API가 없다(수신측이
우리가 정의한 계약 전부다). 회수는 같은 채널로 `event: "unpublish"`를 담은 별도 신호
POST로 표현한다(새 external_id 없음 — external_id는 최초 publish 응답의 값을 그대로
돌려준다는 계약, 아래 unpublish() 참고)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid

import httpx

from app.services.destination_url_safety import DestinationURLUnsafeError, assert_destination_url_safe

_SIGNATURE_HEADER = "X-Sprintable-Signature"
_TIMESTAMP_HEADER = "X-Sprintable-Timestamp"
_NONCE_HEADER = "X-Sprintable-Nonce"


def webhook_stub_enabled() -> bool:
    """story e4fc29fa(조각④) — wordpress_publish.py::wordpress_stub_enabled와 동형
    env 게이트(dev_webhook_stub.py의 loopback target_url 허용 조건)."""
    return os.environ.get("WEBHOOK_TEST_STUB_ENABLED", "").strip().lower() == "true"


class WebhookTargetURLInsecureError(ValueError):
    """target_url이 안전하지 않음(destination_url_safety.py 판정 그대로 감쌈) —
    wordpress_publish.py::WordPressSiteURLInsecureError와 동형 사상(모듈별 공개
    예외 타입은 유지, 검증 로직은 공용 헬퍼에 위임)."""

    def __init__(self, *, target_url: str):
        self.target_url = target_url
        super().__init__(f"webhook target_url이 안전하지 않습니다: {target_url!r}")


class WebhookPublishError(Exception):
    """수신측이 2xx 밖 응답을 줌 — status_code·응답 본문(길이 컷)을 실어 failure_kind
    분류에 쓴다(wordpress_publish.py::WordPressPublishError와 동형). 페드루 기록
    (조각③c PO 確定 코멘트) — 응답 본문을 통지 payload에 그대로 실으면 사이트 HTML
    전문이 딸려 나올 수 있어 여기서 앞부분만 자른다."""

    _BODY_MAX_CHARS = 500

    def __init__(self, *, status_code: int, body: str):
        self.status_code = status_code
        self.body = body[: self._BODY_MAX_CHARS]
        super().__init__(f"webhook 수신측 오류(status={status_code}): {self.body}")


def _sign(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


async def _validate_target(target_url: str) -> str:
    try:
        return await assert_destination_url_safe(target_url, allow_loopback=webhook_stub_enabled())
    except DestinationURLUnsafeError as exc:
        raise WebhookTargetURLInsecureError(target_url=target_url) from exc


def _headers_for(secret: str, body: bytes) -> dict[str, str]:
    return {
        _SIGNATURE_HEADER: _sign(secret, body),
        _TIMESTAMP_HEADER: str(int(time.time())),
        _NONCE_HEADER: str(uuid.uuid4()),
        "Content-Type": "application/json",
    }


async def publish(
    client: httpx.AsyncClient,
    *,
    target_url: str,
    secret: str,
    title: str,
    body_md: str,
    summary: str,
    tags: list,
    slug: str,
    external_id: str | None = None,
) -> tuple[str, str]:
    """서명된 POST 1건 — WordPress처럼 "생성/갱신" 구분이 수신측 REST 리소스 개념에
    안 걸린다(우리가 패키지를 보내고, 수신측이 자기 방식대로 처리한다는 계약). 반환은
    (external_id, permalink) — 수신측 응답 본문에 `external_id`/`url`이 있으면
    그대로 쓰고, 없으면 `external_id`는 이 발행이 쓴 `slug`(재발행 식별용 안정 키),
    `permalink`는 None(수신측이 URL 개념을 안 줄 수도 있다 — 지어내지 않는다)."""
    base = await _validate_target(target_url)
    payload = {
        "event": "publish", "title": title, "body_md": body_md, "summary": summary,
        "tags": tags, "slug": slug, "external_id": external_id,
    }
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    resp = await client.post(base, content=body, headers=_headers_for(secret, body), timeout=20)
    if resp.status_code // 100 != 2:
        raise WebhookPublishError(status_code=resp.status_code, body=resp.text)
    data: dict = {}
    try:
        data = resp.json()
    except ValueError:
        pass
    return str(data.get("external_id") or external_id or slug), data.get("url")


async def unpublish(
    client: httpx.AsyncClient, *, target_url: str, secret: str, external_id: str,
) -> None:
    """WordPress의 status=draft 전환과 동형 의도(비파괴 회수 신호) — webhook엔 그
    "상태"를 물을 리소스가 없어 `event: "unpublish"` 신호 POST로 표현한다(수신측이
    자기 로직으로 해석)."""
    base = await _validate_target(target_url)
    payload = {"event": "unpublish", "external_id": external_id}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    resp = await client.post(base, content=body, headers=_headers_for(secret, body), timeout=20)
    if resp.status_code // 100 != 2:
        raise WebhookPublishError(status_code=resp.status_code, body=resp.text)
