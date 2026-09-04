"""story #3373(Phase1·마케팅운영) — 채널별 OAuth/갱신 성질 선언. `app/routers/auth.py::
_OAUTH_CONFIGS`(provider별 authorize_url/scope dict)와 동형 관례 — 새 설정 패턴을 발명하지
않는다.

페드루 PO 확定(2026-09-03 07:09Z, 유나 화면설계 v2 대조) — "자동 갱신 가능 여부"는
`encrypted_refresh_token` 컬럼의 NULL 여부로 **파생하면 틀린다**(Threads는 refresh_token
없이 기존 access_token으로 재발급하는데도 자동 갱신 가능·WordPress 앱 비밀번호는 애초에
만료가 없다) — 채널의 성질이라 여기 선언하고 목록 API가 그대로 노출한다(`can_auto_refresh`).

Phase1은 Threads 1개만 구현한다(범위 밖: Instagram/Facebook/X/WordPress 등 — 그라운딩
§5·story 본문 명시). 다른 채널을 여는 스토리는 이 dict에 항목만 추가하면 된다(라우터·cron·
암호화 로직은 채널 무관 공용)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ChannelAdapterConfig:
    authorize_url: str
    token_url: str
    scope: str
    # "refresh_token"(표준 grant) | "reissue_from_access_token"(Threads류 — 현재 유효한
    # access_token으로 재발급, refresh_token 불요) | "manual"(자동 갱신 불가 — 재인증 유도).
    refresh_mode: str
    # story f30da19a(Phase1·FE, PO 확定 2026-09-04) — 「연결 만들기」 버튼 라벨(FE는
    # 하드코딩 X, `GET .../channel-connections/available-channels`가 이 값을 그대로
    # 노출). 채널의 성질이라 여기 한 곳에 선언(max_text_length·can_auto_refresh와 동형
    # 관례). 페드루 리뷰 N1(2026-09-04) — 기본값 ""를 제거해 필수 인자로: 라벨 없는
    # 어댑터를 등재하면 그 즉시(import 시점) TypeError로 죽는다 — 화면에 빈 버튼이
    # 뜨는 대신 배포 자체가 안 되게(fail-closed, 다른 필수 필드 authorize_url/token_url/
    # scope/refresh_mode와 동열).
    display_name: str
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 이 채널이 짧은 글
    # (channel_post·Threads류)인지 블로그(site_post·hosted_site/wordpress/webhook류)
    # 인지. available-channels가 이 값을 그대로 노출해 FE가 "채널 연결"과 "블로그 목적지"
    # 화면을 분기한다(kind 자체가 SSOT — 문자열 목록을 어디서도 하드코딩하지 않는다).
    kind: Literal["social", "blog"] = "social"
    # story e4fc29fa(페드루 PO 리뷰 B1, 2026-09-04) — available-channels는 "연결 만들기"
    # 버튼 목록이다(그 엔드포인트 자체 목적). credential_kind="none"을 FE(#3435 AC2)가
    # 곧바로 "샌드박스 연결 만들기 버튼"으로 읽는다 — hosted_site도 credential_kind="none"
    # 이라 그 목록에 그냥 나열되면 FE가 hosted_site에 대해 **샌드박스 연결을 만드는**
    # 잘못된 액션을 탄다. "연결할 게 있는가"와 "credential이 필요한가"는 다른 축이라
    # 별도 필드로 분리한다 — hosted_site만 False, 나머지(sandbox 포함)는 기본 True.
    requires_connection: bool = True
    credential_kind: str = "oauth"  # "oauth" | "pasted_secret" | "none"
    # story #3374(Phase1·마케팅운영, PO 결정) — 채널 포스트 초안 text 상한. 상수를 서비스/
    # 라우터에 하드코딩하지 않고 여기 한 곳에 선언(담롱 요구 — "상수 하드코딩 X·선언·표시",
    # 초안 저장 422 응답에 이 값을 그대로 실어 보낸다).
    max_text_length: int = 0
    # story #f8f7cb0f(Phase1·마케팅운영, PO 결정) — UTM 자동 부착 source/medium(campaign은
    # 대상 글마다 달라 여기 선언 대상이 아니다, app/services/utm.py::resolve_utm_campaign).
    utm_source: str = ""
    utm_medium: str = ""
    # story #3419(Phase1·마케팅운영, PO 결정 2026-09-04) — 발행된 글을 채널에서 회수(삭제
    # API 호출) 가능한지. max_text_length·can_auto_refresh와 동형 관례(채널의 성질을 여기
    # 선언하고 목록 API가 그대로 노출 → FE가 버튼 렌더 여부를 판단, 신규 판정 로직 불요).
    supports_unpublish: bool = False
    # 회수를 실제로 실행하려면 연결이 이 스코프를 갖고 있어야 한다(None=이 어댑터는 스코프
    # 요구 없음 — supports_unpublish=False면 애초에 의미 없는 값). `ChannelConnection.scopes`
    # 는 연결 시점에 이 어댑터의 `scope` 문자열을 그대로 저장한 값이다(그라운딩 확認 —
    # Threads 토큰 교환 응답에 별도 "실제 부여된 스코프" 필드가 없어, 이 코드베이스 기존
    # 관례(`channel_connections.py::channel_connection_callback`)가 이미 "요청한 스코프"를
    # "이 연결의 스코프"로 기록해 왔다 — 새 컬럼·새 메커니즘 불요, 이 필드를 `scope`에 포함시
    # 키기만 하면 기존 저장 경로가 그대로 반영한다. 기존 연결은 이 값 없이 저장돼 있어
    # 자동으로 "부족"으로 판정된다 — 재인증해야 새 scope가 반영).
    unpublish_required_scope: str | None = None
    # story 620beefc(Phase1·마케팅운영, PO 決定 2026-09-04) — 이미지 규격 선언(§13 규격
    # 문구 3요소: 무엇이·얼마까지·지금 얼마 — "무엇이·얼마까지" 축, 값은 실측·출처 주석).
    # image_max_count=0(기본)=이 채널은 이미지 미지원(threads_delete처럼 채널의 성질을
    # 여기 한 곳에 선언 — 상수 하드코딩 X, 화면·서비스가 이 값을 그대로 노출/검증에 쓴다).
    image_formats: tuple[str, ...] = ()
    image_max_bytes: int = 0
    image_aspect_max: float = 0.0
    image_width_min: int = 0
    image_width_max: int = 0
    image_color_space: str = ""
    image_max_count: int = 0


CHANNEL_ADAPTERS: dict[str, ChannelAdapterConfig] = {
    "threads": ChannelAdapterConfig(
        authorize_url="https://threads.net/oauth/authorize",
        token_url="https://graph.threads.net/oauth/access_token",
        # story #3419 — threads_delete 추가(회수 API 스코프, Meta 공식 문서 실측
        # developers.facebook.com/docs/threads/posts/delete-posts/ 2026-09-04). 기존
        # 연결은 이 스코프 없이 이미 저장돼 있어 재인증 전까지 회수가 막힌다(의도, PO
        # 확定 — 새 연결부터 자동 해소).
        scope="threads_basic,threads_content_publish,threads_delete",
        refresh_mode="reissue_from_access_token",
        credential_kind="oauth",
        display_name="Threads",
        # sprintable-agent-plugins/plugins/sprintable/connectors/threads.ts:27의
        # MAX_TEXT_LENGTH=500 그대로(story #3311, Meta 공식 문서 페이지 직접 실측 — 추정값
        # 아님).
        max_text_length=500,
        utm_source="threads",
        utm_medium="social",
        supports_unpublish=True,
        unpublish_required_scope="threads_delete",
        # story 620beefc — Threads IMAGE 미디어 컨테이너 공식 규격(Meta 공식 문서 실측,
        # developers.facebook.com/docs/threads/posts + developers.facebook.com/docs/
        # threads/troubleshooting, 조회일 2026-09-04). 형식 JPEG/PNG만·최대 8MB·종횡비
        # 최대 10:1·너비 320~1440px(범위 밖은 Threads가 스케일하나 이 서버가 선제
        # 변환)·색공간 sRGB. Phase1은 초안당 이미지 1건(캐러셀 범위 밖, story 본문 명시).
        image_formats=("image/jpeg", "image/png"),
        image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        image_max_count=1,
    ),
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각①) — Sprintable
    # 호스팅 블로그를 blog kind 어댑터 1호로 등재한다. **동작 무변경** — site_posts.py의
    # 발행 흐름(`publish_site_post_from_draft` 등)은 지금처럼 내부 `site_posts` 테이블에
    # 직접 쓴다(어댑터 dispatch·publication_command 경로를 안 탄다, PO 確定 ③). 이 항목은
    # 순수 선언(레지스트리 등재)일 뿐 — available-channels·kind 필드로 존재를 노출하는
    # 것 외에 아무 기존 코드 경로도 건드리지 않는다. credential_kind="none"(연결 불요,
    # 항상 사용 가능) — OAuth 필드는 sandbox와 동형으로 빈 문자열.
    "hosted_site": ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="",
        refresh_mode="manual",
        credential_kind="none",
        display_name="Sprintable 호스팅 블로그",
        kind="blog",
        # story e4fc29fa(페드루 PO 리뷰 B1) — 연결할 게 없다(항상 사용 가능) — available-
        # channels 목록(연결 만들기 버튼 대상)에서 이 항목이 빠지는 유일한 근거.
        requires_connection=False,
        # site_posts.py::unpublish_site_post가 이미 존재(story #3381) — 선언은 그
        # 사실을 정확히 반영할 뿐(신규 동작 아님). 외부 스코프 개념이 없어(credential
        # 자체가 없다) unpublish_required_scope는 비운다.
        supports_unpublish=True,
    ),
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③b) — WordPress
    # self-hosted(Application Password) blog kind 어댑터 2호. WordPress.com OAuth2는
    # 스토리 경계 明示로 이 조각 범위 밖(사람 의존 앱 등록 필요) — credential_kind만
    # 여기 pasted_secret로 선언, authorize_url/token_url/scope는 threads류 OAuth 흐름을
    # 안 타 sandbox/hosted_site와 동형으로 빈 문자열.
    "wordpress": ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="",
        # Application Password는 만료가 없고 refresh 개념 자체가 없다(재발급=휴먼이
        # WordPress 관리자 화면에서 새 비밀번호를 새로 붙여넣는 것뿐 — connected_by가
        # 재연결하는 수동 경로).
        refresh_mode="manual",
        credential_kind="pasted_secret",
        display_name="WordPress(self-hosted)",
        kind="blog",
        # unpublish=wordpress_publish.unpublish()(status=draft 전환) — Application
        # Password는 스코프 개념이 없어(전권 아니면 credential 자체가 없다) 여기도
        # hosted_site와 동형으로 비운다.
        supports_unpublish=True,
    ),
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) — 고객 자체
    # 사이트 signed webhook blog kind 어댑터 3호. credential_kind=pasted_secret(공유
    # 비밀 — wordpress Application Password와 같은 컬럼 재사용, 유나 §8③ 정본).
    "webhook": ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="",
        refresh_mode="manual",
        credential_kind="pasted_secret",
        display_name="고객 웹훅(signed)",
        kind="blog",
        # unpublish=webhook_publish.unpublish()(event:"unpublish" 신호 POST) — webhook
        # 도 스코프 개념이 없다(공유 비밀 하나가 전권).
        supports_unpublish=True,
    ),
}

# story 5b27b32f(Phase1·BE·테스트 인프라, 페드루 PO 확定 2026-09-04) — dev 전용 샌드박스
# 채널. dev org에 실 Meta 자격이 없어(채널 연결 0건) publication_command·cron tick·
# cancel-scheduled·unpublish·429·컨테이너 폴링 경로를 라이브로 한 번도 못 밟던 문제
# (카디르 배포17 관측) — Threads 어댑터 코드(threads_publish.py)는 그대로 두고, 별도
# 결정적 가짜 provider(sandbox_publish.py)로 같은 오케스트레이션 경로를 태운다.
#
# **fail-closed 이중 방어**(AC1·AC5): ①이 아래 블록 자체가 `SANDBOX_CHANNEL_ENABLED=true`
# 일 때만 등재한다(cloudbuild.yaml이 dev에만 이 값을 싣고 prod엔 키 자체가 없다 —
# GCS_CHANNEL_MEDIA_BUCKET 이전의 ADMIN_OPERATOR_* 관례 그대로) ②그래도 잘못 켜졌을 경우
# (수동 오조작 등)를 대비해 `assert_sandbox_channel_not_registered_in_prod()`가 기동
# 시점에 `settings.is_prod_deploy`와 대조해 있으면 안 되는데 있으면 즉시 RuntimeError로
# 기동 자체를 죽인다(app/main.py lifespan에서 호출).
if os.environ.get("SANDBOX_CHANNEL_ENABLED", "").strip().lower() == "true":
    CHANNEL_ADAPTERS["sandbox"] = ChannelAdapterConfig(
        authorize_url="",  # OAuth 없음(AC2) — 연결은 POST .../channel-connections/sandbox 전용.
        token_url="",
        scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual",  # 더미 토큰이라 자동 갱신 개념 자체가 없음.
        credential_kind="none",
        display_name="Sandbox",
        max_text_length=500,  # Threads와 동형(그라운딩 §1 실측 재사용, 새 한도를 지어내지 않는다).
        utm_source="sandbox",
        utm_medium="test",
        supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        # Threads와 동일 이미지 규격(AC1 "Threads와 같은 모양") — sandbox_publish.py가
        # 실제로 Pillow 변환 파이프라인을 거치므로(channel_post_images.py는 채널 무관 공용)
        # 같은 한도가 그대로 의미를 가진다.
        image_formats=("image/jpeg", "image/png"),
        image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        image_max_count=1,
    )


def get_channel_adapter(channel: str) -> ChannelAdapterConfig | None:
    return CHANNEL_ADAPTERS.get(channel)


def can_auto_refresh(refresh_mode: str) -> bool:
    return refresh_mode in ("refresh_token", "reissue_from_access_token")


class BlogChannelDispatchNotImplementedError(NotImplementedError):
    """story e4fc29fa(페드루 PO 리뷰 B2, 2026-09-04) — kind="blog" 채널은 이 함수의
    디스패치 대상이 아니다(hosted_site는 site_posts.py가 직접 처리·publication_command
    경로를 안 탄다; wordpress/webhook은 조각②에서 별도 배선). 이 함수가 아무 분기도
    못 찾으면 조용히 threads_publish로 떨어지던 것(수정 前 결함 — hosted_site가 Threads
    API 호출 코드를 잘못 타는 사고)을 fail-closed로 막는다."""

    def __init__(self, *, channel: str):
        self.channel = channel
        super().__init__(
            f"channel={channel!r}는 kind='blog'라 get_publish_client_module 디스패치 대상이 "
            "아닙니다(hosted_site=site_posts.py 직접 처리, wordpress/webhook=조각② 배선 예정)."
        )


def get_publish_client_module(channel: str):
    """story 5b27b32f — 발행 클라이언트 모듈 디스패치. `sandbox`만 `threads_publish`
    대신 `sandbox_publish`로 우회한다(같은 함수 시그니처·같은 `ThreadsPublishError`
    클래스를 그대로 재사용 — sandbox_publish.py가 신규 예외 타입을 만들지 않으므로
    channel_posts.py의 기존 except절이 그대로 먹힌다, 신규 판정 로직 0). 실 배포 채널
    (threads 등)은 전부 threads_publish 그대로 — 이 함수가 sandbox 개입의 유일한
    지점이다(Threads 어댑터 코드 자체는 무변경).

    story e4fc29fa(페드루 PO 리뷰 B2) — kind="blog" 채널(hosted_site 등)은 여기서
    명시적으로 거부한다. 이 가드가 없으면 마지막 else가 threads_publish로 조용히
    떨어져(수정 前 결함) 블로그 발행이 Threads API 코드를 잘못 탄다."""
    adapter = get_channel_adapter(channel)
    if adapter is not None and adapter.kind == "blog":
        raise BlogChannelDispatchNotImplementedError(channel=channel)
    if channel == "sandbox":
        from app.services import sandbox_publish
        return sandbox_publish
    from app.services import threads_publish
    return threads_publish


def assert_sandbox_channel_not_registered_in_prod() -> None:
    """story 5b27b32f(AC5) — 기동 시점 fail-closed 방어. env 플래그 게이트(위)가 이미
    prod cloudbuild.yaml에 `SANDBOX_CHANNEL_ENABLED` 키 자체를 안 실어 정상 배포에서는
    이 함수가 항상 no-op이다 — 그래도 수동 오조작(예: gcloud run services update로 누가
    직접 env를 붙임)까지 방어하는 두 번째 층. `app/main.py` lifespan이 기동마다 호출."""
    from app.core.config import settings

    if settings.is_prod_deploy and "sandbox" in CHANNEL_ADAPTERS:
        raise RuntimeError(
            "fail-closed: prod 배포에 sandbox 채널 어댑터가 등재돼 있습니다"
            "(SANDBOX_CHANNEL_ENABLED가 prod에 잘못 설정됐을 가능성 — story 5b27b32f AC5)."
        )
