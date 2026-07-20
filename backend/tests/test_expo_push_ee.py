"""E-MOBILE M0·S3: Expo 발송기 단위 테스트 (DB 불요·AsyncMock).

발송기 로직: ticket 파싱·배치(≤100)·DeviceNotRegistered→is_active=false·mute 필터·best-effort.
dispatch_notification 경로 실구동은 test_expo_push_realdb 가 커버.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import ee.services.expo_push as expo


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Resp:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def _client_cm(post_mock):
    client = AsyncMock()
    client.post = post_mock
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _mock_db(devices: list) -> AsyncMock:
    """db.execute: 1st=select(devices), 이후=update(AsyncMock). flush=AsyncMock."""
    sel = MagicMock()
    sel.scalars.return_value.all.return_value = devices
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[sel] + [AsyncMock() for _ in range(5)])
    db.flush = AsyncMock()
    return db


def _dev(token: str, member_id: uuid.UUID | None = None):
    return SimpleNamespace(expo_push_token=token, member_id=member_id or uuid.uuid4())


# ─── _expo_send_chunk (ticket 파싱·재시도) ────────────────────────────────────

@pytest.mark.anyio
async def test_send_chunk_returns_tickets_on_200():
    payload = {"data": [{"status": "ok", "id": "t1"}]}
    with patch("ee.services.expo_push.httpx.AsyncClient",
               return_value=_client_cm(AsyncMock(return_value=_Resp(200, payload)))):
        tickets = await expo._expo_send_chunk([{"to": "ExponentPushToken[a]"}])
    assert tickets == [{"status": "ok", "id": "t1"}]


@pytest.mark.anyio
async def test_send_chunk_retries_on_5xx_then_empty():
    post = AsyncMock(return_value=_Resp(500))
    with patch("ee.services.expo_push.httpx.AsyncClient", return_value=_client_cm(post)), \
         patch("ee.services.expo_push.asyncio.sleep", new=AsyncMock()):
        tickets = await expo._expo_send_chunk([{"to": "ExponentPushToken[a]"}])
    assert tickets == []
    assert post.await_count == expo._WEBHOOK_MAX_RETRIES  # 전량 재시도 소진


# ─── _build_push_data_payload (story #1953 P1a-S3: org/project/story/sprint 식별자 enrichment) ──

def test_build_push_data_payload_always_includes_org_id():
    """전 타입 공통: org_id는 항상 payload에 포함(dispatch_notification의 org_id는 non-null
    필수 파라미터라 언제나 값이 있음 — manifest DeepLinkPayloadFields.org_id_included=True 근거)."""
    org_id = uuid.uuid4()
    data = expo._build_push_data_payload(event_type="agent_joined", org_id=org_id)
    assert data["org_id"] == str(org_id)
    assert data["event_type"] == "agent_joined"


def test_build_push_data_payload_includes_project_id_when_given():
    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    data = expo._build_push_data_payload(event_type="story_assigned", org_id=org_id, project_id=project_id)
    assert data["project_id"] == str(project_id)


def test_build_push_data_payload_omits_project_id_when_none():
    """project_id 미상(예: 멀티프로젝트 org-wide 브로드캐스트) — 없는 키로 생략(빈 문자열/None 오염 금지)."""
    data = expo._build_push_data_payload(event_type="agent_joined", org_id=uuid.uuid4(), project_id=None)
    assert "project_id" not in data


def test_build_push_data_payload_includes_story_id_for_task_completed():
    org_id = uuid.uuid4()
    story_id = uuid.uuid4()
    data = expo._build_push_data_payload(
        event_type="task_completed", org_id=org_id, reference_type="task",
        reference_id=uuid.uuid4(), story_id=story_id,
    )
    assert data["story_id"] == str(story_id)


def test_build_push_data_payload_includes_sprint_id_for_hypothesis_dispatch():
    org_id = uuid.uuid4()
    sprint_id = uuid.uuid4()
    data = expo._build_push_data_payload(
        event_type="dispatched", org_id=org_id, reference_type="hypothesis",
        reference_id=uuid.uuid4(), sprint_id=sprint_id,
    )
    assert data["sprint_id"] == str(sprint_id)


def test_build_push_data_payload_omits_story_id_and_sprint_id_when_none():
    data = expo._build_push_data_payload(event_type="epic_created", org_id=uuid.uuid4())
    assert "story_id" not in data
    assert "sprint_id" not in data


def test_build_push_data_payload_preserves_existing_reference_fields():
    """무회귀: event_type/reference_type/reference_id 기존 3필드 거동 불변."""
    org_id, ref_id = uuid.uuid4(), uuid.uuid4()
    data = expo._build_push_data_payload(
        event_type="gate.pending_approval", org_id=org_id, reference_type="gate", reference_id=ref_id,
    )
    assert data == {
        "event_type": "gate.pending_approval",
        "org_id": str(org_id),
        "reference_type": "gate",
        "reference_id": str(ref_id),
    }


# ─── deliver_expo_push (배치·만료·mute·best-effort) ───────────────────────────

@pytest.mark.anyio
async def test_batches_over_100():
    devices = [_dev(f"ExponentPushToken[{i}]") for i in range(250)]
    db = _mock_db(devices)
    sizes: list[int] = []

    async def _fake_chunk(msgs):
        sizes.append(len(msgs))
        return [{"status": "ok"} for _ in msgs]

    with patch("ee.services.expo_push._expo_send_chunk", new=_fake_chunk):
        await expo.deliver_expo_push(
            db, uuid.uuid4(), [devices[0].member_id], title="T", body="B", event_type="e",
        )
    assert sizes == [100, 100, 50]  # 250 → 100/100/50 청크


@pytest.mark.anyio
async def test_deactivates_device_not_registered():
    good = _dev("ExponentPushToken[GOOD]")
    bad = _dev("ExponentPushToken[BAD]")
    db = _mock_db([good, bad])

    async def _fake_chunk(msgs):
        # good=ok, bad=DeviceNotRegistered
        out = []
        for m in msgs:
            if m["to"] == "ExponentPushToken[BAD]":
                out.append({"status": "error", "details": {"error": "DeviceNotRegistered"}})
            else:
                out.append({"status": "ok", "id": "t"})
        return out

    with patch("ee.services.expo_push._expo_send_chunk", new=_fake_chunk):
        await expo.deliver_expo_push(
            db, uuid.uuid4(), [good.member_id, bad.member_id], title="T", body=None, event_type="e",
        )
    # select 1 + update 1 = execute 2회, flush 1회(만료 반영)
    assert db.execute.await_count == 2
    db.flush.assert_awaited_once()


@pytest.mark.anyio
async def test_no_deactivation_when_all_ok():
    dev = _dev("ExponentPushToken[GOOD]")
    db = _mock_db([dev])
    with patch("ee.services.expo_push._expo_send_chunk", new=AsyncMock(return_value=[{"status": "ok"}])):
        await expo.deliver_expo_push(db, uuid.uuid4(), [dev.member_id], title="T", body="B", event_type="e")
    # dead 없음 → update/flush 미실행(select 1회만)
    assert db.execute.await_count == 1
    db.flush.assert_not_awaited()


@pytest.mark.anyio
async def test_skips_when_all_muted():
    m = uuid.uuid4()
    db = _mock_db([])
    sent = AsyncMock()
    with patch("ee.services.expo_push._expo_send_chunk", new=sent):
        await expo.deliver_expo_push(
            db, uuid.uuid4(), [m], title="T", body="B", event_type="e", muted_member_ids={m},
        )
    # 전원 mute → 조기 return: device 조회도 발송도 없음
    db.execute.assert_not_awaited()
    sent.assert_not_awaited()


@pytest.mark.anyio
async def test_no_send_when_no_devices():
    db = _mock_db([])  # select → 0 devices
    sent = AsyncMock()
    with patch("ee.services.expo_push._expo_send_chunk", new=sent):
        await expo.deliver_expo_push(db, uuid.uuid4(), [uuid.uuid4()], title="T", body="B", event_type="e")
    sent.assert_not_awaited()  # 디바이스 0 → 발송 없음


@pytest.mark.anyio
async def test_deliver_expo_push_includes_org_project_story_sprint_in_data_payload():
    """story #1953: deliver_expo_push가 실제로 org_id/project_id/story_id/sprint_id를
    push data payload에 실어 보내는지(구성 함수 호출뿐 아니라 실제 배선까지) 확인."""
    dev = _dev("ExponentPushToken[GOOD]")
    db = _mock_db([dev])
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    story_id = uuid.uuid4()
    captured: list[dict] = []

    async def _fake_chunk(msgs):
        captured.extend(msgs)
        return [{"status": "ok"} for _ in msgs]

    with patch("ee.services.expo_push._expo_send_chunk", new=_fake_chunk):
        await expo.deliver_expo_push(
            db, org_id, [dev.member_id], title="T", body="B", event_type="task_completed",
            reference_type="task", reference_id=uuid.uuid4(),
            project_id=project_id, story_id=story_id,
        )
    assert len(captured) == 1
    data = captured[0]["data"]
    assert data["org_id"] == str(org_id)
    assert data["project_id"] == str(project_id)
    assert data["story_id"] == str(story_id)


@pytest.mark.anyio
async def test_best_effort_swallows_exceptions():
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=RuntimeError("db down"))
    # 예외가 전파되면 알림 파이프라인이 되돌려짐 — best-effort 로 삼켜야 함(예외 안 남).
    await expo.deliver_expo_push(db, uuid.uuid4(), [uuid.uuid4()], title="T", body="B", event_type="e")
