"""story #4404 — Stibee 429 Retry-After is honoured up to a cap; a longer one gives up this round (transient) instead of
holding the publication worker for as long as the server says. Missing, negative or unreadable values wait 1 s."""
import httpx
import pytest

from app.services import stibee_client
from app.services.stibee_client import RETRY_AFTER_CAP_SECONDS, StibeeApiError, fetch_send_result


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(retry_after: str | None):
    state = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["n"] += 1
        if state["n"] == 1:
            headers = {"Retry-After": retry_after} if retry_after is not None else {}
            return httpx.Response(429, headers=headers, json={"code": "rate"})
        return httpx.Response(200, json={"Value": []})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def sleeps(monkeypatch):
    recorded: list[float] = []

    async def fake_sleep(seconds):
        recorded.append(seconds)

    monkeypatch.setattr("asyncio.sleep", fake_sleep)
    return recorded


@pytest.mark.anyio
async def test_a_retry_after_above_the_cap_gives_up_this_round_without_sleeping(sleeps):
    async with _client("3600") as client:
        with pytest.raises(StibeeApiError) as exc:
            await fetch_send_result(client, api_key="k", email_id=1)
    assert exc.value.status_code == 429  # → CHANNEL_RATE_LIMITED: retried on a later tick
    assert sleeps == []


@pytest.mark.anyio
@pytest.mark.parametrize(("header", "expected"), [("5", 5.0), (None, 1.0), ("-3", 1.0), ("soon", 1.0), ("60", 60.0)])
async def test_a_retry_after_within_the_cap_is_honoured(sleeps, header, expected):
    async with _client(header) as client:
        await fetch_send_result(client, api_key="k", email_id=1)
    assert sleeps == [expected]


def test_an_http_date_is_read_as_seconds():
    from email.utils import format_datetime
    from datetime import UTC, datetime, timedelta

    when = format_datetime(datetime.now(UTC) + timedelta(seconds=30), usegmt=True)
    assert 25 <= stibee_client._retry_after_seconds(when) <= 31


def test_the_cap_is_sixty_seconds():
    assert RETRY_AFTER_CAP_SECONDS == 60.0
