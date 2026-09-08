"""story #3359(레시피·채널 확장, 페드루 PO 確定 2026-09-08) — channel→connector_key
리졸버(resolve_connector_key_for_channel)와 두 트리거 지점(events.py:_render_gate_
verdict_message의 publish 다음-행동 문구·apply_recipe_role_bindings의 정적 경고) 실증.

세 축:
① 리졸버 자체(mock db) — org override→기본→None 3분기.
② 다음-행동 문구(mock db, test_3387과 동형 fixture) — publish+channel 있으면 커넥터명
   구체화·매핑 없으면 에러 문구·publish 아니거나 channel 없으면 회귀 0(test_3387이
   이미 gate_type=qa로 고정한 회귀 축과 겹치지 않게 gate_type=external_publish 아닌
   레시피 stage 축만 다룬다).
③ apply_recipe_role_bindings 경고(realdb, test_3317b와 동형 fixture) — 정적 하드코딩이
   아니라 리졸버 경유라는 증거(org override가 경고 내용을 바꾼다) + 별칭 미매핑 시
   기존 "등록 안 됨" 문구가 아니라 새 "channel=X 매핑 없음" 문구."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── ① 리졸버 자체 ──────────────────────────────────────────────────────────


def _fake_rules_row(rules: dict | None):
    row = MagicMock()
    row.rules = rules
    return row


async def test_resolver_org_override_wins_over_default(monkeypatch):
    """threads 기본값은 threads지만 org가 명시로 다른 커넥터를 지정했으면 그걸 우선한다."""
    from app.services import channel_connector_map as mod

    async def _fake_get(_db, *, org_id):
        return _fake_rules_row({"channel_connector_map": {"threads": "custom_threads_v2"}})

    monkeypatch.setattr(mod, "get_org_content_rules", _fake_get)
    result = await mod.resolve_connector_key_for_channel(AsyncMock(), org_id=uuid.uuid4(), channel="threads")
    assert result == "custom_threads_v2"


async def test_resolver_falls_back_to_verified_default_when_no_override(monkeypatch):
    """org_content_rules 행 자체가 없거나 channel_connector_map이 없으면 검증된 기본값
    (항등 매핑)으로 떨어진다."""
    from app.services import channel_connector_map as mod

    async def _fake_get(_db, *, org_id):
        return None

    monkeypatch.setattr(mod, "get_org_content_rules", _fake_get)
    assert await mod.resolve_connector_key_for_channel(AsyncMock(), org_id=uuid.uuid4(), channel="threads") == "threads"
    assert await mod.resolve_connector_key_for_channel(AsyncMock(), org_id=uuid.uuid4(), channel="site_git") == "site_git"


async def test_resolver_unknown_channel_without_override_is_none(monkeypatch):
    """'blog'는 레지스트리 어디에도 declared channel이 아니다 — org override 없으면
    지어내지 않고 None(호출부가 «매핑 없음»으로 명시)."""
    from app.services import channel_connector_map as mod

    async def _fake_get(_db, *, org_id):
        return _fake_rules_row({"channel_connector_map": {}})

    monkeypatch.setattr(mod, "get_org_content_rules", _fake_get)
    result = await mod.resolve_connector_key_for_channel(AsyncMock(), org_id=uuid.uuid4(), channel="blog")
    assert result is None


async def test_resolver_org_override_resolves_unverified_alias(monkeypatch):
    """org가 명시로 blog→site_git을 등록하면 그건 지어낸 게 아니라 org 자신의 선언이라
    정상 해소된다 — None 경로가 «영구히 안 됨»이 아니라 «아직 org가 안 정했음»임을 보인다."""
    from app.services import channel_connector_map as mod

    async def _fake_get(_db, *, org_id):
        return _fake_rules_row({"channel_connector_map": {"blog": "site_git"}})

    monkeypatch.setattr(mod, "get_org_content_rules", _fake_get)
    result = await mod.resolve_connector_key_for_channel(AsyncMock(), org_id=uuid.uuid4(), channel="blog")
    assert result == "site_git"


# ─── ② 다음-행동 문구(events.py::_render_gate_verdict_message) ──────────────


class _FakeGateRow:
    def __init__(self, neutral_facts: dict | None, *, id_=None):
        self.neutral_facts = neutral_facts
        self.id = id_ or uuid.uuid4()


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


def _fake_db(gate_row=None):
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_FakeResult(gate_row))
    db.get = AsyncMock(return_value=gate_row)
    return db


def _payload(*, verdict: str = "approved") -> dict:
    return {
        "work_item_type": "story",
        "work_item_id": str(uuid.uuid4()),
        "gate_type": "recipe_stage_gate",
        "verdict": verdict,
        "resolution_note": None,
    }


@pytest.fixture(autouse=True)
def _stub_work_item_ref(monkeypatch):
    from app.routers import events as events_module

    async def _fake_ref(*_args, **_kwargs):
        return "[제목](entity:story:11111111-1111-1111-1111-111111111111)"

    monkeypatch.setattr(events_module, "_render_event_notification_work_item_ref", _fake_ref)


async def _render(gate_row=None) -> str:
    from app.routers.events import _render_gate_verdict_message

    return await _render_gate_verdict_message(_fake_db(gate_row), org_id=uuid.uuid4(), payload=_payload())


async def test_publish_stage_with_mapped_channel_names_the_connector(monkeypatch):
    from app.services import channel_connector_map as mod

    async def _fake_resolve(_db, *, org_id, channel):
        assert channel == "threads"
        return "threads"

    monkeypatch.setattr(mod, "resolve_connector_key_for_channel", _fake_resolve)
    text = await _render(_FakeGateRow({"stage": "publish", "channel": "threads"}))
    assert "threads 커넥터로 발행하세요" in text
    assert "channel=threads" in text
    # 옛 제네릭 문구는 대체됐다 — 둘 다 있으면 안 헷갈리게 하나만.
    assert "이 승인 게이트를 확인하는 발행 도구를 쓰세요" not in text


async def test_publish_stage_with_unmapped_channel_states_missing_mapping_not_silent(monkeypatch):
    from app.services import channel_connector_map as mod

    async def _fake_resolve(_db, *, org_id, channel):
        return None

    monkeypatch.setattr(mod, "resolve_connector_key_for_channel", _fake_resolve)
    text = await _render(_FakeGateRow({"stage": "publish", "channel": "blog"}))
    assert "channel=blog" in text
    assert "매핑이 없습니다" in text
    assert "발행 도구를 쓰세요" not in text


async def test_non_publish_stage_keeps_generic_text_regression():
    """publish가 아닌 stage(예: approve)는 리졸버를 안 타고 옛 제네릭 문구 그대로."""
    text = await _render(_FakeGateRow({"stage": "approve", "channel": "threads"}))
    assert "이 정의의 다음 stage 이벤트를 발행하세요" in text
    assert "커넥터로 발행하세요" not in text


async def test_publish_stage_without_channel_keeps_generic_text_regression():
    """stage=publish여도 channel을 모르면(neutral_facts에 없거나 미확認) 리졸버를 안 타고
    옛 제네릭 문구 그대로 — 지어낼 channel이 없다."""
    text = await _render(_FakeGateRow({"stage": "publish", "channel": "미확認"}))
    assert "이 정의의 다음 stage 이벤트를 발행하세요" in text
    assert "커넥터로 발행하세요" not in text
