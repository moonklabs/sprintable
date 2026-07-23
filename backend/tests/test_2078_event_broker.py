"""E-ARCH S2(story #2078): EventBroker dual-publish 회귀 가드.

무회귀 우선순위 — `event_broker_redis_dual_publish_enabled`(default False) 상태에서 기존
pg_notify 경로가 그대로 도는지, 켰을 때만 Redis 발행이 추가되는지를 검증한다. Memorystore가
없어도 CI가 돌게 redis 클라이언트는 전부 mock — 실 Redis 연결은 만들지 않는다.
"""
from __future__ import annotations

import asyncio

import pytest

from app.services import event_broker as eb


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_shadow_state():
    eb._pg_arrivals.clear()
    yield
    eb._pg_arrivals.clear()


def test_slim_org_payload_drops_content():
    data = {
        "entity_type": "story",
        "entity_id": "s1",
        "version": 3,
        "content": "민감한 본문 — Redis org 채널엔 절대 안 나가야",
    }
    slim = eb._slim_org_payload(data)
    assert slim == {"entity_type": "story", "entity_id": "s1", "version": 3}
    assert "content" not in slim


def test_redis_channel_naming():
    assert eb._redis_channel("org", "org-1") == "org:org-1:invalidation"
    assert eb._redis_channel("agent", "member-1") == "agent:member-1"


@pytest.mark.anyio
async def test_dual_publish_flag_off_only_calls_pg_notify(monkeypatch):
    """default(off) — pg_notify만 불리고 redis publish는 아예 안 스케줄돼야."""
    calls = []

    async def _fake_pg_notify(target, target_id, event_type, data):
        calls.append((target, target_id, event_type, data))

    redis_calls = []

    async def _fake_redis_publish(*args, **kwargs):
        redis_calls.append((args, kwargs))

    monkeypatch.setattr("app.services.pg_pubsub.pg_notify", _fake_pg_notify)
    monkeypatch.setattr("app.services.event_broker._redis_publish", _fake_redis_publish)
    monkeypatch.setattr(
        "app.core.config.settings.event_broker_redis_dual_publish_enabled", False
    )

    broker = eb.DualPublishEventBroker()
    await broker.publish("org", "org-1", "story.status_changed", {"foo": "bar"})

    assert len(calls) == 1
    assert calls[0][0] == "org"
    assert calls[0][3]["_broker_event_id"]  # correlation id는 flag 무관 항상 부여
    await asyncio.sleep(0)  # fire_and_forget 예약분(있다면) flush
    assert redis_calls == []


@pytest.mark.anyio
async def test_dual_publish_flag_on_also_fires_redis(monkeypatch):
    """켜져 있으면 pg_notify + redis publish(fire-and-forget) 둘 다 스케줄돼야."""
    pg_calls = []
    redis_calls = []

    async def _fake_pg_notify(target, target_id, event_type, data):
        pg_calls.append((target, target_id, event_type, data))

    async def _fake_redis_publish(target, target_id, event_type, data, event_id):
        redis_calls.append((target, target_id, event_type, data, event_id))

    monkeypatch.setattr("app.services.pg_pubsub.pg_notify", _fake_pg_notify)
    monkeypatch.setattr("app.services.event_broker._redis_publish", _fake_redis_publish)
    monkeypatch.setattr(
        "app.core.config.settings.event_broker_redis_dual_publish_enabled", True
    )

    broker = eb.DualPublishEventBroker()
    await broker.publish("agent", "member-1", "task.assigned", {"task_id": "t1"})
    await asyncio.sleep(0)  # fire_and_forget이 스케줄한 task 실행 대기

    assert len(pg_calls) == 1
    assert len(redis_calls) == 1
    # 두 경로가 같은 event_id로 상관관계를 맺어야(shadow 비교의 전제조건)
    pg_event_id = pg_calls[0][3]["_broker_event_id"]
    redis_event_id = redis_calls[0][4]
    assert pg_event_id == redis_event_id


@pytest.mark.anyio
async def test_redis_publish_skips_when_url_not_configured(monkeypatch, caplog):
    """redis_url 미설정 — 예외 없이 경고 로그만(fail-safe, shadow 경로라 절대 안 죽어야)."""
    monkeypatch.setattr("app.core.config.settings.redis_url", None)
    with caplog.at_level("WARNING"):
        await eb._redis_publish("org", "org-1", "x", {}, "evt-1")
    assert "redis_url not configured" in caplog.text


@pytest.mark.anyio
async def test_redis_publish_failure_does_not_raise(monkeypatch):
    """Redis client.publish가 던져도 shadow 경로는 예외를 삼켜야(pg_notify와 동형 철학)."""
    monkeypatch.setattr("app.core.config.settings.redis_url", "redis://fake:6379/0")

    class _BoomClient:
        async def publish(self, *a, **kw):
            raise ConnectionError("no memorystore")

    monkeypatch.setattr(eb, "_get_redis_client", lambda: _BoomClient())
    await eb._redis_publish("org", "org-1", "x", {"entity_type": "story"}, "evt-1")  # raise 안 해야


def test_record_pg_arrival_bounds_memory():
    """무한증가 방지 — 상한 도달 시 절반 정리."""
    for i in range(eb._SHADOW_MAX_TRACKED + 100):
        eb.record_pg_arrival(f"evt-{i}")
    assert len(eb._pg_arrivals) <= eb._SHADOW_MAX_TRACKED


def test_record_pg_arrival_ignores_empty_id():
    eb.record_pg_arrival("")
    assert eb._pg_arrivals == {}


@pytest.mark.anyio
async def test_redis_consume_loop_returns_immediately_without_redis_url(monkeypatch):
    """redis_url 없으면 무한루프에 안 들어가고 바로 return해야(테스트가 hang 안 함 자체가 증거)."""
    monkeypatch.setattr("app.core.config.settings.redis_url", None)
    await eb.redis_consume_loop()  # 타임아웃 없이 즉시 끝나야


class _FakePubSub:
    """redis-py PubSub 최소 mock — psubscribe 무시, listen()이 고정 메시지 시퀀스를 방출.

    ⚠️매 yield/재연결 사이 `asyncio.sleep(0)`으로 이벤트루프에 제어를 넘긴다 — 실 redis-py는
    네트워크 I/O라 자연히 이벤트루프에 양보하지만, 이 mock은 순수 동기 for라 양보점이 없으면
    redis_consume_loop의 `while True` 재연결 루프가 이 테스트 프로세스를 독점해 폴링 중인
    테스트 코루틴이 영원히 스케줄 안 되는(= pytest-timeout 30s로 hang) 버그를 낳는다."""

    def __init__(self, messages):
        self._messages = messages

    async def psubscribe(self, *patterns):
        await asyncio.sleep(0)

    async def listen(self):
        for m in self._messages:
            yield m
            await asyncio.sleep(0)

    async def close(self):
        pass


def _redis_message(payload: dict) -> dict:
    import json
    return {"type": "pmessage", "data": json.dumps(payload)}


async def _run_loop_until(monkeypatch, messages, condition, timeout_s=1.0):
    """redis_consume_loop을 백그라운드에서 돌리고 condition()이 참이 될 때까지 폴링 후 취소.

    fake pubsub의 listen()이 소진되면 while True가 재연결을 시도(_get_redis_client가 같은
    fake client를 반환하니 무해 — psubscribe도 매번 no-op) — 그래도 메시지 시퀀스는 1회만
    방출되니 condition이 첫 순회에서 안 만족되면 이 헬퍼가 timeout으로 실패한다(의도적).
    """
    class _FakeClient:
        def pubsub(self):
            return _FakePubSub(messages)

    monkeypatch.setattr(eb, "_get_redis_client", lambda: _FakeClient())
    monkeypatch.setattr("app.core.config.settings.redis_url", "redis://fake:6379/0")

    task = asyncio.create_task(eb.redis_consume_loop())
    elapsed = 0.0
    step = 0.01
    while elapsed < timeout_s:
        if condition():
            break
        await asyncio.sleep(step)
        elapsed += step
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert condition(), "redis_consume_loop이 기대한 상태에 도달 못 함(timeout)"


@pytest.mark.anyio
async def test_redis_consume_loop_dispatch_disabled_only_logs_no_dispatch_call(monkeypatch):
    """event_broker_redis_dispatch_enabled=False(default) — publish_event/_push_to_agent 안 불려야
    (이 회귀 가드가 없으면 3단계 전 실수로 실 dispatch가 켜져도 아무도 못 잡는다)."""
    monkeypatch.setattr("app.core.config.settings.event_broker_redis_dispatch_enabled", False)
    monkeypatch.setattr("app.core.config.settings.redis_url", "redis://fake:6379/0")
    dispatch_calls = []
    monkeypatch.setattr(
        "app.routers.events.publish_event",
        lambda *a, **kw: dispatch_calls.append(("publish_event", a, kw)),
    )
    monkeypatch.setattr(
        "app.routers.events._push_to_agent",
        lambda *a, **kw: dispatch_calls.append(("_push_to_agent", a, kw)),
    )

    msg = _redis_message({
        "instance_id": "other-instance", "target": "org", "target_id": "org-1",
        "event_type": "x", "_broker_event_id": "evt-1", "data": {"foo": "bar"},
    })

    class _FakeClient:
        def pubsub(self):
            return _FakePubSub([msg])

    monkeypatch.setattr(eb, "_get_redis_client", lambda: _FakeClient())

    # 음성 결과(아무것도 dispatch 안 됨) 검증 — 긍정 condition이 없으니 고정 시간만 대기.
    task = asyncio.create_task(eb.redis_consume_loop())
    await asyncio.sleep(0.2)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert dispatch_calls == []
    # 그래도 shadow 관측(로그 기준점)은 여전히 동작해야 — dispatch=off가 관측까지 죽이면 안 됨.
    assert "evt-1" not in eb._pg_arrivals  # PG 도착이 없었으니 당연히 비교 기준점도 없음(정상)


@pytest.mark.anyio
async def test_redis_consume_loop_dispatch_enabled_calls_publish_event_for_org_target(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.event_broker_redis_dispatch_enabled", True)
    dispatch_calls = []
    monkeypatch.setattr(
        "app.routers.events.publish_event",
        lambda *a, **kw: dispatch_calls.append((a, kw)),
    )
    monkeypatch.setattr("app.routers.events._push_to_agent", lambda *a, **kw: None)

    msg = _redis_message({
        "instance_id": "other-instance", "target": "org", "target_id": "org-1",
        "event_type": "story.status_changed", "_broker_event_id": "evt-2",
        "data": {"entity_id": "s1"},
    })
    await _run_loop_until(monkeypatch, [msg], lambda: len(dispatch_calls) > 0)

    args, kwargs = dispatch_calls[0]
    assert args[0] == "org-1"
    assert args[1] == "story.status_changed"
    assert args[2] == {"entity_id": "s1"}
    assert kwargs.get("_from_listener") is True  # 재발행 무한루프 차단 플래그 필수


@pytest.mark.anyio
async def test_redis_consume_loop_dispatch_enabled_calls_push_to_agent_for_agent_target(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.event_broker_redis_dispatch_enabled", True)
    dispatch_calls = []
    monkeypatch.setattr("app.routers.events.publish_event", lambda *a, **kw: None)
    monkeypatch.setattr(
        "app.routers.events._push_to_agent",
        lambda *a, **kw: dispatch_calls.append((a, kw)),
    )

    msg = _redis_message({
        "instance_id": "other-instance", "target": "agent", "target_id": "member-1",
        "event_type": "task.assigned", "_broker_event_id": "evt-3",
        "data": {"task_id": "t1"},
    })
    await _run_loop_until(monkeypatch, [msg], lambda: len(dispatch_calls) > 0)

    args, kwargs = dispatch_calls[0]
    assert args[0] == "member-1"
    assert args[1] == {"task_id": "t1"}
    assert kwargs.get("_from_listener") is True


@pytest.mark.anyio
async def test_redis_consume_loop_dispatch_enabled_skips_self_published_event(monkeypatch):
    """자기 인스턴스가 발행한 이벤트(instance_id 일치)는 dispatch 안 해야 — 중복 전달 방지."""
    from app.services.pg_pubsub import INSTANCE_ID

    monkeypatch.setattr("app.core.config.settings.event_broker_redis_dispatch_enabled", True)
    dispatch_calls = []
    monkeypatch.setattr(
        "app.routers.events.publish_event",
        lambda *a, **kw: dispatch_calls.append(a),
    )
    monkeypatch.setattr("app.routers.events._push_to_agent", lambda *a, **kw: None)

    msg = _redis_message({
        "instance_id": INSTANCE_ID, "target": "org", "target_id": "org-1",
        "event_type": "x", "_broker_event_id": "evt-4", "data": {},
    })
    # self-skip이니 dispatch_calls는 영원히 빈 채 — 고정 시간만 대기 후 확認(음성 결과 검증).
    task = asyncio.create_task(eb.redis_consume_loop())
    await asyncio.sleep(0.2)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert dispatch_calls == []


@pytest.mark.anyio
async def test_redis_publish_payload_includes_instance_id_and_nested_data(monkeypatch):
    """envelope 형태가 pg_notify()와 동형(instance_id/target/target_id/event_type/data 분리)인지
    — redis_consume_loop의 파싱 대칭성 전제."""
    import json

    from app.services.pg_pubsub import INSTANCE_ID

    monkeypatch.setattr("app.core.config.settings.redis_url", "redis://fake:6379/0")
    published = []

    class _FakeClient:
        async def publish(self, channel, message):
            published.append((channel, json.loads(message)))

    monkeypatch.setattr(eb, "_get_redis_client", lambda: _FakeClient())

    await eb._redis_publish("agent", "member-1", "task.assigned", {"task_id": "t1"}, "evt-5")

    assert len(published) == 1
    channel, payload = published[0]
    assert channel == "agent:member-1"
    assert payload["instance_id"] == INSTANCE_ID
    assert payload["target"] == "agent"
    assert payload["target_id"] == "member-1"
    assert payload["event_type"] == "task.assigned"
    assert payload["_broker_event_id"] == "evt-5"
    assert payload["data"] == {"task_id": "t1"}


@pytest.mark.anyio
async def test_dispatch_received_records_pg_arrival_for_broker_event(monkeypatch):
    """pg_pubsub._dispatch_received가 _broker_event_id를 뽑아 record_pg_arrival을 호출해야."""
    from app.services import pg_pubsub

    recorded = []
    monkeypatch.setattr(eb, "record_pg_arrival", lambda eid: recorded.append(eid))

    async def _noop_publish_event(*a, **kw):
        pass

    import json

    monkeypatch.setattr("app.routers.events.publish_event", lambda *a, **kw: None)
    monkeypatch.setattr("app.routers.events._push_to_agent", lambda *a, **kw: True)

    payload = {
        "instance_id": "other-instance",
        "target": "org",
        "target_id": "org-1",
        "event_type": "story.status_changed",
        "data": {"_broker_event_id": "evt-xyz"},
    }
    await pg_pubsub._dispatch_received(json.dumps(payload))
    assert recorded == ["evt-xyz"]


@pytest.mark.anyio
async def test_dispatch_received_skips_self_published_event(monkeypatch):
    """자기 인스턴스가 발행한 이벤트는 instance_id 체크로 조기 return — record_pg_arrival 안 불려야
    (known 비대칭 — docstring에 명시된 그대로 실증)."""
    from app.services import pg_pubsub

    recorded = []
    monkeypatch.setattr(eb, "record_pg_arrival", lambda eid: recorded.append(eid))

    import json

    payload = {
        "instance_id": pg_pubsub.INSTANCE_ID,
        "target": "org",
        "target_id": "org-1",
        "event_type": "x",
        "data": {"_broker_event_id": "evt-self"},
    }
    await pg_pubsub._dispatch_received(json.dumps(payload))
    assert recorded == []
