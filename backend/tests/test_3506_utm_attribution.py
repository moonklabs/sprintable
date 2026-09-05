"""story #3506(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — UTM 규칙 + 발행 시 링크
UTM 자동 부착(조각①: 규칙 슬롯+override+utm_content). 세팅 헬퍼는
test_3471_org_content_rules_lint.py와 동형(중복 재발명 금지).

그라운딩 확인 — channel_post는 이미 UTM 부착 메커니즘(app/services/utm.py,
story #f8f7cb0f)이 있다. 이 스토리는 그 위에 ①조직 override(source/medium)
②utm_content 4번째 키 ③require_utm과의 자동충족 연결을 얹는다 — 새 메커니즘
발명이 아니다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_agent,
    _seed_connection,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _put_utm_rules(session, *, org_id, **fields):
    from app.services.content_rules import put_org_content_rules

    return await put_org_content_rules(
        session, org_id=org_id, rules={"utm_rules": fields}, updated_by_member_id=uuid.uuid4(),
    )


# ─── attach_utm 4번째 키(단위) ────────────────────────────────────────────────


def test_attach_utm_content_key_added_when_given():
    from app.services.utm import attach_utm

    url = attach_utm("https://example.com/x", source="s", medium="m", campaign="c", content="d1")
    assert "utm_content=d1" in url


def test_attach_utm_content_omitted_when_none():
    from app.services.utm import attach_utm

    url = attach_utm("https://example.com/x", source="s", medium="m", campaign="c", content=None)
    assert "utm_content" not in url


def test_attach_utm_skips_entirely_when_utm_already_present_even_with_content():
    """기존 계약(스킵-if-present)이 4번째 키 추가로 안 깨졌는지 — utm_* 아무거나
    하나라도 있으면 content가 와도 원본 그대로."""
    from app.services.utm import attach_utm

    url = attach_utm("https://example.com/x?utm_source=manual", source="s", medium="m", campaign="c", content="d1")
    assert url == "https://example.com/x?utm_source=manual"


# ─── build_tagged_link — 조직 override ───────────────────────────────────────


def test_build_tagged_link_no_utm_rules_uses_adapter_defaults_no_content():
    """회귀 0 — utm_rules=None(«규칙 없음»)이면 #f8f7cb0f 시절 그대로: 어댑터
    하드코딩 source/medium·utm_content 없음."""
    from app.services.channel_posts import build_tagged_link

    draft_id = uuid.uuid4()
    url = build_tagged_link(channel="threads", link_url="https://example.com/post", draft_id=draft_id, utm_rules=None)
    assert "utm_source=threads" in url
    assert "utm_medium=social" in url
    assert "utm_content" not in url


def test_build_tagged_link_disabled_utm_rules_uses_adapter_defaults():
    from app.services.channel_posts import build_tagged_link

    draft_id = uuid.uuid4()
    url = build_tagged_link(
        channel="threads", link_url="https://example.com/post", draft_id=draft_id,
        utm_rules={"enabled": False, "default_source": "override-src"},
    )
    assert "utm_source=threads" in url, "enabled=False면 override를 무시하고 어댑터 값 그대로여야 한다"


def test_build_tagged_link_enabled_overrides_source_and_medium():
    from app.services.channel_posts import build_tagged_link

    draft_id = uuid.uuid4()
    url = build_tagged_link(
        channel="threads", link_url="https://example.com/post", draft_id=draft_id,
        utm_rules={"enabled": True, "default_source": "newsletter", "default_medium": "email"},
    )
    assert "utm_source=newsletter" in url
    assert "utm_medium=email" in url


def test_build_tagged_link_enabled_without_override_falls_back_to_adapter():
    """default_source/medium이 둘 다 미설정이면(enabled=True만) 어댑터 값으로
    떨어진다 — override는 선택이지 강제가 아니다."""
    from app.services.channel_posts import build_tagged_link

    draft_id = uuid.uuid4()
    url = build_tagged_link(
        channel="threads", link_url="https://example.com/post", draft_id=draft_id,
        utm_rules={"enabled": True},
    )
    assert "utm_source=threads" in url
    assert "utm_medium=social" in url


def test_build_tagged_link_content_from_draft_id_default():
    from app.services.channel_posts import build_tagged_link

    draft_id = uuid.uuid4()
    url = build_tagged_link(
        channel="threads", link_url="https://example.com/post", draft_id=draft_id,
        utm_rules={"enabled": True},
    )
    assert f"utm_content={draft_id}" in url


def test_build_tagged_link_content_from_none_omits_utm_content():
    from app.services.channel_posts import build_tagged_link

    draft_id = uuid.uuid4()
    url = build_tagged_link(
        channel="threads", link_url="https://example.com/post", draft_id=draft_id,
        utm_rules={"enabled": True, "content_from": "none"},
    )
    assert "utm_content" not in url


# ─── content-rules PUT/GET — utm_rules 슬롯 ──────────────────────────────────


@pytest.mark.anyio
async def test_put_utm_rules_reflected_in_get():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"utm_rules": {
                    "enabled": True, "default_source": "newsletter", "default_medium": "email",
                }}},
            )
            assert r_put.status_code == 200, r_put.text
            assert r_put.json()["rules"]["utm_rules"]["enabled"] is True
            assert r_put.json()["rules"]["utm_rules"]["default_source"] == "newsletter"

            r_get = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
        assert r_get.json()["rules"]["utm_rules"]["default_medium"] == "email"
        # 미설정 필드는 기본값으로 채워진다(모델 default).
        assert r_get.json()["rules"]["utm_rules"]["campaign_from"] == "campaign_slug"
        assert r_get.json()["rules"]["utm_rules"]["content_from"] == "draft_id"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_utm_rules_unknown_field_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"utm_rules": {"enabled": True, "typo_field": "x"}}},
            )
        assert r_put.status_code == 422, r_put.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── require_utm ⇄ utm_rules.enabled 자동충족 ────────────────────────────────


def test_lint_content_require_utm_violation_when_utm_rules_absent():
    """회귀 0 — utm_rules 자체가 없으면 require_utm은 기존 그대로 수동 검사."""
    from app.services.content_rules import lint_content

    violations = lint_content(
        {"require_utm": True}, text="본문", link_url="https://example.com/no-utm-here",
    )
    assert any(v["code"] == "utm_missing" for v in violations)


def test_lint_content_require_utm_auto_satisfied_when_utm_rules_enabled():
    """PO 確定 ⓕ — utm_rules.enabled=true면 자동 부착이 보장되므로 submit 시점
    수동 검사를 건너뛴다(링크에 아직 utm이 없어도 위반 0건)."""
    from app.services.content_rules import lint_content

    violations = lint_content(
        {"require_utm": True, "utm_rules": {"enabled": True}},
        text="본문", link_url="https://example.com/no-utm-here",
    )
    assert not any(v["code"] == "utm_missing" for v in violations)


def test_lint_content_require_utm_still_enforced_when_utm_rules_disabled():
    """utm_rules는 있지만 enabled=False면 자동 부착이 안 보장되므로 여전히 수동
    검사(회귀 0 — require_utm 자체는 폐기되지 않았다는 PO 明示)."""
    from app.services.content_rules import lint_content

    violations = lint_content(
        {"require_utm": True, "utm_rules": {"enabled": False}},
        text="본문", link_url="https://example.com/no-utm-here",
    )
    assert any(v["code"] == "utm_missing" for v in violations)


# ─── HTTP 왕복 — 미리보기에 조직 override가 실제로 반영되는지 ───────────────────


@pytest.mark.anyio
async def test_channel_post_draft_preview_reflects_org_utm_override():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"utm_rules": {"enabled": True, "default_source": "newsletter"}}},
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "본문", "link_url": "https://example.com/landing",
                },
            )
        assert r.status_code == 201, r.text
        preview = r.json()["tagged_link_preview"]
        assert "utm_source=newsletter" in preview
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
