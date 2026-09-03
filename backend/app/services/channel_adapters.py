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

from dataclasses import dataclass


@dataclass(frozen=True)
class ChannelAdapterConfig:
    authorize_url: str
    token_url: str
    scope: str
    # "refresh_token"(표준 grant) | "reissue_from_access_token"(Threads류 — 현재 유효한
    # access_token으로 재발급, refresh_token 불요) | "manual"(자동 갱신 불가 — 재인증 유도).
    refresh_mode: str
    credential_kind: str = "oauth"  # "oauth" | "pasted_secret" | "none"
    # story #3374(Phase1·마케팅운영, PO 결정) — 채널 포스트 초안 text 상한. 상수를 서비스/
    # 라우터에 하드코딩하지 않고 여기 한 곳에 선언(담롱 요구 — "상수 하드코딩 X·선언·표시",
    # 초안 저장 422 응답에 이 값을 그대로 실어 보낸다).
    max_text_length: int = 0


CHANNEL_ADAPTERS: dict[str, ChannelAdapterConfig] = {
    "threads": ChannelAdapterConfig(
        authorize_url="https://threads.net/oauth/authorize",
        token_url="https://graph.threads.net/oauth/access_token",
        scope="threads_basic,threads_content_publish",
        refresh_mode="reissue_from_access_token",
        credential_kind="oauth",
        # sprintable-agent-plugins/plugins/sprintable/connectors/threads.ts:27의
        # MAX_TEXT_LENGTH=500 그대로(story #3311, Meta 공식 문서 페이지 직접 실측 — 추정값
        # 아님).
        max_text_length=500,
    ),
}


def get_channel_adapter(channel: str) -> ChannelAdapterConfig | None:
    return CHANNEL_ADAPTERS.get(channel)


def can_auto_refresh(refresh_mode: str) -> bool:
    return refresh_mode in ("refresh_token", "reissue_from_access_token")
