"""story #3815(배포 82 라이브 회차 페드루 PO 실측, 2026-09-12 17:17Z) —
`youtube_sandbox_publish.py::get_permalink`가 실 도메인(youtube.com)을 공개
URL로 낸 사고(별도 PR로 처방)를 「지정 경로 1개」가 아니라 「sandbox 파사드가
실 도메인을 낸다」는 클래스로 닫는다. 그라운딩 확認(2026-09-12) — 이 사고는
고립돼 있었다: 다른 7개 sandbox 파사드(sandbox·facebook_sandbox·instagram_
sandbox·stibee_sandbox·x_sandbox·ghost_sandbox·ads_sandbox)는 전부 이미
`.invalid` 관례(RFC 2606)를 따르거나(6곳) 애초에 permalink 개념 자체가
없다(ads_sandbox — boost 실행 파사드일 뿐 콘텐츠 발행 목적지가 아님,
`create_boost_campaign`/`set_campaign_status`/`get_campaign_spend_minor`
셋뿐 — 지어낸 permalink 함수를 강제하지 않는다).

완전성 체크(story #3697 EXPECTED_BACKEND_CHANNELS와 동형 fail-loud 패턴) —
`CHANNEL_ADAPTERS`에서 `sandbox`로 끝나는(밑줄 접두 유무 무관 — 페드루 PO
정정 2026-09-12 17:46Z: 접미 `_sandbox`만 보면 평 「sandbox」(sandbox_
publish.py, 제네릭 「테스트용」 채널)가 새어나간다) 채널 집합이 아래
EXPECTED_SANDBOX_CHANNELS와 정확히 같아야 한다. 새 sandbox 채널이 추가되는데
이 테스트의 기대 집합·파사드 매핑을 안 늘리면 이 완전성 체크가 즉시 RED —
"새 sandbox가 이 가드 밖에서 조용히 실 도메인을 내는" 사각을 막는다.
"""
from __future__ import annotations

from urllib.parse import urlsplit

import pytest

# story #3815 — 실 provider 도메인 블록리스트(페드루 PO 明示 목록 그대로).
_REAL_DOMAINS = (
    "youtube.com", "x.com", "twitter.com", "facebook.com", "instagram.com",
    "ghost.io", "ghost.org", "stibee.com", "threads.net",
)

# 6곳은 전부 같은 시그니처(social kind 5-함수 파사드의 get_permalink):
#   async def get_permalink(client, *, access_token: str, media_id: str) -> str | None
_UNIFORM_GET_PERMALINK_CHANNELS = (
    "sandbox", "facebook_sandbox", "instagram_sandbox", "stibee_sandbox", "x_sandbox", "youtube_sandbox",
)
# ghost_sandbox는 blog kind 관례(publish()가 (external_id, permalink) 튜플을 낸다).
_GHOST_LIKE_PUBLISH_CHANNELS = ("ghost_sandbox",)
# ads_sandbox는 permalink 개념 자체가 없다(그라운딩 확認, §docstring 참고) — 명시 제외.
_NO_PERMALINK_CHANNELS = ("ads_sandbox",)

EXPECTED_SANDBOX_CHANNELS = frozenset(
    _UNIFORM_GET_PERMALINK_CHANNELS + _GHOST_LIKE_PUBLISH_CHANNELS + _NO_PERMALINK_CHANNELS
)


def test_expected_sandbox_channels_matches_real_channel_adapters(monkeypatch):
    """완전성 체크 — story #3697 EXPECTED_BACKEND_CHANNELS와 동형. CHANNEL_ADAPTERS의
    `sandbox`로 끝나는(밑줄 접두 유무 무관 — 페드루 PO 정정 2026-09-12 17:46Z,
    접미 `_sandbox`만 보면 평 「sandbox」가 새어나간다) 채널 집합이 이 파일의
    세 분류(uniform·ghost류·무-permalink) 합집합과 정확히 같아야 한다.

    sandbox/instagram_sandbox/stibee_sandbox/ghost_sandbox는 `SANDBOX_CHANNEL_
    ENABLED` env(모듈 import 시점 1회 평가) 미설정 프로세스에선 CHANNEL_ADAPTERS에
    아예 없다(test_3696 등 기존 다수 테스트와 동형 문제) — 이 env를 테스트에서
    새로 켤 수 없으니(이미 import된 뒤) 없는 항목만 최소 stand-in으로 주입해
    "실제로 있는지"가 아니라 "이름이 CHANNEL_ADAPTERS 키 공간에 속하는지"만
    잰다(이미 등재돼 있으면 손 안 댐 — 그 실물을 그대로 쓴다)."""
    import app.services.channel_adapters as adapters_mod

    for key in ("sandbox", "instagram_sandbox", "stibee_sandbox", "ghost_sandbox"):
        if key not in adapters_mod.CHANNEL_ADAPTERS:
            monkeypatch.setitem(
                adapters_mod.CHANNEL_ADAPTERS, key,
                adapters_mod.ChannelAdapterConfig(
                    authorize_url="", token_url="", scope="x", refresh_mode="manual",
                    display_name=key, credential_kind="none",
                ),
            )

    actual = frozenset(ch for ch in adapters_mod.CHANNEL_ADAPTERS if ch.endswith("sandbox"))
    assert actual == EXPECTED_SANDBOX_CHANNELS, (
        f"CHANNEL_ADAPTERS의 sandbox 채널 집합이 이 가드의 기대 집합과 다르다 — "
        f"새 sandbox 채널을 추가/제거했다면 이 파일의 분류 3종(_UNIFORM_GET_PERMALINK_"
        f"CHANNELS/_GHOST_LIKE_PUBLISH_CHANNELS/_NO_PERMALINK_CHANNELS)도 같이 갱신할 것. "
        f"actual={sorted(actual)} expected={sorted(EXPECTED_SANDBOX_CHANNELS)}"
    )


def _assert_invalid_domain(permalink: str, *, channel: str) -> None:
    assert permalink, f"{channel}: permalink이 비어있음"
    host = urlsplit(permalink).netloc.split(":")[0]
    assert host.endswith(".invalid"), f"{channel}: 호스트가 .invalid로 안 끝남(host={host!r}, permalink={permalink!r})"
    for real_domain in _REAL_DOMAINS:
        assert real_domain not in permalink, f"{channel}: 실 도메인({real_domain}) 유출 — permalink={permalink!r}"


@pytest.mark.anyio
@pytest.mark.parametrize("channel", _UNIFORM_GET_PERMALINK_CHANNELS)
async def test_uniform_sandbox_facades_permalink_uses_invalid_domain(channel: str):
    import importlib

    module = importlib.import_module(f"app.services.{channel}_publish")
    permalink = await module.get_permalink(None, access_token="x", media_id="test-media-id")
    _assert_invalid_domain(permalink, channel=channel)


@pytest.mark.anyio
async def test_ghost_sandbox_publish_permalink_uses_invalid_domain():
    from app.services.ghost_sandbox_publish import publish

    _external_id, permalink = await publish(
        None, site_url="https://example.invalid", admin_api_key="dummy",
        title="t", body_md="b", summary="", tags=[], slug="s",
    )
    _assert_invalid_domain(permalink, channel="ghost_sandbox")


def test_ads_sandbox_has_no_permalink_function_by_design():
    """지어낸 permalink 함수를 강제하지 않는다 — ads_sandbox는 boost 실행
    파사드(기존 게시물의 object_story_id를 참조)일 뿐 콘텐츠 발행 목적지가
    아니라 permalink 개념 자체가 없다(그라운딩 확認: create_boost_campaign/
    set_campaign_status/get_campaign_spend_minor 셋뿐). 이 사실 자체를
    고정해 — 누군가 나중에 get_permalink를 추가하면 이 테스트가 실패해
    "그 값도 .invalid 검사 대상으로 넣어야 한다"는 신호가 된다."""
    from app.services import ads_sandbox_campaign

    assert not hasattr(ads_sandbox_campaign, "get_permalink")
    assert not hasattr(ads_sandbox_campaign, "publish")


@pytest.fixture
def anyio_backend():
    return "asyncio"
