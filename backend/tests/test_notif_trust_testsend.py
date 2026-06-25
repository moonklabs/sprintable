"""0a6487c6-BE: 알림 목적지 trust-surface BE — test-send 엔드포인트 + deliver_test_webhook.

AC2 합성 'TEST' 1발·AC3 계약 {ok, reached, reason?, ts}·SSRF 재검증·Discord 정규화(c60dd33c)·
anti-IDOR(repo.get org-scope). AC1(in-app opt-out 디폴트)은 notification_dispatch 기존 거동(surface-only).
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.routers.webhooks import test_send_webhook_config as _send_test  # 별칭(pytest 수집 회피)
from app.services.webhook_dispatch import deliver_test_webhook


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Resp:
    def __init__(self, status_code: int):
        self.status_code = status_code


def _client_cm(post_mock):
    client = AsyncMock()
    client.post = post_mock
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


# ─── deliver_test_webhook ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_reached_on_2xx():
    with patch("app.services.webhook_dispatch.validate_webhook_url_async", new=AsyncMock()), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient",
               return_value=_client_cm(AsyncMock(return_value=_Resp(204)))):
        reached, reason = await deliver_test_webhook("https://example.com/hook", None)
    assert reached is True and reason is None


@pytest.mark.anyio
async def test_not_reached_on_non_2xx_has_reason():
    with patch("app.services.webhook_dispatch.validate_webhook_url_async", new=AsyncMock()), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient",
               return_value=_client_cm(AsyncMock(return_value=_Resp(500)))):
        reached, reason = await deliver_test_webhook("https://example.com/hook", None)
    assert reached is False and "500" in reason


@pytest.mark.anyio
async def test_ssrf_rejected_before_post():
    """사용자 URL → SSRF 재검증 실패 시 post 미발사·미도달(내부망 차단)."""
    posted = AsyncMock()
    with patch("app.services.webhook_dispatch.validate_webhook_url_async",
               new=AsyncMock(side_effect=ValueError("blocked"))), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient", return_value=_client_cm(posted)):
        reached, reason = await deliver_test_webhook("http://169.254.169.254/", None)
    assert reached is False and "url" in reason
    posted.assert_not_called()


@pytest.mark.anyio
async def test_discord_url_normalized_payload_no_signature():
    """Discord URL은 {content|embeds}로 정규화(c60dd33c·아니면 400)·TEST 라벨 포함."""
    captured: dict = {}

    async def _post(url, content=None, headers=None):
        captured["content"] = content
        captured["headers"] = headers
        return _Resp(204)

    with patch("app.services.webhook_dispatch.validate_webhook_url_async", new=AsyncMock()), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient", return_value=_client_cm(_post)):
        reached, _ = await deliver_test_webhook(
            "https://discord.com/api/webhooks/1/abc", None
        )
    assert reached is True
    body = json.loads(captured["content"])
    assert "content" in body or "embeds" in body  # Discord 형식
    assert "TEST" in captured["content"]


# ─── POST /config/{id}/test-send (계약 lock) ──────────────────────────────────

@pytest.mark.anyio
async def test_endpoint_404_when_config_missing_or_cross_org():
    """repo.get org-scope → 타 org/없는 id면 None → 404(anti-IDOR)."""
    from fastapi import HTTPException
    repo = AsyncMock()
    repo.get_owned = AsyncMock(return_value=None)
    with pytest.raises(HTTPException) as ei:
        await _send_test(uuid.uuid4(), repo=repo, caller_member_id=uuid.uuid4())
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_endpoint_contract_reached_omits_reason():
    repo = AsyncMock()
    repo.get_owned = AsyncMock(return_value=SimpleNamespace(url="https://x/h", secret=None))
    with patch("app.services.webhook_dispatch.deliver_test_webhook",
               new=AsyncMock(return_value=(True, None))):
        out = await _send_test(uuid.uuid4(), repo=repo, caller_member_id=uuid.uuid4())
    assert out["ok"] is True and out["reached"] is True and "ts" in out
    assert "reason" not in out  # 도달 시 reason 생략(계약)


@pytest.mark.anyio
async def test_endpoint_contract_not_reached_includes_reason():
    repo = AsyncMock()
    repo.get_owned = AsyncMock(return_value=SimpleNamespace(url="https://x/h", secret=None))
    with patch("app.services.webhook_dispatch.deliver_test_webhook",
               new=AsyncMock(return_value=(False, "HTTP 502"))):
        out = await _send_test(uuid.uuid4(), repo=repo, caller_member_id=uuid.uuid4())
    assert out["ok"] is True and out["reached"] is False and out["reason"] == "HTTP 502"


# ─── IDOR: webhook-config member-scope 회귀 (산티아고 RC) ─────────────────────

@pytest.mark.anyio
async def test_test_send_uses_owned_scope_with_caller_member():
    """test-send 는 get_owned(id, caller_member_id) 로 소유 검증 — 타 멤버 config_id 차단."""
    repo = AsyncMock()
    repo.get_owned = AsyncMock(return_value=SimpleNamespace(url="https://x/h", secret=None))
    caller = uuid.uuid4()
    with patch("app.services.webhook_dispatch.deliver_test_webhook",
               new=AsyncMock(return_value=(True, None))):
        await _send_test(uuid.uuid4(), repo=repo, caller_member_id=caller)
    assert repo.get_owned.await_args.args[1] == caller  # caller member 로 소유 검증


@pytest.mark.anyio
async def test_list_is_member_scoped():
    """list 는 caller member-scope — org-wide leak 차단."""
    from app.routers.webhooks import list_webhook_configs
    repo = AsyncMock()
    repo.list = AsyncMock(return_value=[])
    caller = uuid.uuid4()
    await list_webhook_configs(project_id=None, repo=repo, caller_member_id=caller)
    assert repo.list.await_args.kwargs["member_id"] == caller


@pytest.mark.anyio
async def test_delete_is_member_scoped_404_for_other():
    """delete 는 get_owned 기반 — 타 멤버/없는 id 면 404·caller_member 전달."""
    from fastapi import HTTPException
    from app.routers.webhooks import delete_webhook_config
    repo = AsyncMock()
    repo.delete = AsyncMock(return_value=False)
    caller = uuid.uuid4()
    with pytest.raises(HTTPException) as ei:
        await delete_webhook_config(id=uuid.uuid4(), repo=repo, caller_member_id=caller)
    assert ei.value.status_code == 404
    assert repo.delete.await_args.args[1] == caller


@pytest.mark.anyio
async def test_upsert_uses_caller_member_ignoring_body():
    """PUT 은 body.member_id 를 무시하고 **caller_member_id 로 강제** upsert(타 멤버 설정 불가)."""
    from app.routers.webhooks import upsert_webhook_config
    repo = AsyncMock()
    repo.upsert = AsyncMock(return_value=SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), member_id=uuid.uuid4(), project_id=None,
        url="https://x/h", events=[], channel="generic", is_active=True,
        created_at=__import__("datetime").datetime(2026, 1, 1), secret=None,
    ))
    caller, other = uuid.uuid4(), uuid.uuid4()
    body = SimpleNamespace(
        member_id=other, url="https://x/h", project_id=None, events=[], is_active=True, secret=None
    )
    await upsert_webhook_config(body, repo=repo, caller_member_id=caller)
    # body.member_id(other) 가 아니라 caller 로 upsert — 타 멤버 설정 불가
    assert repo.upsert.await_args.kwargs["member_id"] == caller


# ─── 멤버 축 정합: _get_caller_member_id = resolve_member().id (산티아고/PO hotfix) ──

@pytest.mark.anyio
async def test_caller_member_id_uses_resolve_member_not_user_id():
    """_get_caller_member_id 는 resolve_member().id(휴먼=org_member.id·에이전트=team_member.id)를 쓴다.
    canonicalize(auth.user_id) 금지 — 휴먼은 auth.user_id=users.id라 디스패치(org_member.id)와 불일치."""
    from app.routers.webhooks import _get_caller_member_id
    org_member_id = uuid.uuid4()
    users_id = uuid.uuid4()
    auth = SimpleNamespace(user_id=str(users_id))  # 휴먼 JWT sub = users.id
    with patch("app.services.member_resolver.resolve_member",
               new=AsyncMock(return_value=SimpleNamespace(id=org_member_id))):
        out = await _get_caller_member_id(auth=auth, org_id=uuid.uuid4(), session=AsyncMock())
    assert out == org_member_id        # canonical 축(디스패치 정합)
    assert out != users_id             # users.id 축 아님(축 버그 회귀 차단)
