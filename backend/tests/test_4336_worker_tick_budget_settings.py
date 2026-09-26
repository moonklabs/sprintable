"""story #4336(PO 04:52Z) — 발행 명령 워커 틱 예산의 입력이 실제 배포 값과 어긋나지 않게 고정한다.

- 스케줄러 시한 설정 기본값 = infra/cloud-scheduler/jobs.json publication-commands.attempt_deadline(둘 중 하나만 바뀌면 RED).
- 요청 시한 env = cloudbuild deploy-backend의 `--timeout`과 같은 `_BACKEND_TIMEOUT`에서 나온다(다른 값을 넣으면 RED).
- 틱 예산 = min(두 시한) − 여유 — 요청 시한 300이면 240(스케줄러 시한 1800이 헛말이 되지 않는다).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]


def _job(name: str) -> dict:
    data = json.loads((_ROOT / "infra/cloud-scheduler/jobs.json").read_text())
    return next(j for j in data["jobs"] if j["name"] == name)


def test_scheduler_deadline_setting_matches_the_publication_commands_job():
    from app.core.config import Settings

    deadline = _job("publication-commands")["attempt_deadline"]
    assert deadline.endswith("s")
    assert Settings.model_fields["publication_worker_scheduler_deadline_seconds"].default == int(deadline[:-1])


def test_request_timeout_env_comes_from_the_same_value_as_cloud_run_timeout():
    text = (_ROOT / "cloudbuild.yaml").read_text()
    assert "--timeout=${_BACKEND_TIMEOUT}" in text
    assert re.search(r"BACKEND_REQUEST_TIMEOUT_SECONDS=\$\{_BACKEND_TIMEOUT\}", text)


def test_prod_backend_timeout_fits_the_scheduler_deadline():
    """PO 04:52Z 결정 1 — 승격 쪽 요청 시한이 스케줄러 시한보다 짧으면 Cloud Run이 틱 중간에 끊는다."""
    text = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    values = [int(v) for v in re.findall(r'echo "backend_timeout=(\d+)"', text)]
    deadline = int(_job("publication-commands")["attempt_deadline"][:-1])
    assert values and all(v >= deadline for v in values), values


def test_tick_budget_is_the_smaller_deadline_minus_the_margin(monkeypatch):
    from app.core.config import settings
    from app.services import publication_command as svc

    monkeypatch.setattr(settings, "publication_worker_scheduler_deadline_seconds", 1800)
    monkeypatch.setattr(settings, "backend_request_timeout_seconds", 300)
    assert svc.worker_tick_budget_seconds() == 300 - svc.TICK_MARGIN_SECONDS
    monkeypatch.setattr(settings, "backend_request_timeout_seconds", 3600)
    assert svc.worker_tick_budget_seconds() == 1800 - svc.TICK_MARGIN_SECONDS


class _FakeDb:
    def __init__(self, objects):
        self._objects = objects

    async def get(self, model, _id):
        return self._objects.get(model.__name__)


def _command(**kw):
    from types import SimpleNamespace
    import uuid

    return SimpleNamespace(
        content_kind="channel_post", operation="publish", destination=uuid.uuid4(), approved_version=uuid.uuid4(), **kw,
    )


import pytest  # noqa: E402


@pytest.mark.anyio
@pytest.mark.parametrize("channel, thread, expected_extra", [
    ("x", [], 0),                      # X 단일 글 — 채널 최대(10조각)가 아니라 실제 조각 수로
    ("x", ["b", "c"], 2 * 2 * 20),     # 헤드 뒤 두 조각 — 조각마다 호출 둘 × 20초
    ("x", ["s"] * 30, 10 * 2 * 20),    # 채널 최대를 넘는 값은 채널 최대로 자른다
    ("threads", [], 0),
])
async def test_worst_case_counts_the_approved_versions_thread_segments(channel, thread, expected_extra):
    """4336 회귀 실측 — 예전엔 X 명령을 늘 최대 스레드(80 + 10×2×20 = 480초)로 잡아 요청 시한 300(예산 240)인 환경에서 단일 글도
    못 집혔다. 뮤테이션: 조각 수를 `config.thread_max_segments`로 되돌리면 X 단일 글 칸이 RED."""
    from types import SimpleNamespace

    from app.services import publication_command as svc

    db = _FakeDb({
        "ChannelConnection": SimpleNamespace(channel=channel),
        "ChannelPostVersion": SimpleNamespace(channel_payload={"thread": thread}),
    })
    assert await svc.command_worst_case_seconds(db, _command()) == svc.DEFAULT_COMMAND_WORST_SECONDS + expected_extra


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_youtube_worst_case_adds_the_upload_cap():
    from types import SimpleNamespace

    from app.services import publication_command as svc
    from app.services.youtube_publish import YOUTUBE_UPLOAD_MAX_SECONDS

    db = _FakeDb({
        "ChannelConnection": SimpleNamespace(channel="youtube"),
        "ChannelPostVersion": SimpleNamespace(channel_payload={}),
    })
    assert await svc.command_worst_case_seconds(db, _command()) == svc.DEFAULT_COMMAND_WORST_SECONDS + YOUTUBE_UPLOAD_MAX_SECONDS


@pytest.mark.anyio
@pytest.mark.parametrize("text, expected_sleeps", [
    ("느린 발행 [sandbox:publish-slow]", [90]),
    ("보통 발행", []),
])
async def test_sandbox_publish_slow_marker_waits_90_seconds_only_when_present(monkeypatch, text, expected_sleeps):
    """AC5(PO 08:03Z) — dev 라이브용 «긴 발행» 대상: 마커가 있으면 공급자 호출(create_container)이 90초를 기다리고, 없으면 곧바로.
    뮤테이션: 기다림을 빼면 첫 칸이 RED."""
    from app.services import sandbox_publish

    sleeps: list[float] = []

    async def _sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(sandbox_publish.asyncio, "sleep", _sleep)
    creation_id = await sandbox_publish.create_container(None, access_token="t", threads_user_id="u", text=text)
    assert sleeps == expected_sleeps
    assert creation_id  # 기다린 뒤엔 평소대로 진행


def test_publish_slow_marker_is_longer_than_the_bff_and_fits_the_dev_tick_budget(monkeypatch):
    """90초는 BFF 상한(55초)보다 길어 «요청 안이면 끊겼을» 발행이고, dev 틱 예산(스케줄러 시한 1800 · dev 요청 시한 3600 → 1740초)
    안이라 워커가 한 틱에 끝낸다(PO 08:03Z — 숫자로)."""
    import re

    from app.core.config import settings
    from app.services import publication_command as svc
    from app.services.sandbox_publish import _PUBLISH_SLOW_SECONDS

    dev_timeout = int(re.search(r"_BACKEND_TIMEOUT: '(\d+)'", (_ROOT / "cloudbuild.yaml").read_text()).group(1))
    monkeypatch.setattr(settings, "backend_request_timeout_seconds", dev_timeout)
    monkeypatch.setattr(settings, "publication_worker_scheduler_deadline_seconds", 1800)
    assert dev_timeout == 3600
    assert svc.worker_tick_budget_seconds() == 1740
    assert 55 < _PUBLISH_SLOW_SECONDS < svc.worker_tick_budget_seconds()


@pytest.mark.anyio
async def test_publish_slow_marker_is_inert_on_a_real_channel(monkeypatch):
    """PO 08:04Z(까디르 M12) — 마커는 sandbox 클라이언트만 읽는다: 실 채널(threads)은 발행 클라이언트가 sandbox가 아니고, 같은 마커가
    본문에 있어도 기다림 없이 곧바로 HTTP를 보낸다(전송층 목). 실 연결에서 90초 지연이 켜지는 길 0.
    뮤테이션: 마커 확인을 공용 자리(발행 오케스트레이션)로 옮기면 기다림이 기록돼 RED."""
    import asyncio

    import httpx

    from app.services import sandbox_publish
    from app.services.channel_adapters import get_publish_client_module

    module = get_publish_client_module("threads")
    assert module is not sandbox_publish
    sleeps: list[float] = []
    real_sleep = asyncio.sleep

    async def _sleep(seconds, *a, **k):
        sleeps.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    requests: list[str] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, json={"id": "creation-real"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as client:
        creation_id = await module.create_container(
            client, access_token="t", threads_user_id="u", text="실 채널 본문 [sandbox:publish-slow]",
        )
    assert creation_id == "creation-real"
    assert len(requests) == 1 and 90 not in sleeps
