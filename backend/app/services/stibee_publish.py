"""story #3813(Phase3·3-4 PR5-b, 페드루 PO 確定 2026-09-12) — 실 Stibee 발행(=ESP
캠페인 생성, 발송 아님) 클라이언트. `stibee_sandbox_publish.py`와 정확히 같은
5-함수 파사드 시그니처(x_sandbox_publish.py류와 동형 설계 계약) — 이 파일이
「실 stibee(진짜 Stibee HTTP 클라이언트)는 이 PR 범위 밖」 딱지가 붙어 있던 자리를
채운다(story 3-4 PR2 stibee_sandbox_publish.py docstring 참고).

캠페인 생성은 3콜(`create_container` 안에서 전부 처리): `create_email`(메타) →
`set_content`(원시 HTML) — `publish_container`는 sandbox와 동형으로 no-op(스티비는
Meta류 비동기 미디어 처리 개념이 없어 create 시점에 이미 끝난다). `reserve`(발송
예약)는 이 파사드 밖 — newsletter_send_execution.py가 별도 명령(OP_SEND)에서
`stibee_client.reserve_email`을 직접 부른다(stibee_sandbox_campaign.send_campaign과
동형 축, 발행≠발송 시각 구분 그대로).

`threads_user_id` 파라미터명은 dispatcher 공용 계약 그대로(sandbox와 동형 — 실제로는
stibee 발신자 식별자 개념이 없다, connection.account_id="default" 고정)."""
from __future__ import annotations

import httpx

from app.services.stibee_client import StibeeApiError, create_email, set_content
from app.services.threads_publish import ThreadsPublishError


def _wrap(exc: StibeeApiError) -> ThreadsPublishError:
    """`_classify_threads_error`(channel_posts.py)가 요금제·발신자 미인증을 정확한
    코드로 갈라 처리하도록 `.code`에 그 판정을 그대로 싣는다(둘 다 400이라 status_
    code만으론 구분이 안 된다, 그라운딩 정정)."""
    if exc.is_plan_restricted:
        code = "STIBEE_PLAN_RESTRICTED"
    elif exc.is_sender_not_verified:
        code = "STIBEE_SENDER_NOT_VERIFIED"
    else:
        code = "STIBEE_PUBLISH_PROVIDER_ERROR"
    return ThreadsPublishError(code, str(exc), status_code=exc.status_code or 502)


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None, subject: str | None = None, list_id: str | None = None,
    sender_email: str | None = None, sender_name: str | None = None,
) -> str:
    """ESP 캠페인 생성 — `POST /emails`(메타) → `POST /emails/{id}/content`(원시
    HTML, `text`를 그대로 감싼다). `subject`·`list_id`·`sender_email`·`sender_name`
    은 channel_posts.py 오케스트레이터가 stibee 전용 분기에서만 채우는 kwarg
    (subject의 기존 관례와 동형 — 다른 채널 시그니처 무변경)."""
    if not subject or not list_id or not sender_email or not sender_name:
        from app.services.i18n_catalog import t

        raise ThreadsPublishError(
            "STIBEE_CONNECTION_INCOMPLETE",
            t("stibee_publish.connection_incomplete", "ko"),
            status_code=422,
        )
    try:
        email_id = await create_email(
            client, api_key=access_token, subject=subject, sender_email=sender_email,
            sender_name=sender_name, list_id=list_id,
        )
        # story #3813 — 채널 포스트 본문은 CMS 공용 평문 필드(latest.text)를 그대로
        # 재사용한다(신규 컬럼 0) — 줄바꿈만 <br>로 보존해 최소한의 가독 HTML로
        # 감싼다(마크다운 렌더링 등 콘텐츠 저작 기능은 이 스토리 범위 밖).
        html = "<html><body>" + _escape_html(text).replace("\n", "<br>") + "</body></html>"
        await set_content(client, api_key=access_token, email_id=email_id, html=html)
    except StibeeApiError as exc:
        raise _wrap(exc) from exc
    return str(email_id)


def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    """스티비 캠페인 생성은 동기(create_container가 이미 끝냄) — 폴링할 비동기
    상태가 없다, sandbox와 동형으로 항상 완료."""
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    """no-op(create_container가 이미 캠페인을 만들었다) — sandbox와 동형 판단.
    「발행」은 여기까지(ESP 캠페인 생성) — 실 수신자 「발송」은 newsletter_send
    게이트 승인 뒤 별도 명령(OP_SEND, newsletter_send_execution.py) 몫."""
    return creation_id


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    """⚠️미확認(그라운딩 범위 밖, PO 6-항목에 없음) — 스티비 캠페인 퍼머링크 조회는
    이 PR이 짓지 않는다. None이 "모른다"의 정직한 표현(지어내지 않는다, sandbox의
    가짜 URL과 달리 실물은 없으면 없다고 말한다)."""
    return None


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    """스티비에 Meta류 "일일 발행 한도" 개념이 있다는 근거를 못 찾았다(그라운딩
    범위 밖) — 이 검사 자체를 사실상 no-op으로 만드는 매우 낙낙한 값을 낸다
    (usage=0, total을 크게 잡아 `quota_usage >= quota_total`이 실질적으로 절대
    걸리지 않게). 실제 요청 빈도 상한(1000/분, 별도 축)은 이 함수가 아니라
    `stibee_client.fetch_send_result`의 429 백오프가 담당한다."""
    return 0, 1_000_000, 60
